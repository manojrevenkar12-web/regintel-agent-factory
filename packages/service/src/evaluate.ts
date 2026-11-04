/** Scores what the platform believes against the world's truth. Evaluation only: nothing the
 * platform uses to decide reads this. */
import type { ScrapedDoc } from "@rif/ingest";
import { type World, render, shownAt } from "@rif/world";
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
