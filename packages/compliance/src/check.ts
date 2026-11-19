/** The compliance check: which procedure should carry each requirement, which step carries it, and
 * whether the step meets it (covered), meets it in part (partial), contradicts it (conflict) or is not
 * there (missing). Then what an expert must look at: a finding is accepted unreviewed only when the
 * evidence is strong and explicit, and an expert's earlier ruling on the same step is reused. */
import { createHash } from "node:crypto";
import { Index, embed } from "@rif/impact";
import type { Requirement } from "./formulate.js";
import { type ComplianceCfg, type Step, readStep } from "./parse.js";

export type Verdict = "covered" | "partial" | "conflict" | "missing";
export type Procedure = { id: string; customer: string; device: string; title: string; steps: Step[] };
export type Finding = {
  requirement: string;
  procedure: string;
  verdict: Verdict;
  steps: string[]; // the steps that carry it: quoted to the expert
  quotes: string[];
  coverage: number; // share of the requirement's words in the best step
  found: { days: number | null; months: number | null };
  reasons: string[];
  route: "auto" | "review" | "ruling";
  by: string;
};

export function procedure(
  doc: { id: string; customer: string; device: string; title: string; steps: { id: string; text: string }[] },
  cfg: ComplianceCfg,
): Procedure {
  return { ...doc, steps: doc.steps.map((s) => readStep(s.id, s.text, cfg)) };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const coverage = (req: Requirement, s: Step) => {
  const t = new Set(s.terms);
  return req.terms.filter((x) => t.has(x)).length / Math.max(1, req.terms.length);
};

/** Each requirement goes to the device's procedure with the step that carries most of it; when none
 * carries enough, to the procedure whose text reads most like it (that is where the gap is). */
export function assign(
  reqs: Requirement[],
  procs: Procedure[],
  cfg: ComplianceCfg,
): Map<string, Requirement[]> {
  const out = new Map<string, Requirement[]>(procs.map((p) => [p.id, []]));
  const byDevice = new Map<string, Procedure[]>();
  for (const p of procs) byDevice.set(p.device, [...(byDevice.get(p.device) ?? []), p]);
  for (const r of reqs) {
    const mine = byDevice.get(r.device) ?? [];
    if (!mine.length) continue;
    let best: Procedure | null = null;
    let bestCov = 0;
    for (const p of mine)
      for (const s of p.steps) {
        if (s.otherParty || s.deferred) continue;
        const c = coverage(r, s);
        if (c > bestCov) {
          bestCov = c;
          best = p;
        }
      }
    if (!best || bestCov < cfg.check.min_coverage) {
      const idx = new Index(
        mine.map((p) => ({ id: p.id, text: `${p.title} ${p.steps.map((s) => s.text).join(" ")}` })),
      );
      const hit = idx.search(r.action)[0];
      best = mine.find((p) => p.id === hit?.id) ?? mine[0] ?? null;
    }
    if (best) out.get(best.id)?.push(r);
  }
  return out;
}

/** The rules checker: the best step by coverage of the requirement's words, its numbers (or those of a
 * later step that points back to it), and the words that weaken or defer it. */
export function checkRules(req: Requirement, p: Procedure, cfg: ComplianceCfg): Finding {
  const scored = p.steps
    .map((s) => ({ s, c: coverage(req, s) }))
    .sort((a, b) => b.c - a.c || a.s.id.localeCompare(b.s.id));
  const usable = scored.filter((x) => !x.s.otherParty && !x.s.deferred);
  const best = usable[0];
  const lookalike = scored.find((x) => (x.s.otherParty || x.s.deferred) && x.c >= cfg.check.min_coverage);
  const base = { requirement: req.id, procedure: p.id, by: "rules", route: "review" as Finding["route"] };
  if (!best || best.c < cfg.check.min_coverage) {
    return {
      ...base,
      verdict: "missing",
      steps: lookalike ? [lookalike.s.id] : [],
      quotes: lookalike ? [lookalike.s.text] : [],
      coverage: best?.c ?? 0,
      found: { days: null, months: null },
      reasons: [
        "no step carries the action",
        ...(lookalike
          ? [
              `${lookalike.s.id} mentions it but ${lookalike.s.otherParty ? "for another party" : "defers it"}`,
            ]
          : []),
      ],
    };
  }
  const pointer = p.steps.find((s) => s.pointsTo === best.s.id);
  const days = best.s.days ?? pointer?.days ?? null;
  const months = best.s.months ?? pointer?.months ?? null;
  const reasons: string[] = [];
  let verdict: Verdict = "covered";
  const conflict = (why: string) => {
    verdict = "conflict";
    reasons.push(why);
  };
  const partial = (why: string) => {
    if (verdict !== "conflict") verdict = "partial";
    reasons.push(why);
  };
  if (req.days !== null) {
    if (days === null) partial(`no deadline; required within ${plural(req.days, "day")}`);
    else if (days > req.days)
      conflict(
        `${plural(days, "day")} where ${plural(req.days, "day")} ${req.days === 1 ? "is" : "are"} required`,
      );
    else reasons.push(`${plural(days, "day")} meets ${plural(req.days, "day")}`);
  }
  if (req.months !== null) {
    if (months === null) partial(`no frequency; required at least every ${req.months} months`);
    else if (months > req.months) conflict(`every ${months} months where ${req.months} are required`);
    else reasons.push(`every ${months} months meets ${req.months}`);
  }
  if (best.s.weak) partial("weakened (where practicable, aims to, should)");
  const steps = pointer ? [best.s.id, pointer.id] : [best.s.id];
  return {
    ...base,
    verdict,
    steps,
    quotes: steps.map((id) => p.steps.find((s) => s.id === id)?.text ?? ""),
    coverage: best.c,
    found: { days, months },
    reasons,
  };
}

/** The keyword baseline: the top retrieval hit, covered above a score, missing below; no numbers. */
export function checkKeyword(req: Requirement, p: Procedure, cfg: ComplianceCfg): Finding {
  const idx = new Index(p.steps.map((s) => ({ id: s.id, text: s.text })));
  const hit = idx.search(req.action)[0];
  const ok = Boolean(hit && hit.score >= cfg.check.keyword_min_score && hit.bm25 > 0);
  const step = p.steps.find((s) => s.id === hit?.id);
  return {
    requirement: req.id,
    procedure: p.id,
    verdict: ok ? "covered" : "missing",
    steps: ok && step ? [step.id] : [],
    quotes: ok && step ? [step.text] : [],
    coverage: hit?.score ?? 0,
    found: { days: null, months: null },
    reasons: [ok ? "a step reads like it" : "no step reads like it"],
    route: "auto",
    by: "keyword",
  };
}

/** Accept unreviewed only what is strong and explicit; everything else goes to the expert. */
export function route(f: Finding, req: Requirement, cfg: ComplianceCfg): Finding["route"] {
  if (f.verdict === "covered") {
    const explicit =
      (req.days === null || f.found.days !== null) && (req.months === null || f.found.months !== null);
    return f.coverage >= cfg.check.auto_cover && explicit ? "auto" : "review";
  }
  if (f.verdict === "missing")
    return f.coverage < cfg.check.missing_auto && f.steps.length === 0 ? "auto" : "review";
  return "review";
}

// -- expert rulings: what an expert decided about a requirement and a step, reused when it comes back --

export type Ruling = {
  customer: string;
  requirement: string; // the requirement's identity: its action and numbers
  stepText: string; // the steps the expert's verdict rests on, word for word ('' when there are none)
  procedureHash: string; // the whole procedure as the expert saw it
  vector: number[]; // kept in pgvector to show the expert similar rulings, never to apply them
  found: { days: number | null; months: number | null };
  verdict: Verdict;
  by: string;
  note: string;
};

export const requirementKey = (r: Requirement) =>
  createHash("sha256")
    .update(`${r.terms.join(" ")}|${r.days}|${r.months}`)
    .digest("hex")
    .slice(0, 16);

export const procedureHash = (p: Procedure) =>
  createHash("sha256")
    .update(p.steps.map((s) => s.text).join("\n"))
    .digest("hex")
    .slice(0, 16);

/** An earlier ruling applies only to the same requirement and the very same words: the steps it rests
 * on still in the procedure, word for word, and the checker quoting nothing else; a ruling that rests
 * on no step (a confirmed gap) applies only to an unchanged procedure. A near match is never enough:
 * "where practicable" in front of an unchanged sentence changes the verdict (ADR 0006). */
export function ruled(f: Finding, req: Requirement, p: Procedure, rulings: Ruling[]): Ruling | null {
  const key = requirementKey(req);
  const quoted = f.quotes.join(" ");
  const texts = new Set(p.steps.map((s) => s.text));
  const hash = procedureHash(p);
  return (
    rulings.find((r) => {
      if (r.customer !== p.customer || r.requirement !== key) return false;
      if (!r.stepText) return r.procedureHash === hash;
      const parts = r.stepText.split("\u241e");
      return parts.every((t) => texts.has(t)) && (quoted === "" || parts.join(" ") === quoted);
    }) ?? null
  );
}

/** A finding with an earlier ruling applied: the expert's verdict, no review. */
export function applyRuling(f: Finding, r: Ruling): Finding {
  return {
    ...f,
    verdict: r.verdict,
    route: "ruling",
    reasons: [...f.reasons, `as ruled by ${r.by}: ${r.note}`],
  };
}

/** What an expert decided, kept for next time. `steps` are the step texts the expert's verdict rests on
 * (the checker's quotes when the expert agreed with them). */
export function rulingFrom(
  f: Finding,
  req: Requirement,
  p: Procedure,
  verdict: Verdict,
  by: string,
  note: string,
  steps: string[] = f.quotes,
): Ruling {
  const text = steps.join("\u241e");
  return {
    customer: p.customer,
    requirement: requirementKey(req),
    stepText: text,
    procedureHash: procedureHash(p),
    vector: embed(steps.join(" ")),
    found: f.found,
    verdict,
    by,
    note,
  };
}
