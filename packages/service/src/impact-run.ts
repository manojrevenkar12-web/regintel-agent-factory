/** rif impact: assess every new document version a season recorded, with every matcher, in the order
 * the platform saw them. Each matcher keeps its own copy of the trace links and applies its own
 * proposed relinks as it goes (in production an expert signs them first; here they are applied as
 * proposed so later versions see the links the platform would have). The verified and the raw model
 * share one reading per version, so the verifier's worth is measured on identical answers.
 *
 * The company's requirements come from an export (the stand-in for Polarion or Veeva), with the
 * world's truth stripped before the platform sees them. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Assessment,
  type Context,
  type Graph,
  Index,
  type Link,
  type Method,
  type Reader,
  assess,
  claudeReader,
} from "@rif/impact";
import { ROOT } from "@rif/ingest";
import { type World, buildWorld, loadWorldCfg, render } from "@rif/world";
import { parse } from "yaml";
import { Store } from "./store.js";

export type ImpactCfg = {
  authorities: Record<string, string>;
  diff: { min_similarity: number };
  retrieval: { dims: number; bm25: { k1: number; b: number }; weight_dense: number; per_device: number };
  rules: Context["rules"];
  model: {
    setups: { name: string; model: string; budget_usd: number; timeout_s: number }[];
    max_candidates: number;
  };
  signoff: { roles: string[] };
};
export const impactCfg = (): ImpactCfg => parse(readFileSync(join(ROOT, "config/impact.yaml"), "utf8"));

/** The requirements export: what the company's ALM tool would hand over. No truth in it. */
export function requirementsExport(w: World = buildWorld()): { graph: Graph; links: Map<string, Link> } {
  const graph: Graph = {
    devices: w.company.devices.map((d) => ({ id: d.id, name: d.name, class: d.class })),
    requirements: w.company.requirements.map((r) => ({
      id: r.id,
      device: r.device,
      text: r.text,
      topic: r.topic,
      rationale: r.rationale,
    })),
  };
  const links = new Map<string, Link>();
  for (const r of w.company.requirements) if (r.trace) links.set(r.id, { ...r.trace });
  return { graph, links };
}

/** Wrap a reader so the same prompt is read once (the raw and verified model share a reading). */
function memo(r: Reader): Reader {
  const seen = new Map<string, ReturnType<Reader["read"]>>();
  return {
    name: r.name,
    read(system, prompt) {
      const k = `${system}\n${prompt}`;
      const hit = seen.get(k);
      if (hit) return hit.then((x) => ({ ...x, cost_usd: 0 }));
      const p = r.read(system, prompt);
      seen.set(k, p);
      return p;
    },
  };
}

export type Run = { name: string; method: Method; reader?: Reader; linksFrom?: string };

/** The held-out world: another draw of the same kinds of regulators and company. */
export const heldoutWorld = () => buildWorld(loadWorldCfg(join(ROOT, "config/heldout/world.yaml")));

/** Every version a regulator published, as a crawler that never failed would have recorded it. */
function publishedVersions(w: World) {
  return w.docs
    .flatMap((d) =>
      d.versions.map((v) => ({
        ref: d.ref,
        source: d.source,
        title: d.title,
        version: v.version,
        published: w.date(v.day),
        effective: w.date(v.day + 30),
        clauses: v.clauses.map((c) => ({ id: c.id, text: render(c.ob, c.wording) })),
        first_seen: Math.max(0, v.day),
      })),
    )
    .sort((a, b) => a.first_seen - b.first_seen || a.ref.localeCompare(b.ref) || a.version - b.version);
}

export async function runImpact(
  db: string,
  setupIn: string,
  limit: number,
  only?: string[],
  heldout = false,
) {
  const cfg = impactCfg();
  const setup = heldout ? "heldout-world" : setupIn;
  const store = Store.connect(db);
  await store.migrate();
  await store.clearUnsignedAssessments(setup);
  const world = heldout ? heldoutWorld() : buildWorld();
  const { graph, links } = requirementsExport(world);
  const index = new Index(
    graph.requirements.map((r) => ({ id: r.id, text: r.text })),
    {
      k1: cfg.retrieval.bm25.k1,
      b: cfg.retrieval.bm25.b,
      dims: cfg.retrieval.dims,
      weightDense: cfg.retrieval.weight_dense,
    },
  );
  // the vectors the API searches with pgvector
  for (const r of heldout ? [] : graph.requirements)
    await store.pool.query(
      `insert into requirement_vectors(id, device, text, embedding) values ($1,$2,$3,$4)
       on conflict (id) do update set text = excluded.text, embedding = excluded.embedding`,
      [r.id, r.device, r.text, `[${(index.vector(r.id) as number[]).map((x) => x.toFixed(6)).join(",")}]`],
    );

  const runs: Run[] = [
    { name: "links", method: "links" },
    { name: "retrieval", method: "retrieval" },
    { name: "rules", method: "rules" },
  ];
  for (const m of cfg.model.setups) {
    const reader = memo(claudeReader(m.model, m.budget_usd, m.timeout_s));
    runs.push({ name: `model-${m.name}`, method: "model", reader });
    if (m.name === cfg.model.setups[0]?.name)
      runs.push({ name: `raw-${m.name}`, method: "model-raw", reader, linksFrom: `model-${m.name}` });
  }
  const chosen = only?.length ? runs.filter((r) => only.includes(r.name)) : runs;
  const linkState = new Map(chosen.map((r) => [r.name, new Map(links)]));

  const versions = heldout ? publishedVersions(world) : await store.versions(setup);
  // the platform's current copy of every document, as of each point in the season
  const current = new Map<string, (typeof versions)[number]>();
  const out = new Map<string, (Assessment & { day: number; from: number })[]>(
    chosen.map((r) => [r.name, []]),
  );
  let n = 0;
  for (const v of versions) {
    const prev = current.get(v.ref);
    current.set(v.ref, v);
    if (!prev || prev.version >= v.version) continue;
    if (n++ >= limit) break;
    const clauseText = (ref: string, clause: string) =>
      (ref === v.ref ? prev : current.get(ref))?.clauses.find((c) => c.id === clause)?.text ?? null;
    const meta = {
      ref: v.ref,
      title: v.title,
      source: v.source,
      authority: cfg.authorities[v.source] ?? v.source,
      published: v.published,
    };
    // relinks are applied after every matcher has read this version, so the raw model reads the
    // same links as the verified one
    const pending: [Map<string, Link>, Assessment][] = [];
    for (const run of chosen) {
      const ls = linkState.get(run.linksFrom ?? run.name) as Map<string, Link>;
      const ctx: Context = {
        graph,
        links: ls,
        index,
        clauseText,
        meta,
        rules: cfg.rules,
        perDevice: cfg.retrieval.per_device,
        minSimilarity: cfg.diff.min_similarity,
        reader: run.reader,
      };
      const a = await assess(prev, v, run.method, ctx);
      if (!run.linksFrom) pending.push([ls, a]);
      (out.get(run.name) as (Assessment & { day: number; from: number })[]).push({
        ...a,
        day: v.first_seen,
        from: prev.version,
      });
      await store.saveAssessment(setup, run.name, v.first_seen, a);
      const substantive = a.changes.filter((c) => c.verdict === "substantive").length;
      console.log(
        `${v.ref} v${prev.version}->v${v.version} ${run.name}: ${a.changes.length} changes (${substantive} substantive), ` +
          `${a.changes.reduce((s, c) => s + c.affected.length, 0)} affected, ${a.changes.reduce((s, c) => s + c.gaps.length, 0)} gaps, ` +
          `${a.relinks.length} relinks${a.rejected.length ? `, ${a.rejected.length} rejected` : ""}${a.cost_usd ? `, $${a.cost_usd.toFixed(3)}` : ""}${a.errors.length ? `, errors: ${a.errors.join("; ").slice(0, 160)}` : ""}`,
      );
    }
    for (const [ls, a] of pending)
      for (const rl of a.relinks) {
        if (rl.to) ls.set(rl.requirement, rl.to);
        else ls.delete(rl.requirement);
      }
  }
  const dir = join(ROOT, "reports", "impact", setup);
  mkdirSync(dir, { recursive: true });
  for (const [name, list] of out)
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(list, null, 1)}\n`);
  if (heldout && limit >= 1000) {
    // the first complete run of each matcher on the held-out world is kept as it was
    const first = join(ROOT, "reports", "heldout", "impact");
    mkdirSync(first, { recursive: true });
    for (const [name, list] of out) {
      const f = join(first, `${name}.json`);
      if (!existsSync(f) && list.length) writeFileSync(f, `${JSON.stringify(list, null, 1)}\n`);
    }
  }
  await store.close();
}
