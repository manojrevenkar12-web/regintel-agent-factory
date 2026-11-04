/** Scores what the platform believes against the world's truth. Evaluation only: nothing the
 * platform uses to decide reads this. */
import type { ScrapedDoc } from "@rif/ingest";
import { type World, clauseUid, impactTruth, render, shownAt } from "@rif/world";
import type { Store } from "./store.js";

export type DocScore = "correct" | "stale" | "wrong" | "missing";
export type DayScore = {
  day: number;
  source: string;
  correct: number;
  stale: number;
  wrong: number;
  missing: number;
  phantom: number;
};

/** A document version as the regulator published it. */
export function truthVersion(w: World, ref: string, version: number): ScrapedDoc | null {
  const d = w.docs.find((x) => x.ref === ref);
  const v = d?.versions.find((x) => x.version === version);
  if (!d || !v) return null;
  return {
    ref,
    title: d.title,
    version,
    published: w.date(v.day),
    effective: w.date(v.day + 30),
    clauses: v.clauses.map((c) => ({ id: c.id, text: render(c.ob, c.wording) })),
  };
}

const same = (a: ScrapedDoc, b: ScrapedDoc) =>
  a.ref === b.ref &&
  a.title === b.title &&
  a.version === b.version &&
  a.published === b.published &&
  a.effective === b.effective &&
  JSON.stringify(a.clauses) === JSON.stringify(b.clauses);

export function scoreDocs(w: World, source: string, day: number, platform: ScrapedDoc[]): DayScore {
  const truth = shownAt(w, source, day);
  const mine = new Map(platform.map((d) => [d.ref, d]));
  const s: DayScore = { day, source, correct: 0, stale: 0, wrong: 0, missing: 0, phantom: 0 };
  for (const t of truth) {
    const p = mine.get(t.ref);
    if (!p) s.missing++;
    else if (same(p, { ...t })) s.correct++;
    else {
      const old = p.version < t.version ? truthVersion(w, t.ref, p.version) : null;
      if (old && same(p, old)) s.stale++;
      else s.wrong++; // the platform holds data the regulator never published: silent corruption
    }
  }
  s.phantom = platform.filter((p) => !truth.some((t) => t.ref === p.ref)).length;
  return s;
}

export async function scoreDay(
  store: Store,
  w: World,
  setup: string,
  day: number,
  sources: readonly string[],
): Promise<DayScore[]> {
  const out: DayScore[] = [];
  for (const source of sources) {
    const lg = await store.lastGood(setup, source);
    out.push(scoreDocs(w, source, day, lg?.data.docs ?? []));
  }
  return out;
}

/** Scores change-impact assessments against the world's truth. Per version: were the changes
 * classified right, which affected requirements were found (and which were wrong), which gaps, and
 * whether each proposed trace-link change points the requirement at the clause it really comes from. */
export type ImpactScore = {
  versions: number;
  changes: { truth: number; classified_right: number; substantive_truth: number; substantive_found: number };
  affected: { tp: number; fp: number; fn: number };
  gaps: { tp: number; fp: number; fn: number };
  relinks: { proposed: number; right: number };
  flags: number;
  rejected: number;
  cost_usd: number;
  model_calls: number;
  errors: number;
};

type Assessed = {
  ref: string;
  version: number;
  from: number;
  changes: {
    before: { id: string } | null;
    after: { id: string } | null;
    verdict: string;
    affected: { requirement: string }[];
    gaps: { device: string }[];
    flags: string[];
  }[];
  relinks: { requirement: string; to: { ref: string; clause: string } | null }[];
  rejected: unknown[];
  cost_usd: number;
  model_calls: number;
  errors: string[];
};

export function scoreImpact(w: World, list: Assessed[]): ImpactScore {
  const s: ImpactScore = {
    versions: list.length,
    changes: { truth: 0, classified_right: 0, substantive_truth: 0, substantive_found: 0 },
    affected: { tp: 0, fp: 0, fn: 0 },
    gaps: { tp: 0, fp: 0, fn: 0 },
    relinks: { proposed: 0, right: 0 },
    flags: 0,
    rejected: 0,
    cost_usd: 0,
    model_calls: 0,
    errors: 0,
  };
  const uidOf = new Map(w.company.requirements.map((r) => [r.id, r.truth.uid]));
  for (const a of list) {
    const t = impactTruth(w, a.ref, a.version, a.from);
    for (const tc of t.changes) {
      s.changes.truth++;
      if (tc.substantive) s.changes.substantive_truth++;
      const p = a.changes.find(
        (c) => (c.before?.id ?? null) === tc.before && (c.after?.id ?? null) === tc.after,
      );
      const verdict = p?.verdict ?? "editorial"; // an unseen change was, in effect, called editorial
      if ((verdict === "substantive") === tc.substantive) s.changes.classified_right++;
      if (tc.substantive && verdict === "substantive") s.changes.substantive_found++;
    }
    const tAff = new Set(t.changes.flatMap((c) => c.affected));
    const pAff = new Set(
      a.changes
        .filter((c) => c.verdict === "substantive")
        .flatMap((c) => c.affected.map((x) => x.requirement)),
    );
    for (const r of pAff) tAff.has(r) ? s.affected.tp++ : s.affected.fp++;
    for (const r of tAff) if (!pAff.has(r)) s.affected.fn++;
    const tGap = new Set(t.changes.flatMap((c) => c.gaps.map((g) => `${c.after}:${g}`)));
    const pGap = new Set(a.changes.flatMap((c) => c.gaps.map((g) => `${c.after?.id}:${g.device}`)));
    for (const g of pGap) tGap.has(g) ? s.gaps.tp++ : s.gaps.fp++;
    for (const g of tGap) if (!pGap.has(g)) s.gaps.fn++;
    for (const rl of a.relinks) {
      s.relinks.proposed++;
      const uid = uidOf.get(rl.requirement);
      const target = rl.to ? clauseUid(w, rl.to.ref, a.version, rl.to.clause) : null;
      // a retired link is right when the clause it came from is gone from the document
      const right = rl.to
        ? target !== null && target === uid
        : !t.changes.some((c) => c.after && c.uid === uid);
      if (right) s.relinks.right++;
    }
    s.flags += a.changes.reduce((n, c) => n + c.flags.length, 0);
    s.rejected += a.rejected.length;
    s.cost_usd += a.cost_usd;
    s.model_calls += a.model_calls;
    s.errors += a.errors.length;
  }
  return s;
}
