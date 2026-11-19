/** rif report: reports/results.json and reports/RESULTS.md from what the runs wrote. Every number
 * here is computed from files under reports/ (and the world, for scoring); nothing is typed in. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryCfg } from "@rif/factory";
import { ROOT } from "@rif/ingest";
import { type World, buildWorld, impactTruth, revisions } from "@rif/world";
import { type DayScore, type ImpactScore, scoreImpact } from "./evaluate.js";
import type { HeldoutResult } from "./heldout.js";
import { heldoutWorld } from "./impact-run.js";

const read = <T>(p: string): T | null =>
  existsSync(join(ROOT, p)) ? (JSON.parse(readFileSync(join(ROOT, p), "utf8")) as T) : null;
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const usd = (x: number) => `$${x.toFixed(2)}`;
const pr = (x: { tp: number; fp: number; fn: number }) => ({
  precision: x.tp + x.fp ? x.tp / (x.tp + x.fp) : 1,
  recall: x.tp + x.fn ? x.tp / (x.tp + x.fn) : 1,
});

type Incident = {
  id: string;
  source: string;
  day: number;
  status: string;
  cost_usd: string | number;
  seconds: number;
  resolved_day: number | null;
  record: { attempts?: unknown[] } | null;
};

function worldStats(w: World) {
  const t = revisions(w).map((r) => impactTruth(w, r.ref, r.version));
  const ch = t.flatMap((x) => x.changes);
  return {
    documents: w.docs.length,
    requirements: w.company.requirements.length,
    revisions: t.length,
    changes: ch.length,
    substantive: ch.filter((c) => c.substantive).length,
    affected: ch.reduce((n, c) => n + c.affected.length, 0),
    gaps: ch.reduce((n, c) => n + c.gaps.length, 0),
    drifts: w.sources.reduce((n, s) => n + s.drifts.length, 0),
    unlinked_requirements: w.company.requirements.filter((r) => !r.trace).length,
  };
}

export function writeReport() {
  const w = buildWorld();
  const cfg = factoryCfg();
  const hours = cfg.escalation.human_hours_per_incident;
  const season: Record<string, unknown>[] = [];
  for (const s of cfg.setups) {
    const days = read<DayScore[]>(`reports/season/${s.name}/days.json`);
    const inc = read<Incident[]>(`reports/season/${s.name}/incidents.json`);
    if (!days || !inc) continue;
    const sum = (k: keyof DayScore) => days.reduce((n, d) => n + (d[k] as number), 0);
    const restore = inc.map((i) => (i.resolved_day ?? w.cfg.days) - i.day);
    const cf = read<{ first_attempt: { correct: number; wrong: number; missing: number; stale: number } }[]>(
      `reports/season/${s.name}/counterfactual.json`,
    );
    season.push({
      setup: s.name,
      model: s.model,
      incidents: inc.length,
      deployed_by_agent: inc.filter((i) => i.status === "deployed").length,
      fixed_by_person: inc.filter((i) => i.status === "fixed_by_person").length,
      still_open: inc.filter((i) => ["open", "repairing", "escalated"].includes(i.status)).length,
      agent_cost_usd: inc.reduce((n, i) => n + Number(i.cost_usd), 0),
      agent_minutes_mean: inc.length ? inc.reduce((n, i) => n + i.seconds, 0) / inc.length / 60 : 0,
      days_to_restore_mean: restore.length ? restore.reduce((a, b) => a + b, 0) / restore.length : 0,
      days_to_restore_max: restore.length ? Math.max(...restore) : 0,
      person_hours: inc.filter((i) => i.status !== "deployed").length * hours,
      doc_days: {
        correct: sum("correct"),
        stale: sum("stale"),
        wrong: sum("wrong"),
        missing: sum("missing"),
        phantom: sum("phantom"),
      },
      ungated_first_attempts: cf
        ? {
            replayed: cf.length,
            exact: cf.filter(
              (c) => c.first_attempt.wrong + c.first_attempt.missing + c.first_attempt.stale === 0,
            ).length,
            wrong_doc_days: cf.reduce((n, c) => n + c.first_attempt.wrong, 0),
          }
        : null,
    });
  }

  const heldout: Record<string, unknown>[] = [];
  for (const s of cfg.setups) {
    const j = read<{ at: string; results: HeldoutResult[] }>(`reports/heldout/${s.name}/first_run.json`);
    if (!j) continue;
    const by = (kind: string) => j.results.filter((r) => r.kind === kind);
    const kinds = ["template_split", "withdraw", "silent_edit"];
    heldout.push({
      setup: s.name,
      at: j.at,
      right: j.results.filter((r) => r.right).length,
      total: j.results.length,
      by_kind: Object.fromEntries(
        kinds.map((k) => [k, { right: by(k).filter((r) => r.right).length, total: by(k).length }]),
      ),
      wrongly_deployed: j.results.filter((r) => r.decision === "deployed" && !r.right).length,
      cost_usd: j.results.reduce((n, r) => n + r.cost_usd, 0),
      ungated_first_attempts_exact: j.results.filter(
        (r) =>
          r.first_attempt &&
          r.first_attempt.wrong + r.first_attempt.missing === 0 &&
          r.first_attempt.days > 0,
      ).length,
      ungated_first_attempts_changed: j.results.filter((r) => r.first_attempt).length,
      results: j.results.map((r) => ({
        id: r.id,
        kind: r.kind,
        expect: r.expect,
        decision: r.decision,
        right: r.right,
        attempts: r.attempts,
        cost_usd: r.cost_usd,
        first_attempt: r.first_attempt,
        reason: r.reason,
      })),
    });
  }

  const impactOf = (world: World, dir: string) => {
    const out: Record<string, ImpactScore & { precision: number; recall: number; gap_recall: number }> = {};
    for (const m of ["links", "retrieval", "rules", "model-sonnet", "raw-sonnet", "model-haiku"]) {
      const list = read<Parameters<typeof scoreImpact>[1]>(`${dir}/${m}.json`);
      if (!list) continue;
      const s = scoreImpact(world, list);
      out[m] = { ...s, ...pr(s.affected), gap_recall: pr(s.gaps).recall };
    }
    return out;
  };
  const results = {
    generated_at: new Date().toISOString(),
    world: worldStats(w),
    heldout_world: worldStats(heldoutWorld()),
    season,
    heldout_incidents: heldout,
    impact: {
      season_world: impactOf(w, "reports/impact/sonnet-gated"),
      heldout_world_first_run: impactOf(heldoutWorld(), "reports/heldout/impact"),
    },
    compliance: {
      season_world: read("reports/compliance/season.json"),
      heldout_world_first_run: read("reports/compliance/heldout-first-run.json"),
    },
  };
  writeFileSync(join(ROOT, "reports", "results.json"), `${JSON.stringify(results, null, 1)}\n`);
  writeFileSync(join(ROOT, "reports", "RESULTS.md"), markdown(results));
  console.log("wrote reports/results.json and reports/RESULTS.md");
}

// biome-ignore lint/suspicious/noExplicitAny: the report reads its own JSON back
function markdown(r: any): string {
  const L: string[] = [
    "# Results",
    "",
    `Generated by \`rif report\` on ${r.generated_at.slice(0, 10)} from the files under \`reports/\`. Do not edit by hand.`,
    "",
  ];
  const w = r.world;
  L.push(
    "## The world",
    "",
    `Five simulated regulator sites, ${w.documents} documents, ${w.revisions} revisions over a 120-day season (${w.changes} clause changes, ${w.substantive} of them substantive), ${w.drifts} layout drifts covering all eight kinds. One device maker with ${w.requirements} requirements, ${w.unlinked_requirements} of them without a recorded trace link. The held-out world is another draw: ${r.heldout_world.documents} documents, ${r.heldout_world.revisions} revisions, ${r.heldout_world.requirements} requirements.`,
    "",
    "## Season: keeping five scrapers alive",
    "",
    "| Setup | Incidents | Fixed by the agent | Fixed by a person | Days to restore (mean / max) | Person-hours | Agent cost | Wrong doc-days | Stale doc-days |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const s of r.season)
    L.push(
      `| ${s.setup} | ${s.incidents} | ${s.deployed_by_agent} | ${s.fixed_by_person} | ${s.days_to_restore_mean.toFixed(1)} / ${s.days_to_restore_max} | ${s.person_hours} | ${usd(s.agent_cost_usd)} | ${s.doc_days.wrong} | ${s.doc_days.stale} |`,
    );
  L.push("");
  for (const s of r.season)
    if (s.ungated_first_attempts)
      L.push(
        `- ${s.setup}: replayed ungated against the truth, ${s.ungated_first_attempts.exact} of ${s.ungated_first_attempts.replayed} first attempts were exact (${s.ungated_first_attempts.wrong_doc_days} wrong doc-days).`,
      );
  L.push("", "## Held-out incidents (first run, never rewritten)", "");
  L.push(
    "| Setup | Right | Layout split (deploy) | Withdrawn documents (escalate) | Clause corrected in place (escalate) | Wrongly deployed | Cost |",
    "|---|---|---|---|---|---|---|",
  );
  for (const h of r.heldout_incidents) {
    const k = (x: string) => `${h.by_kind[x].right} / ${h.by_kind[x].total}`;
    L.push(
      `| ${h.setup} | ${h.right} / ${h.total} | ${k("template_split")} | ${k("withdraw")} | ${k("silent_edit")} | ${h.wrongly_deployed} | ${usd(h.cost_usd)} |`,
    );
  }
  L.push("");
  for (const h of r.heldout_incidents)
    if (h.ungated_first_attempts_changed)
      L.push(
        `- ${h.setup}: of ${h.ungated_first_attempts_changed} first attempts that changed the scraper, ${h.ungated_first_attempts_exact} would have been exact if deployed ungated.`,
      );
  const imp = (
    title: string,
    m: Record<string, ImpactScore & { precision: number; recall: number; gap_recall: number }>,
  ) => {
    L.push("", `## Change impact: ${title}`, "");
    L.push(
      "| Matcher | Changes classified right | Affected requirements: precision | recall | Gaps found | Trace-link proposals right | Left for the expert | Picks the verifier dropped | Cost |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const [k, s] of Object.entries(m))
      L.push(
        `| ${k} | ${pct(s.changes.classified_right, s.changes.truth)} | ${s.precision.toFixed(2)} | ${s.recall.toFixed(2)} | ${s.gaps.tp} / ${s.gaps.tp + s.gaps.fn} | ${s.relinks.right} / ${s.relinks.proposed} | ${s.flags} | ${s.rejected} | ${usd(s.cost_usd)} |`,
      );
  };
  imp("the season world (where the rules were tuned)", r.impact.season_world);
  imp("the held-out world (first run)", r.impact.heldout_world_first_run);
  // biome-ignore lint/suspicious/noExplicitAny: the report reads its own JSON back
  const comp = (title: string, c: any) => {
    if (!c) return;
    L.push("", `## SOP compliance: ${title}`, "");
    L.push(
      "| Design | Right before review | Reviewed by the expert | Reused rulings | Wrong in the final report | of which wrongly 'met' | contradictions missed | met but called a gap | Expert minutes (manual) |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    for (const x of [...c.version1, ...c.version2])
      L.push(
        `| ${x.design} | ${x.raw.correct} / ${x.obligations} | ${x.reviewed} | ${x.byRuling} | ${x.obligations - x.final.correct} | ${x.final.falseCompliant} | ${x.final.missedConflicts} | ${x.final.falseGaps} | ${Math.round(x.minutes.tool)} (${x.minutes.manual}) |`,
      );
    const f = c.version1[2]?.formulation;
    if (f)
      L.push(
        "",
        `Formulation: ${f.requirements} requirements from the clauses in force; every one drawn from a single obligation; ${f.split} obligations split into two requirements (paraphrases the glossary does not join).`,
      );
  };
  comp("the season world (thresholds tuned here, on version 1)", r.compliance?.season_world);
  comp("the held-out world (first run)", r.compliance?.heldout_world_first_run);
  return `${L.join("\n")}\n`;
}
