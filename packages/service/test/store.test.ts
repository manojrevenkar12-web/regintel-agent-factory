/** The platform's record in PostgreSQL: the audit chain, append-only tables, and e-signatures bound
 * to what was signed. Needs RIF_TEST_DATABASE_URL (PostgreSQL with pgvector, a role that may create
 * extensions); skipped without it. */
import { describe, expect, it } from "vitest";
import { Store, canonical } from "../src/store.js";

const url = process.env.RIF_TEST_DATABASE_URL;
const db = url ? describe : describe.skip;

describe("canonical JSON", () => {
  it("sorts keys and drops undefined, so jsonb round trips hash the same", () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: undefined }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"y":2}]},"b":1}',
    );
  });
});

db("the record", () => {
  const withStore = async (f: (s: Store) => Promise<void>) => {
    const s = Store.connect(url as string);
    try {
      await s.migrate();
      await f(s);
    } finally {
      await s.close();
    }
  };

  it("chains the audit log and detects a changed entry", () =>
    withStore(async (s) => {
      await s.audit("system", "test.a", "x", { n: 1 });
      await s.audit("system", "test.b", "x", { n: 2.5, nested: { b: 1, a: 2 } });
      expect((await s.verifyAudit()).ok).toBe(true);
      await expect(
        s.pool.query("update audit_log set actor = 'mallory' where seq = (select max(seq) from audit_log)"),
      ).rejects.toThrow(/append-only/);
      await expect(s.pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
      // someone with the rights to switch the trigger off can still change a row; the chain shows it
      const client = await s.pool.connect();
      try {
        await client.query("begin");
        await client.query("alter table audit_log disable trigger audit_no_change");
        await client.query(
          "update audit_log set payload = '{\"n\": 3}' where seq = (select max(seq) from audit_log)",
        );
        await client.query("alter table audit_log enable trigger audit_no_change");
        const v = await s.verifyAudit.call({
          pool: { query: (q: string) => client.query(q) },
        } as unknown as Store);
        expect(v.ok).toBe(false);
        await client.query("rollback");
      } finally {
        client.release();
      }
      expect((await s.verifyAudit()).ok).toBe(true);
    }));

  it("binds a sign-off to the assessment it signed, by hash, and keeps it", () =>
    withStore(async (s) => {
      const setup = `t${Date.now()}`;
      const body = { ref: "UDA-GD-2025-001", version: 2, changes: [{ id: "c1", affected: ["REQ-1"] }] };
      const { id, hash } = await s.saveAssessment(setup, "rules", 5, body);
      const roles = ["regulatory_affairs", "quality_assurance"];
      const sign = {
        bodyHash: hash,
        signer: "u-17",
        name: "Dana Weber",
        role: "regulatory_affairs",
        meaning: "approved" as const,
        decisions: { c1: "accepted" },
      };
      expect(await s.signoff(id, { ...sign, role: "intern" }, roles)).toEqual({
        ok: false,
        error: "role intern may not sign assessments",
      });
      expect(await s.signoff(id, { ...sign, bodyHash: "0".repeat(64) }, roles)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/changed since/),
      });
      expect(await s.signoff(id, { ...sign, name: " " }, roles)).toMatchObject({ ok: false });
      const ok = await s.signoff(id, sign, roles);
      expect(ok.ok).toBe(true);
      // a signed assessment is not overwritten by a later run, nor cleared
      const again = await s.saveAssessment(setup, "rules", 6, { ...body, changes: [] });
      expect(again.saved).toBe(false);
      await s.clearUnsignedAssessments(setup);
      const a = await s.assessment(id);
      expect(a.body_hash).toBe(hash);
      expect(a.signoffs).toHaveLength(1);
      await expect(s.pool.query("delete from signoffs where assessment = $1", [id])).rejects.toThrow(
        /append-only/,
      );
      const log = await s.pool.query("select action from audit_log where subject = $1 order by seq", [id]);
      expect(log.rows.map((r) => r.action)).toEqual(["assessment.proposed", "assessment.approved"]);
    }));

  it("records crawls and new document versions once", () =>
    withStore(async (s) => {
      const setup = `t${Date.now()}`;
      const data = {
        items: [],
        docs: [
          {
            ref: "UDA-GD-2025-001",
            title: "t",
            version: 1,
            published: "2025-01-01",
            effective: "2025-01-31",
            clauses: [{ id: "1.1", text: "x".repeat(30) }],
          },
        ],
      };
      expect(await s.accept(setup, "uda", 1, data)).toEqual([{ ref: "UDA-GD-2025-001", version: 1 }]);
      expect(await s.accept(setup, "uda", 2, data)).toEqual([]);
      expect((await s.versions(setup)).map((v) => [v.ref, v.version, v.first_seen])).toEqual([
        ["UDA-GD-2025-001", 1, 1],
      ]);
      expect((await s.lastGood(setup, "uda"))?.day).toBe(2);
      await s.reset(setup);
      expect(await s.versions(setup)).toEqual([]);
    }));
});
