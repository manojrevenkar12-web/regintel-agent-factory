/** rif compliance: the SOP compliance check on the simulated customers' procedures, scored against the
 * world's truth, with an expert who reviews what the platform routes to them.
 *
 * Designs, all on the same procedures:
 *  - manual: an expert reads every requirement against the procedure, no tool
 *  - keyword: the top retrieval hit counts as covered, nothing reviewed
 *  - rules: the checker, with the review queue (an expert confirms or corrects routed findings)
 *  - rules + rulings (version 2 only): the expert's version-1 corrections reused on unchanged steps
 *
 * The platform sees clause texts, the device register and procedure texts. Only this file and the
 * world read the truth, to score. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Finding,
  type Procedure,
  type Requirement,
  type Ruling,
  applyRuling,
  assign,
  checkKeyword,
  checkRules,
  complianceCfg,
  formulate,
  procedure,
  readClause,
  route,
  ruled,
  rulingFrom,
} from "@rif/compliance";
import { ROOT } from "@rif/ingest";
import { type World, buildWorld, loadWorldCfg, render, sopWorld } from "@rif/world";

export const heldoutWorld = () => buildWorld(loadWorldCfg(join(ROOT, "config/heldout/world.yaml")));

/** What the platform is given: the clauses in force (as text), the device register, the procedures. */
export function inputs(w: World, version: number) {
  const cfg = complianceCfg();
  const clauses = w.docs
    .filter((d) => d.published <= 0)
    .flatMap((d) =>
      (d.versions[0]?.clauses ?? []).map((c) => readClause(d.ref, c.id, render(c.ob, c.wording), cfg)),
    )
    .filter((c) => c !== null);
  const devices = w.company.devices.map((d) => ({ id: d.id, name: d.name, class: d.class }));
  const sops = sopWorld(w, version);
  const procs = sops.docs.map((d) => procedure(d, cfg));
  return { cfg, clauses, devices, procs, docs: sops.docs, truth: sops.truth };
}

export type Checked = { requirement: Requirement; finding: Finding };

/** Formulate requirements, assign them to each customer's procedures, check them. */
export function check(w: World, version: number, design: "keyword" | "rules", rulings: Ruling[] = []) {
  const { cfg, clauses, devices, procs } = inputs(w, version);
  const reqs = devices.flatMap((d) => formulate(clauses, d, w.company.name, cfg));
  const out: Checked[] = [];
  const customers = [...new Set(procs.map((p) => p.customer))];
  for (const c of customers) {
    const mine = procs.filter((p) => p.customer === c);
    const assigned = assign(reqs, mine, cfg);
    for (const p of mine)
      for (const r of assigned.get(p.id) ?? []) {
        if (design === "keyword") {
          out.push({ requirement: r, finding: checkKeyword(r, p, cfg) });
          continue;
        }
        let f = checkRules(r, p, cfg);
        f.route = route(f, r, cfg);
        const hit = rulings.length ? ruled(f, r, p, rulings) : null;
        if (hit) f = applyRuling(f, hit);
        out.push({ requirement: r, finding: f });
      }
  }
  return { reqs, out, procs };
}

type Truth = ReturnType<typeof inputs>["truth"][number];

/** Which truth obligation a platform requirement stands for: the (topic, action) of most of its clauses. */
function truthKeyOf(w: World, r: Requirement): string | null {
  const votes = new Map<string, number>();
  for (const s of r.sources) {
    const d = w.docs.find((x) => x.ref === s.ref);
    const c = d?.versions[0]?.clauses.find((x) => x.id === s.clause);
    if (!c) continue;
    const k = `${c.ob.topic}:${c.ob.action}`;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export type Scored = {
  design: string;
  obligations: number;
  formulation: { requirements: number; pure: number; split: number; unformulated: number };
  assignedRight: number;
  raw: { correct: number; byVerdict: Record<string, { truth: number; right: number }> };
  reviewed: number;
  byRuling: number;
  final: { correct: number; falseCompliant: number; missedConflicts: number; falseGaps: number };
  minutes: { tool: number; manual: number };
  confusion: Record<string, Record<string, number>>;
};

/** Score a run; the simulated expert fixes every routed finding (to the truth) and leaves a ruling. */
export function score(
  w: World,
  version: number,
  design: string,
  checked: Checked[],
  procs: Procedure[],
  truth: Truth[],
  reviewAll = false,
): { scored: Scored; rulings: Ruling[]; rows: object[] } {
  const cfg = complianceCfg();
  const keyOf = new Map(checked.map((c) => [c.requirement.id, truthKeyOf(w, c.requirement)]));
  const reqs = [...new Map(checked.map((c) => [c.requirement.id, c.requirement])).values()];
  const pure = reqs.filter((r) => {
    const ks = new Set(
      r.sources.map((s) => {
        const d = w.docs.find((x) => x.ref === s.ref);
        const c = d?.versions[0]?.clauses.find((x) => x.id === s.clause);
        return c ? `${c.ob.topic}:${c.ob.action}` : "?";
      }),
    );
    return ks.size === 1;
  }).length;
  const topicOf = new Map(sopWorld(w, version).docs.map((d) => [d.id, d.topic]));
  const rulings: Ruling[] = [];
  const rows: object[] = [];
  const s: Scored = {
    design,
    obligations: truth.length,
    formulation: { requirements: reqs.length, pure, split: 0, unformulated: 0 },
    assignedRight: 0,
    raw: { correct: 0, byVerdict: {} },
    reviewed: 0,
    byRuling: 0,
    final: { correct: 0, falseCompliant: 0, missedConflicts: 0, falseGaps: 0 },
    minutes: { tool: 0, manual: truth.length * cfg.review.manual_per_obligation },
    confusion: {},
  };
  const splitSeen = new Set<string>();
  for (const t of truth) {
    const [customer, device, topic, action] = t.key.split(":");
    const mine = checked.filter(
      (c) =>
        c.requirement.device === device &&
        keyOf.get(c.requirement.id) === `${topic}:${action}` &&
        procs.find((p) => p.id === c.finding.procedure)?.customer === customer,
    );
    const reqIds = new Set(mine.map((m) => m.requirement.id));
    if (reqIds.size > 1 && !splitSeen.has(`${device}:${topic}:${action}`)) {
      splitSeen.add(`${device}:${topic}:${action}`);
      s.formulation.split++;
    }
    const pick = mine.sort((a, b) => b.requirement.sources.length - a.requirement.sources.length)[0];
    const bv = s.raw.byVerdict[t.verdict] ?? { truth: 0, right: 0 };
    s.raw.byVerdict[t.verdict] = bv;
    bv.truth++;
    if (!pick) {
      s.formulation.unformulated++;
      s.minutes.tool += cfg.review.manual_per_obligation; // the expert finds it by hand
      s.final.correct++;
      continue;
    }
    const f = pick.finding;
    const proc = procs.find((p) => p.id === f.procedure) as Procedure;
    if (topicOf.get(proc.id) === topic) s.assignedRight++;
    const rawRight = f.verdict === t.verdict;
    if (rawRight) {
      s.raw.correct++;
      bv.right++;
    }
    const row = s.confusion[t.verdict] ?? {};
    s.confusion[t.verdict] = row;
    row[f.verdict] = (row[f.verdict] ?? 0) + 1;
    let final = f.verdict;
    const routed = reviewAll || f.route === "review";
    if (f.route === "ruling") s.byRuling++;
    if (routed) {
      s.reviewed++;
      s.minutes.tool += rawRight ? cfg.review.confirm : cfg.review.correct;
      final = t.verdict;
      // the expert points at the steps that carry it (none for a gap)
      const steps = t.steps.map((id) => proc.steps.find((x) => x.id === id)?.text ?? "").filter(Boolean);
      rulings.push(rulingFrom(f, pick.requirement, proc, t.verdict, "expert (simulated)", t.why, steps));
    }
    if (final === t.verdict) s.final.correct++;
    if (final === "covered" && t.verdict !== "covered") s.final.falseCompliant++;
    if (t.verdict === "conflict" && final !== "conflict") s.final.missedConflicts++;
    if (final === "missing" && t.verdict === "covered") s.final.falseGaps++;
    rows.push({
      key: t.key,
      truth: t.verdict,
      why: t.why,
      raw: f.verdict,
      final,
      route: f.route,
      steps: f.steps,
      truthSteps: t.steps,
      reasons: f.reasons,
    });
  }
  if (design === "manual") {
    // the expert reads every requirement against the procedure; they are assumed right, as in review
    s.minutes.tool = s.minutes.manual;
    s.raw.correct = s.obligations;
    for (const bv of Object.values(s.raw.byVerdict)) bv.right = bv.truth;
    s.reviewed = s.obligations;
    s.confusion = {};
  }
  return { scored: s, rulings, rows };
}

/** Every design on one world: version 1, then version 2 with and without the version-1 rulings. */
export function evaluate(w: World) {
  const v1 = sopWorld(w, 1).truth;
  const v2 = sopWorld(w, 2).truth;
  const kw = check(w, 1, "keyword");
  const r1 = check(w, 1, "rules");
  const keyword = score(w, 1, "keyword", kw.out, kw.procs, v1);
  const rules = score(w, 1, "rules", r1.out, r1.procs, v1);
  const manual = score(w, 1, "manual", r1.out, r1.procs, v1, true);
  const r2 = check(w, 2, "rules");
  const v2plain = score(w, 2, "rules (version 2)", r2.out, r2.procs, v2);
  const r2r = check(w, 2, "rules", rules.rulings);
  const v2ruled = score(w, 2, "rules + rulings (version 2)", r2r.out, r2r.procs, v2);
  return {
    version1: [manual.scored, keyword.scored, rules.scored],
    version2: [v2plain.scored, v2ruled.scored],
    rows: { rules: rules.rows, keyword: keyword.rows, v2ruled: v2ruled.rows },
  };
}

export function runCompliance(heldout: boolean) {
  const outDir = join(ROOT, "reports", "compliance");
  mkdirSync(outDir, { recursive: true });
  if (heldout) {
    const first = join(outDir, "heldout-first-run.json");
    const target = existsSync(first) ? join(outDir, "heldout-latest.json") : first;
    const r = evaluate(heldoutWorld());
    writeFileSync(target, `${JSON.stringify({ at: new Date().toISOString(), ...r }, null, 1)}\n`);
    print(r);
    console.log(
      `wrote ${target.replace(`${ROOT}/`, "")}${target === first ? " (first run: never rewritten)" : ""}`,
    );
    return;
  }
  const r = evaluate(buildWorld());
  writeFileSync(join(outDir, "season.json"), `${JSON.stringify(r, null, 1)}\n`);
  print(r);
}

function print(r: ReturnType<typeof evaluate>) {
  for (const s of [...r.version1, ...r.version2])
    console.log(
      `${s.design.padEnd(30)} raw ${s.raw.correct}/${s.obligations}  final ${s.final.correct}  false-compliant ${s.final.falseCompliant}  missed conflicts ${s.final.missedConflicts}  reviewed ${s.reviewed}  ruling ${s.byRuling}  minutes ${s.minutes.tool.toFixed(0)} of ${s.minutes.manual}`,
    );
}

export const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
