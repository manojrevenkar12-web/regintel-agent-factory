/** Candidate requirements for a clause: BM25 over words plus a hashed embedding (the same vectors
 * the service keeps in pgvector), blended. Deliberately simple and local: no embedding service, no
 * network, the same numbers every run. Its job is recall; the reading comes after. */
const STOP = new Set(
  "a an the of for to and or in on at by with within be is are that this it its as from any all each every their which who shall should must may".split(
    " ",
  ),
);

export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ly")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export const terms = (s: string) =>
  (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).map(stem);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Signed feature hashing of words and word pairs, L2-normalised. */
export function embed(text: string, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  const t = terms(text);
  const feats = [...t, ...t.slice(1).map((w, i) => `${t[i]}_${w}`)];
  for (const f of feats) {
    const h = hash(f);
    v[h % dims] = (v[h % dims] as number) + ((h >>> 31) & 1 ? -1 : 1);
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);

export type Doc = { id: string; text: string };
export type Hit = { id: string; score: number; bm25: number; dense: number };

export class Index {
  private docs: { id: string; tf: Map<string, number>; len: number; vec: number[] }[];
  private df = new Map<string, number>();
  private avg: number;
  constructor(
    docs: Doc[],
    private opts = { k1: 1.2, b: 0.75, dims: 256, weightDense: 0.4 },
  ) {
    this.docs = docs.map((d) => {
      const t = terms(d.text);
      const tf = new Map<string, number>();
      for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
      for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
      return { id: d.id, tf, len: t.length, vec: embed(d.text, opts.dims) };
    });
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  vector(id: string): number[] | undefined {
    return this.docs.find((d) => d.id === id)?.vec;
  }

  /** Every document scored against the query, best first; `only` restricts the ids considered. */
  search(query: string, only?: Set<string>): Hit[] {
    const q = [...new Set(terms(query))];
    const qv = embed(query, this.opts.dims);
    const N = this.docs.length;
    const { k1, b } = this.opts;
    const raw = this.docs
      .filter((d) => !only || only.has(d.id))
      .map((d) => {
        let s = 0;
        for (const w of q) {
          const f = d.tf.get(w);
          if (!f) continue;
          const df = this.df.get(w) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / this.avg));
        }
        return { id: d.id, bm25: s, dense: cosine(qv, d.vec) };
      });
    const max = Math.max(1e-9, ...raw.map((r) => r.bm25));
    const w = this.opts.weightDense;
    return raw
      .map((r) => ({ ...r, score: (1 - w) * (r.bm25 / max) + w * Math.max(0, r.dense) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
}
