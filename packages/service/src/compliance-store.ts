/** The compliance check's record in PostgreSQL: runs, the procedures as checked, findings (hashed),
 * append-only reviews bound to a finding's hash, and the rulings they leave behind. */
import { createHash } from "node:crypto";
import {
  type Finding,
  type Procedure,
  type Requirement,
  type Ruling,
  type Verdict,
  procedureHash,
  requirementKey,
  rulingFrom,
} from "@rif/compliance";
import { type Store, canonical } from "./store.js";

export type SavedFinding = {
  id: string;
  procedure: string;
  requirement: Requirement;
  body: Finding;
  body_hash: string;
};

const VERDICTS: Verdict[] = ["covered", "partial", "conflict", "missing"];

export async function saveRun(
  store: Store,
  run: { id: string; world: string; version: number; design: string },
  procs: Procedure[],
  checked: { requirement: Requirement; finding: Finding }[],
) {
  const summary = {
    procedures: procs.length,
    findings: checked.length,
    verdicts: Object.fromEntries(
      VERDICTS.map((v) => [v, checked.filter((c) => c.finding.verdict === v).length]),
    ),
    routes: Object.fromEntries(
      ["auto", "review", "ruling"].map((r) => [r, checked.filter((c) => c.finding.route === r).length]),
    ),
  };
  await store.pool.query(
    "insert into compliance_runs(id, world, version, design, summary) values ($1,$2,$3,$4,$5) on conflict (id) do nothing",
    [run.id, run.world, run.version, run.design, JSON.stringify(summary)],
  );
  for (const p of procs)
    await store.pool.query(
      "insert into compliance_procedures(run, id, customer, device, title, steps) values ($1,$2,$3,$4,$5,$6) on conflict do nothing",
      [
        run.id,
        p.id,
        p.customer,
        p.device,
        p.title,
        JSON.stringify(p.steps.map((s) => ({ id: s.id, text: s.text }))),
      ],
    );
  for (const c of checked) {
    const body_hash = createHash("sha256").update(canonical(c.finding)).digest("hex");
    await store.pool.query(
      "insert into compliance_findings(run, id, procedure, requirement, body, body_hash) values ($1,$2,$3,$4,$5,$6) on conflict do nothing",
      [
        run.id,
        `${c.requirement.id}@${c.finding.procedure}`,
        c.finding.procedure,
        JSON.stringify(c.requirement),
        JSON.stringify(c.finding),
        body_hash,
      ],
    );
  }
  await store.audit("system", "compliance.checked", run.id, summary);
  return summary;
}

export async function runs(store: Store) {
  return (
    await store.pool.query(
      "select id, world, version, design, summary, created from compliance_runs order by created desc",
    )
  ).rows;
}

export async function procedures(store: Store, run: string) {
  const r = await store.pool.query(
    `select p.id, p.customer, p.device, p.title,
       (select json_object_agg(v, n) from (select f.body->>'verdict' v, count(*) n from compliance_findings f where f.run = p.run and f.procedure = p.id group by 1) x) as verdicts,
       (select count(*)::int from compliance_findings f where f.run = p.run and f.procedure = p.id and f.body->>'route' = 'review'
          and not exists (select 1 from compliance_reviews r where r.run = f.run and r.finding = f.id)) as open
     from compliance_procedures p where p.run = $1 order by p.customer, p.id`,
    [run],
  );
  return r.rows;
}

export async function procedureDetail(store: Store, run: string, id: string) {
  const p = await store.pool.query("select * from compliance_procedures where run = $1 and id = $2", [
    run,
    id,
  ]);
  if (!p.rows[0]) return null;
  const f = await store.pool.query(
    `select f.id, f.requirement, f.body, f.body_hash,
       coalesce((select json_agg(r order by r.seq) from compliance_reviews r where r.run = f.run and r.finding = f.id), '[]') as reviews
     from compliance_findings f where f.run = $1 and f.procedure = $2 order by f.id`,
    [run, id],
  );
  return { procedure: p.rows[0], findings: f.rows };
}

export type Review = {
  run: string;
  finding: string;
  bodyHash: string;
  reviewer: string;
  role: string;
  decision: "confirmed" | "corrected";
  verdict: Verdict;
  steps: string[];
  note: string;
};

/** Record a review bound to the finding's hash (a stale hash is refused), and the ruling it leaves. */
export async function review(
  store: Store,
  r: Review,
  roles: string[],
): Promise<{ ok: true; seq: number } | { ok: false; error: string }> {
  if (!roles.includes(r.role)) return { ok: false, error: `the role ${r.role} may not review findings` };
  if (!VERDICTS.includes(r.verdict))
    return { ok: false, error: "verdict must be covered, partial, conflict or missing" };
  if (r.decision === "corrected" && !r.note.trim())
    return { ok: false, error: "a correction needs a note saying why" };
  const f = await store.pool.query(
    "select f.*, p.customer, p.device, p.title, p.steps from compliance_findings f join compliance_procedures p on p.run = f.run and p.id = f.procedure where f.run = $1 and f.id = $2",
    [r.run, r.finding],
  );
  const row = f.rows[0];
  if (!row) return { ok: false, error: `no finding ${r.finding}` };
  if (row.body_hash !== r.bodyHash)
    return { ok: false, error: "the finding changed since it was opened; reload it" };
  const steps = row.steps as { id: string; text: string }[];
  if (r.steps.some((id) => !steps.some((s) => s.id === id)))
    return { ok: false, error: "a step named in the review is not in the procedure" };
  const ins = await store.pool.query(
    "insert into compliance_reviews(run, finding, body_hash, reviewer, role, decision, verdict, steps, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning seq",
    [
      r.run,
      r.finding,
      r.bodyHash,
      r.reviewer,
      r.role,
      r.decision,
      r.verdict,
      JSON.stringify(r.steps),
      r.note,
    ],
  );
  const proc = {
    id: row.procedure,
    customer: row.customer,
    device: row.device,
    title: row.title,
    steps: steps.map((s) => ({ id: s.id, text: s.text })),
  } as unknown as Procedure;
  const ruling = rulingFrom(
    row.body as Finding,
    row.requirement as Requirement,
    proc,
    r.verdict,
    r.reviewer,
    r.note || "confirmed",
    r.steps.map((id) => steps.find((s) => s.id === id)?.text ?? ""),
  );
  ruling.procedureHash = procedureHash(proc);
  await store.pool.query(
    "insert into compliance_rulings(customer, requirement, step_text, procedure_hash, embedding, found, verdict, by_who, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      ruling.customer,
      ruling.requirement,
      ruling.stepText,
      ruling.procedureHash,
      `[${ruling.vector.map((x) => x.toFixed(6)).join(",")}]`,
      JSON.stringify(ruling.found),
      ruling.verdict,
      ruling.by,
      ruling.note,
    ],
  );
  await store.audit(r.reviewer, `compliance.${r.decision}`, `${r.run}:${r.finding}`, {
    hash: r.bodyHash,
    verdict: r.verdict,
    steps: r.steps,
  });
  return { ok: true, seq: Number(ins.rows[0].seq) };
}

export async function rulings(store: Store, customer?: string): Promise<Ruling[]> {
  const r = await store.pool.query(
    "select customer, requirement, step_text, procedure_hash, found, verdict, by_who, note from compliance_rulings where ($1::text is null or customer = $1) order by seq",
    [customer ?? null],
  );
  return r.rows.map((x) => ({
    customer: x.customer,
    requirement: x.requirement,
    stepText: x.step_text,
    procedureHash: x.procedure_hash,
    vector: [],
    found: x.found,
    verdict: x.verdict,
    by: x.by_who,
    note: x.note,
  }));
}

export { requirementKey };
