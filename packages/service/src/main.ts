/** The API behind the console. It reads the platform's record in PostgreSQL and the generated
 * reports; it never reads the world. Identity comes from headers an authenticating proxy sets
 * (x-user-id, x-user-name, x-user-role); a sign-off is always recorded as the signed-in person, never
 * as whoever the request body names. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { embed } from "@rif/impact";
import { ROOT, SOURCES } from "@rif/ingest";
import express, { type NextFunction, type Request, type Response } from "express";
import { procedureDetail, procedures, review, runs } from "./compliance-store.js";
import { impactCfg } from "./impact-run.js";
import { Store } from "./store.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next);

export function app(store: Store, opts: { defaultSetup?: string } = {}) {
  const a = express();
  a.use(express.json({ limit: "1mb" }));
  a.disable("x-powered-by");
  const setupOf = (req: Request) => String(req.query.setup ?? opts.defaultSetup ?? "sonnet-gated");

  a.get(
    "/api/health",
    wrap(async (_req, res) => {
      await store.pool.query("select 1");
      res.json({ ok: true });
    }),
  );

  a.get(
    "/api/setups",
    wrap(async (_req, res) => {
      const r = await store.pool.query(
        "select setup, count(*)::int as crawls, max(day)::int as last_day from crawls group by setup order by setup",
      );
      res.json(r.rows);
    }),
  );

  /** Per source: the latest crawl, the scraper in production and any open incident. */
  a.get(
    "/api/overview",
    wrap(async (req, res) => {
      const setup = setupOf(req);
      const sources = await Promise.all(
        SOURCES.map(async (source) => {
          const last = await store.pool.query(
            "select day, status, findings, listed, requests, scraper from crawls where setup = $1 and source = $2 order by day desc, scraper desc limit 1",
            [setup, source],
          );
          const series = await store.pool.query(
            "select day, status from crawls where setup = $1 and source = $2 order by day, scraper",
            [setup, source],
          );
          const dep = await store.pool.query(
            "select version, day, by, incident from deployments where setup = $1 and source = $2 order by version desc limit 1",
            [setup, source],
          );
          const open = await store.openIncidentFor(setup, source);
          const lg = await store.lastGood(setup, source);
          // one status per day: the last crawl of the day wins (a repair recrawls)
          const days = new Map<number, string>();
          for (const r of series.rows) days.set(r.day, r.status);
          return {
            source,
            authority: impactCfg().authorities[source] ?? source,
            last: last.rows[0] ?? null,
            deployment: dep.rows[0] ?? null,
            open,
            documents: lg?.data.docs.length ?? 0,
            last_good_day: lg?.day ?? null,
            days: [...days].map(([day, status]) => ({ day, status })),
          };
        }),
      );
      const inc = await store.pool.query(
        "select status, count(*)::int as n, coalesce(sum(cost_usd), 0)::float as cost from incidents where setup = $1 group by status",
        [setup],
      );
      res.json({ setup, sources, incidents: inc.rows });
    }),
  );

  a.get(
    "/api/incidents",
    wrap(async (req, res) => {
      const r = await store.pool.query(
        `select id, source, day, status, decision, reason, cost_usd::float, seconds, resolved_day, findings,
              jsonb_array_length(coalesce(record->'attempts', '[]'::jsonb)) as attempts
         from incidents where setup = $1 order by day, source`,
        [setupOf(req)],
      );
      res.json(r.rows);
    }),
  );

  a.get(
    "/api/incidents/:id",
    wrap(async (req, res) => {
      const r = await store.pool.query("select * from incidents where id = $1", [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: `no incident ${req.params.id}` });
      const dep = await store.pool.query(
        "select version, day, by, code_hash from deployments where incident = $1",
        [req.params.id],
      );
      res.json({ ...r.rows[0], cost_usd: Number(r.rows[0].cost_usd), deployment: dep.rows[0] ?? null });
    }),
  );

  a.get(
    "/api/deployments",
    wrap(async (req, res) => {
      const r = await store.pool.query(
        "select source, version, day, by, incident, code_hash from deployments where setup = $1 order by source, version",
        [setupOf(req)],
      );
      res.json(r.rows);
    }),
  );

  a.get(
    "/api/assessments",
    wrap(async (req, res) => {
      const rows = await store.assessments(
        setupOf(req),
        req.query.method ? String(req.query.method) : undefined,
      );
      res.json(
        rows.map((x) => ({
          id: x.id,
          method: x.method,
          ref: x.ref,
          version: x.version,
          day: x.day,
          changes: x.body.changes.length,
          substantive: x.body.changes.filter((c: { verdict: string }) => c.verdict === "substantive").length,
          affected: x.body.changes.reduce(
            (n: number, c: { affected: unknown[] }) => n + c.affected.length,
            0,
          ),
          gaps: x.body.changes.reduce((n: number, c: { gaps: unknown[] }) => n + c.gaps.length, 0),
          flags: x.body.changes.reduce((n: number, c: { flags: unknown[] }) => n + c.flags.length, 0),
          signed: x.signoffs.length > 0,
        })),
      );
    }),
  );

  a.get(
    "/api/assessments/:id",
    wrap(async (req, res) => {
      const x = await store.assessment(req.params.id as string);
      if (!x) return res.status(404).json({ error: `no assessment ${req.params.id}` });
      // the requirement texts the expert needs beside each pick
      const ids = [
        ...new Set(
          (x.body.changes as { affected: { requirement: string }[] }[]).flatMap((c) =>
            c.affected.map((p) => p.requirement),
          ),
        ),
      ];
      const reqs = ids.length
        ? await store.pool.query("select id, device, text from requirement_vectors where id = any($1)", [ids])
        : { rows: [] };
      res.json({ ...x, requirements: Object.fromEntries(reqs.rows.map((r) => [r.id, r])) });
    }),
  );

  a.post(
    "/api/assessments/:id/signoff",
    wrap(async (req, res) => {
      const id = req.header("x-user-id");
      const name = req.header("x-user-name");
      const role = req.header("x-user-role");
      if (!id || !name || !role) return res.status(401).json({ error: "sign in to sign" });
      const b = req.body as { bodyHash?: string; meaning?: string; decisions?: unknown };
      if (!b.bodyHash || !["reviewed", "approved", "rejected"].includes(String(b.meaning)))
        return res
          .status(400)
          .json({ error: "a sign-off needs bodyHash and a meaning: reviewed, approved or rejected" });
      const r = await store.signoff(
        req.params.id as string,
        {
          bodyHash: b.bodyHash,
          signer: id,
          name,
          role,
          meaning: b.meaning as "approved",
          decisions: b.decisions ?? {},
        },
        impactCfg().signoff.roles,
      );
      if (!r.ok)
        return res.status(/changed since/.test(r.error) ? 409 : /role/.test(r.error) ? 403 : 400).json(r);
      res.status(201).json(r);
    }),
  );

  /** SOP compliance: runs, procedures with their open reviews, and one procedure's findings. */
  a.get(
    "/api/compliance/runs",
    wrap(async (_req, res) => {
      res.json(await runs(store));
    }),
  );
  a.get(
    "/api/compliance/runs/:run/procedures",
    wrap(async (req, res) => {
      res.json(await procedures(store, req.params.run as string));
    }),
  );
  a.get(
    "/api/compliance/runs/:run/procedures/:id",
    wrap(async (req, res) => {
      const d = await procedureDetail(store, req.params.run as string, req.params.id as string);
      if (!d)
        return res.status(404).json({ error: `no procedure ${req.params.id} in run ${req.params.run}` });
      res.json(d);
    }),
  );
  /** An expert confirms or corrects a finding; recorded as the signed-in person, bound to its hash. */
  a.post(
    "/api/compliance/runs/:run/findings/:finding/review",
    wrap(async (req, res) => {
      const id = req.header("x-user-id");
      const role = req.header("x-user-role");
      if (!id || !role) return res.status(401).json({ error: "sign in to review" });
      const b = req.body as {
        bodyHash?: string;
        decision?: string;
        verdict?: string;
        steps?: string[];
        note?: string;
      };
      if (!b.bodyHash || !["confirmed", "corrected"].includes(String(b.decision)) || !b.verdict)
        return res
          .status(400)
          .json({ error: "a review needs bodyHash, a decision (confirmed or corrected) and a verdict" });
      const r = await review(
        store,
        {
          run: req.params.run as string,
          finding: req.params.finding as string,
          bodyHash: b.bodyHash,
          reviewer: id,
          role,
          decision: b.decision as "confirmed",
          verdict: b.verdict as "covered",
          steps: Array.isArray(b.steps) ? b.steps.map(String) : [],
          note: String(b.note ?? ""),
        },
        impactCfg().signoff.roles,
      );
      if (!r.ok)
        return res
          .status(
            /changed since/.test(r.error)
              ? 409
              : /role/.test(r.error)
                ? 403
                : /^no finding/.test(r.error)
                  ? 404
                  : 400,
          )
          .json(r);
      res.status(201).json(r);
    }),
  );

  /** Requirements nearest to a text, by the same hashed embedding the matchers use (pgvector). */
  a.get(
    "/api/requirements/search",
    wrap(async (req, res) => {
      const q = String(req.query.q ?? "").trim();
      if (!q) return res.status(400).json({ error: "q is required" });
      const v = `[${embed(q, impactCfg().retrieval.dims)
        .map((x) => x.toFixed(6))
        .join(",")}]`;
      const r = await store.pool.query(
        `select id, device, text, 1 - (embedding <=> $1::vector) as score from requirement_vectors
        where ($2::text is null or device = $2) order by embedding <=> $1::vector limit 10`,
        [v, req.query.device ? String(req.query.device) : null],
      );
      res.json(r.rows);
    }),
  );

  a.get(
    "/api/audit",
    wrap(async (req, res) => {
      const r = await store.pool.query(
        "select seq, at, actor, action, subject, hash from audit_log where ($1::text is null or subject like $1) order by seq desc limit 200",
        [req.query.subject ? `${String(req.query.subject)}%` : null],
      );
      res.json({ verify: await store.verifyAudit(), entries: r.rows });
    }),
  );

  /** The measured results (generated by `rif report`). */
  a.get("/api/results", (_req, res) => {
    const f = join(ROOT, "reports", "results.json");
    if (!existsSync(f)) return res.status(404).json({ error: "no results yet: run rif report" });
    res.type("json").send(readFileSync(f, "utf8"));
  });

  const dist = join(ROOT, "apps", "console", "dist");
  if (existsSync(dist)) {
    a.use(express.static(dist));
    a.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
  }
  a.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "the server could not answer; see its log" });
  });
  return a;
}

export async function serve() {
  const url = process.env.RIF_DATABASE_URL;
  if (!url) throw new Error("set RIF_DATABASE_URL");
  const store = Store.connect(url);
  await store.migrate();
  const port = Number(process.env.PORT ?? 8787);
  app(store).listen(port, () => console.log(`rif api on http://localhost:${port}`));
}
