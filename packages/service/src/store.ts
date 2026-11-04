/** PostgreSQL access for the platform's record (schema.sql). */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrawlData, CrawlOutcome, ScrapedDoc } from "@rif/ingest";
import pg from "pg";

/** JSON with sorted keys: PostgreSQL's jsonb reorders keys, so hashes are taken over this form. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

export class Store {
  constructor(readonly pool: pg.Pool) {}

  static connect(url: string) {
    return new Store(new pg.Pool({ connectionString: url, max: 8 }));
  }

  async migrate() {
    await this.pool.query(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8"));
  }

  async reset(setup: string) {
    for (const t of ["crawls", "last_good", "doc_versions", "incidents", "deployments", "assessments"])
      await this.pool.query(`delete from ${t} where setup = $1`, [setup]);
  }

  close() {
    return this.pool.end();
  }

  async recordCrawl(setup: string, day: number, scraper: number, o: CrawlOutcome) {
    await this.pool.query(
      `insert into crawls(setup, source, day, status, scraper, findings, listed, requests, fingerprint)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (setup, source, day, scraper) do nothing`,
      [
        setup,
        o.source,
        day,
        o.status,
        scraper,
        JSON.stringify(o.findings),
        o.data.items.length,
        o.requests,
        o.fingerprints.listing,
      ],
    );
  }

  async lastGood(setup: string, source: string): Promise<{ day: number; data: CrawlData } | null> {
    const r = await this.pool.query("select day, data from last_good where setup = $1 and source = $2", [
      setup,
      source,
    ]);
    return r.rows[0] ? { day: r.rows[0].day, data: r.rows[0].data } : null;
  }

  /** Accept a good crawl: it becomes what production uses, and new document versions are recorded. */
  async accept(
    setup: string,
    source: string,
    day: number,
    data: CrawlData,
  ): Promise<{ ref: string; version: number }[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into last_good(setup, source, day, data) values ($1,$2,$3,$4)
         on conflict (setup, source) do update set day = excluded.day, data = excluded.data`,
        [setup, source, day, JSON.stringify(data)],
      );
      const fresh: { ref: string; version: number }[] = [];
      for (const d of data.docs) {
        const r = await client.query(
          `insert into doc_versions(setup, source, ref, version, title, published, effective, clauses, first_seen)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (setup, ref, version) do nothing returning ref`,
          [
            setup,
            source,
            d.ref,
            d.version,
            d.title,
            d.published,
            d.effective,
            JSON.stringify(d.clauses),
            day,
          ],
        );
        if (r.rowCount) fresh.push({ ref: d.ref, version: d.version });
      }
      await client.query("commit");
      return fresh;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async version(setup: string, ref: string, version: number): Promise<ScrapedDoc | null> {
    const r = await this.pool.query(
      "select * from doc_versions where setup = $1 and ref = $2 and version = $3",
      [setup, ref, version],
    );
    const x = r.rows[0];
    return x
      ? {
          ref: x.ref,
          title: x.title,
          version: x.version,
          published: x.published,
          effective: x.effective,
          clauses: x.clauses,
        }
      : null;
  }

  /** The version before `version` that the platform saw (versions can be skipped between crawls). */
  async previousVersion(setup: string, ref: string, version: number): Promise<ScrapedDoc | null> {
    const r = await this.pool.query(
      "select version from doc_versions where setup = $1 and ref = $2 and version < $3 order by version desc limit 1",
      [setup, ref, version],
    );
    return r.rows[0] ? this.version(setup, ref, r.rows[0].version) : null;
  }

  async deployment(setup: string, source: string): Promise<{ version: number; code: string } | null> {
    const r = await this.pool.query(
      "select version, code from deployments where setup = $1 and source = $2 order by version desc limit 1",
      [setup, source],
    );
    return r.rows[0] ?? null;
  }

  async deploy(
    setup: string,
    source: string,
    day: number,
    by: string,
    code: string,
    incident: string | null,
  ): Promise<number> {
    const cur = await this.deployment(setup, source);
    const version = (cur?.version ?? 0) + 1;
    await this.pool.query(
      "insert into deployments(setup, source, version, day, by, incident, code, code_hash) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing",
      [setup, source, version, day, by, incident, code, createHash("sha256").update(code).digest("hex")],
    );
    await this.audit(by, "scraper.deployed", `${setup}:${source}:v${version}`, { day, incident });
    return version;
  }

  async openIncident(id: string, setup: string, source: string, day: number, findings: unknown) {
    await this.pool.query(
      "insert into incidents(id, setup, source, day, findings, status) values ($1,$2,$3,$4,$5,'open') on conflict (id) do nothing",
      [id, setup, source, day, JSON.stringify(findings)],
    );
  }

  async openIncidentFor(
    setup: string,
    source: string,
  ): Promise<{ id: string; status: string; day: number } | null> {
    const r = await this.pool.query(
      "select id, status, day from incidents where setup = $1 and source = $2 and status in ('open','repairing','escalated') order by day desc limit 1",
      [setup, source],
    );
    return r.rows[0] ?? null;
  }

  async closeIncident(
    id: string,
    fields: {
      status: string;
      decision?: string;
      reason?: string;
      cost_usd?: number;
      seconds?: number;
      record?: unknown;
      resolved_day?: number;
    },
  ) {
    await this.pool.query(
      `update incidents set status = $2, decision = coalesce($3, decision), reason = coalesce($4, reason),
       cost_usd = coalesce($5, cost_usd), seconds = coalesce($6, seconds), record = coalesce($7, record), resolved_day = coalesce($8, resolved_day) where id = $1`,
      [
        id,
        fields.status,
        fields.decision ?? null,
        fields.reason ?? null,
        fields.cost_usd ?? null,
        fields.seconds ?? null,
        fields.record ? JSON.stringify(fields.record) : null,
        fields.resolved_day ?? null,
      ],
    );
  }

  /** Append to the hash-chained audit log. */
  async audit(actor: string, action: string, subject: string, payload: unknown) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("lock table audit_log in share row exclusive mode");
      const last = await client.query("select hash from audit_log order by seq desc limit 1");
      const prev = last.rows[0]?.hash ?? "genesis";
      const body = canonical({ actor, action, subject, payload, prev });
      const hash = createHash("sha256").update(body).digest("hex");
      await client.query(
        "insert into audit_log(actor, action, subject, payload, prev_hash, hash) values ($1,$2,$3,$4,$5,$6)",
        [actor, action, subject, JSON.stringify(payload), prev, hash],
      );
      await client.query("commit");
      return hash;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Recompute the chain: true when no entry was changed, removed or reordered. */
  async verifyAudit(): Promise<{ ok: boolean; entries: number; brokenAt: number | null }> {
    const r = await this.pool.query(
      "select seq, actor, action, subject, payload, prev_hash, hash from audit_log order by seq",
    );
    let prev = "genesis";
    for (const row of r.rows) {
      const body = canonical({
        actor: row.actor,
        action: row.action,
        subject: row.subject,
        payload: row.payload,
        prev,
      });
      const h = createHash("sha256").update(body).digest("hex");
      if (row.prev_hash !== prev || row.hash !== h)
        return { ok: false, entries: r.rows.length, brokenAt: Number(row.seq) };
      prev = row.hash;
    }
    return { ok: true, entries: r.rows.length, brokenAt: null };
  }
}
