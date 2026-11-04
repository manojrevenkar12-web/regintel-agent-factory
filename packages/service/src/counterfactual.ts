/** What the gates and the reviewer were worth: replay each repair's FIRST attempt, as if it had been
 * deployed with no gates and no review, on every day from its incident until that source's next
 * incident (or the season's end), and score the data it would have produced against the truth.
 * Evaluation only: it serves the world and reads its truth. Nothing here feeds a decision. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, crawl, httpFetch, loadScraper, materialize } from "@rif/ingest";
import { buildWorld, serveWorld } from "@rif/world";
import { scoreDocs } from "./evaluate.js";

type Incident = {
  id: string;
  source: string;
  day: number;
  status: string;
  record: { firstAttemptCode?: string; code?: string; firstAttemptSelfCheck?: boolean } | null;
};
export type Replay = {
  incident: string;
  source: string;
  days: number;
  self_check: boolean | null;
  first_attempt: { correct: number; wrong: number; missing: number; stale: number; failed_days: number };
  deployed: { correct: number; wrong: number; missing: number; stale: number; failed_days: number } | null;
};

export async function counterfactual(setup: string) {
  const w = buildWorld();
  const dir = join(ROOT, "reports", "season", setup);
  const incidents = JSON.parse(readFileSync(join(dir, "incidents.json"), "utf8")) as Incident[];
  const server = await serveWorld(w);
  const out: Replay[] = [];
  for (const inc of incidents) {
    const first = inc.record?.firstAttemptCode;
    if (!first) continue;
    const next = incidents.filter((x) => x.source === inc.source && x.day > inc.day).map((x) => x.day);
    const until = Math.min(w.cfg.days, ...next);
    const run = async (code: string, tag: string) => {
      const scraper = await loadScraper(
        materialize(code, join(ROOT, "work", "counterfactual", setup, inc.source, `${inc.day}-${tag}.ts`)),
      );
      const s = { correct: 0, wrong: 0, missing: 0, stale: 0, failed_days: 0 };
      for (let day = inc.day; day < until; day++) {
        server.setDay(day);
        const rec = new Map();
        const o = await crawl(
          inc.source,
          scraper,
          httpFetch(server.url, inc.source, rec),
          rec,
          w.date(day),
          null,
        );
        if (o.status === "maintenance") continue;
        if (o.status === "failed" && !o.data.docs.length) s.failed_days++;
        // ungated: whatever the scraper returned is what production would hold
        const d = scoreDocs(w, inc.source, day, o.data.docs);
        s.correct += d.correct;
        s.wrong += d.wrong + d.phantom;
        s.missing += d.missing;
        s.stale += d.stale;
      }
      return s;
    };
    const fa = await run(first, "first");
    const dep =
      inc.status === "deployed" && inc.record?.code && inc.record.code !== first
        ? await run(inc.record.code, "deployed")
        : null;
    out.push({
      incident: inc.id,
      source: inc.source,
      days: until - inc.day,
      self_check: inc.record?.firstAttemptSelfCheck ?? null,
      first_attempt: fa,
      deployed: dep,
    });
    console.log(`${inc.id}: first attempt over ${until - inc.day} days`, fa, dep ? { deployed: dep } : "");
  }
  await server.close();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "counterfactual.json"), `${JSON.stringify(out, null, 1)}\n`);
}
