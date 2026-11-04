/** What changed between two versions of a regulatory document, clause by clause. Clauses are
 * matched by number first, then by text, so a renumbered clause is a move rather than a deletion
 * and an addition. Then each modified clause is read for the parameters an obligation turns on:
 * who must act, how strongly, for which devices, by when, how often. */
import type { Clause, ScrapedDoc } from "@rif/ingest";

export type Change = {
  kind: "modified" | "added" | "removed" | "moved";
  before: Clause | null;
  after: Clause | null;
  params: ParamDiff; // what the rules read from the two texts
  rule: "substantive" | "editorial" | "unclear"; // the rules' verdict before any model
};

export type Params = {
  modal: string | null;
  days: number | null;
  frequency: string | null;
  classes: string[] | null;
  actor: string | null;
};
export type ParamDiff = { before: Params | null; after: Params | null; changed: (keyof Params)[] };

const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export function similarity(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / Math.max(1, new Set([...A, ...B]).size);
}

const FREQ = /\b(annually|every two years|every six months|quarterly|monthly|every year)\b/i;
const ACTOR = /\b(the manufacturer|the authorised representative|the importer|the distributor)\b/i;

/** The obligation's parameters, read from its text. */
export function readParams(text: string): Params {
  const modal = text.match(/\b(shall|should|must|may)\b/i)?.[1]?.toLowerCase() ?? null;
  const days = text.match(/within (\d+) (?:calendar |working )?days/i);
  let classes: string[] | null = null;
  if (/\ball devices\b/i.test(text)) classes = ["I", "IIa", "IIb", "III"];
  else {
    const m = text.match(
      /class(?:es)? ((?:I{1,3}|IIa|IIb)(?:, (?:I{1,3}|IIa|IIb))*(?: and (?:I{1,3}|IIa|IIb))?) devices/i,
    );
    if (m) classes = (m[1] as string).split(/, | and /).map((c) => c.trim());
  }
  return {
    modal,
    days: days ? Number(days[1]) : null,
    frequency: text.match(FREQ)?.[1]?.toLowerCase() ?? null,
    classes,
    actor: text.match(ACTOR)?.[1]?.toLowerCase() ?? null,
  };
}

export function paramDiff(before: Clause | null, after: Clause | null): ParamDiff {
  const b = before ? readParams(before.text) : null;
  const a = after ? readParams(after.text) : null;
  const changed: (keyof Params)[] = [];
  if (a && b)
    for (const k of ["modal", "days", "frequency", "classes", "actor"] as const)
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) changed.push(k);
  return { before: b, after: a, changed };
}

/** Align the two versions: identical texts first (unchanged, or moved when the number changed), then
 * the most similar remaining pairs (a small bonus for keeping the number), then what is left over
 * was removed or added. Greedy over all pairs, so a renumbered document does not cascade into
 * false edits. */
export function diffVersions(prev: ScrapedDoc, next: ScrapedDoc, minSimilarity = 0.6): Change[] {
  const out: Change[] = [];
  const P = new Set(prev.clauses);
  const N = new Set(next.clauses);
  for (const p of prev.clauses) {
    const same =
      [...N].find((n) => n.text === p.text && n.id === p.id) ?? [...N].find((n) => n.text === p.text);
    if (!same) continue;
    P.delete(p);
    N.delete(same);
    if (same.id !== p.id) out.push(change("moved", p, same));
  }
  const pairs: { p: Clause; n: Clause; s: number }[] = [];
  for (const p of P)
    for (const n of N) pairs.push({ p, n, s: similarity(p.text, n.text) + (p.id === n.id ? 0.05 : 0) });
  pairs.sort((a, b) => b.s - a.s);
  for (const { p, n, s } of pairs) {
    if (s < minSimilarity) break;
    if (!P.has(p) || !N.has(n)) continue;
    P.delete(p);
    N.delete(n);
    out.push(change("modified", p, n));
  }
  // A heavy rewording can fall below the similarity bar. If what disappeared and what appeared state
  // the same obligation parameters, pair them as a modification the rules cannot decide (unclear).
  const sameParams = (a: Clause, b: Clause) =>
    JSON.stringify(readParams(a.text)) === JSON.stringify(readParams(b.text));
  const loose = pairs.filter(({ p, n }) => P.has(p) && N.has(n) && sameParams(p, n));
  for (const { p, n } of loose) {
    if (!P.has(p) || !N.has(n)) continue;
    P.delete(p);
    N.delete(n);
    out.push(change("modified", p, n));
  }
  for (const p of P) out.push(change("removed", p, null));
  for (const n of N) out.push(change("added", null, n));
  return out;
}

function change(kind: Change["kind"], before: Clause | null, after: Clause | null): Change {
  const params = paramDiff(before, after);
  let rule: Change["rule"] = "unclear";
  if (kind === "added" || kind === "removed") rule = "substantive";
  else if (params.changed.length) rule = "substantive";
  else if (kind === "moved") rule = "editorial";
  // a text change with every parameter the same is probably rewording; a model reads it to be sure
  return { kind, before, after, params, rule };
}
