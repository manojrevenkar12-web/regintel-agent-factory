/** rif heldout --setup <name>: run the factory on the held-out incidents (config/heldout/incidents.yaml).
 *
 * Each incident gets its own copy of the world with one event in it. The scraper in production is
 * the correct one for the day before; the crawl on the incident day must fail its contract (or the
 * incident is reported as not reproduced). The factory then repairs exactly as in the season, and
 * the outcome is scored against the truth:
 *   expect deploy    right if a scraper was deployed and it is exact on every document for the next
 *                    ten days; the first attempt is replayed the same way (the ungated counterfactual)
 *   expect escalate  right if nothing was deployed; a deployed scraper is replayed to see what it did
 *
 * The first run per setup is written to reports/heldout/<setup>/first_run.json and FIRST_RUN.md and
 * never overwritten; later runs go to latest.json. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceCrawl, factoryCfg, repair } from "@rif/factory";
import { type CrawlData, ROOT, crawl, httpFetch, loadScraper, materialize } from "@rif/ingest";
import { type WorldEvent, buildWorld, layoutOf, referenceScraper, serveWorld } from "@rif/world";
import { parse } from "yaml";
import { scoreDocs } from "./evaluate.js";

type Spec = WorldEvent & { id: string; expect: "deploy" | "escalate" };
export type HeldoutResult = {
  id: string;
  kind: string;
  source: string;
  day: number;
  expect: "deploy" | "escalate";
  reproduced: boolean;
  findings: string[];
  decision: string | null;
  reason: string;
  right: boolean;
  attempts: number;
  cost_usd: number;
  seconds: number;
  first_attempt: { exact_days: number; days: number; wrong: number; missing: number } | null;
  deployed: { exact_days: number; days: number; wrong: number; missing: number } | null;
  claims: string[];
  reviews: (string | null)[];
};

const REPLAY_DAYS = 10;

export async function runHeldout(setupName: string, checkOnly = false) {
  const setup = factoryCfg().setups.find((s) => s.name === setupName);
  if (!setup) throw new Error(`no setup ${setupName}`);
  const specs = (
    parse(readFileSync(join(ROOT, "config/heldout/incidents.yaml"), "utf8")) as { incidents: Spec[] }
  ).incidents;
  const results: HeldoutResult[] = [];
  for (const spec of specs) {
    const w = buildWorld();
    const src = w.sources.find((s) => s.id === spec.source);
    if (!src) throw new Error(`no source ${spec.source}`);
    let day = spec.day;
    const quiet = (d: number) =>
      !src.maintenance.includes(d) &&
      !src.rateLimited.includes(d) &&
      !src.drifts.some((x) => x.day === d) &&
      JSON.stringify(layoutOf(src, d - 1)) === JSON.stringify(layoutOf(src, d + REPLAY_DAYS));
    while (!quiet(day)) day++;
    w.events = [{ ...spec, day }];
    const server = await serveWorld(w);
    const dir = join(ROOT, "work", "heldout", setup.name, spec.id);
    const before = referenceScraper(spec.source, src.ref_prefix, layoutOf(src, day - 1));
    const load = (code: string, tag: string) => loadScraper(materialize(code, join(dir, `${tag}.ts`)));
    const crawlOn = async (code: string, tag: string, d: number, prev: CrawlData | null) => {
      server.setDay(d);
      const rec = new Map();
      return crawl(
        spec.source,
        await load(code, tag),
        httpFetch(server.url, spec.source, rec),
        rec,
        w.date(d),
        prev,
      );
    };
    const good = await crawlOn(before, "before", day - 1, null);
    const o = await crawlOn(before, "before", day, good.data);
    const r: HeldoutResult = {
      id: spec.id,
      kind: spec.kind,
      source: spec.source,
      day,
      expect: spec.expect,
      reproduced: o.status === "failed",
      findings: o.findings.filter((f) => f.level === "error").map((f) => `${f.check}: ${f.detail}`),
      decision: null,
      reason: "",
      right: false,
      attempts: 0,
      cost_usd: 0,
      seconds: 0,
      first_attempt: null,
      deployed: null,
      claims: [],
      reviews: [],
    };
    if (r.reproduced && checkOnly) r.reason = "reproduced (check only)";
    else if (r.reproduced && (!setup.model || setup.model === "none")) {
      r.decision = "escalated";
      r.reason = "no agent in this setup: a person handles every incident";
      r.right = spec.expect === "escalate";
    } else if (r.reproduced) {
      server.setDay(day);
      const pages = await evidenceCrawl(server.url, spec.source);
      const rec = await repair(
        {
          id: `heldout-${spec.id}`,
          source: spec.source,
          day,
          today: w.date(day),
          findings: o.findings,
          lastGood: good.data,
          pages,
        },
        before,
        setup,
        dir,
      );
      // replay a scraper over the next days against the truth
      const replay = async (code: string, tag: string) => {
        const s = { exact_days: 0, days: 0, wrong: 0, missing: 0 };
        for (let d = day; d < Math.min(w.cfg.days, day + REPLAY_DAYS); d++) {
          const out = await crawlOn(code, tag, d, null);
          if (out.status === "maintenance") continue;
          const sc = scoreDocs(w, spec.source, d, out.data.docs);
          s.days++;
          s.wrong += sc.wrong + sc.phantom;
          s.missing += sc.missing + sc.stale;
          if (sc.wrong + sc.phantom + sc.missing + sc.stale === 0) s.exact_days++;
        }
        return s;
      };
      r.decision = rec.decision;
      r.reason = rec.reason;
      r.attempts = rec.attempts.length;
      r.cost_usd = rec.cost_usd;
      r.seconds = rec.seconds;
      r.claims = rec.attempts.map((a) => a.claim);
      r.reviews = rec.attempts.map((a) => a.review?.verdict ?? null);
      if (rec.firstAttemptCode !== before) r.first_attempt = await replay(rec.firstAttemptCode, "first");
      if (rec.code) r.deployed = await replay(rec.code, "deployed");
      r.right =
        spec.expect === "escalate"
          ? rec.decision === "escalated"
          : rec.decision === "deployed" && !!r.deployed && r.deployed.exact_days === r.deployed.days;
    }
    await server.close();
    results.push(r);
    console.log(
      `${spec.id}: ${r.reproduced ? `${r.decision} (${r.attempts} attempts, $${r.cost_usd.toFixed(2)}) ${r.right ? "RIGHT" : "WRONG"}` : "not reproduced"} - ${r.reason.slice(0, 120)}`,
    );
  }
  if (checkOnly) return;
  const out = join(ROOT, "reports", "heldout", setup.name);
  mkdirSync(out, { recursive: true });
  const first = join(out, "first_run.json");
  const target = existsSync(first) ? join(out, "latest.json") : first;
  writeFileSync(
    target,
    `${JSON.stringify({ setup: setup.name, at: new Date().toISOString(), results }, null, 1)}\n`,
  );
  if (target === first) writeFirstRun();
}

/** reports/heldout/FIRST_RUN.md from every setup's first_run.json. */
export function writeFirstRun() {
  const base = join(ROOT, "reports", "heldout");
  const md = [
    "# Held-out incidents: first runs",
    "",
    "Generated from `reports/heldout/<setup>/first_run.json`; those files are never rewritten.",
    "",
  ];
  for (const s of factoryCfg().setups) {
    const f = join(base, s.name, "first_run.json");
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as { at: string; results: HeldoutResult[] };
    const right = j.results.filter((r) => r.right).length;
    md.push(`## ${s.name} (${j.at.slice(0, 10)}): ${right} of ${j.results.length} right`, "");
    md.push(
      "| Incident | Expected | Decision | Attempts | Cost | Right | First attempt, ungated |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of j.results) {
      const fa = r.first_attempt
        ? `${r.first_attempt.exact_days}/${r.first_attempt.days} exact days, ${r.first_attempt.wrong} wrong doc-days`
        : "no change";
      md.push(
        `| ${r.id} | ${r.expect} | ${r.reproduced ? r.decision : "not reproduced"} | ${r.attempts} | $${r.cost_usd.toFixed(2)} | ${r.right ? "yes" : "no"} | ${fa} |`,
      );
    }
    md.push("");
  }
  writeFileSync(join(base, "FIRST_RUN.md"), `${md.join("\n")}\n`);
}
