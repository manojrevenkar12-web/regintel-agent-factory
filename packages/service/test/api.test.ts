/** The console's API over a real PostgreSQL record (RIF_TEST_DATABASE_URL; skipped without it). */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/main.js";
import { Store } from "../src/store.js";

const url = process.env.RIF_TEST_DATABASE_URL;
const db = url ? describe : describe.skip;

db("the API", () => {
  let store: Store;
  let server: Server;
  let base = "";
  const setup = `api${Date.now()}`;
  let assessment = { id: "", hash: "" };

  beforeAll(async () => {
    store = Store.connect(url as string);
    await store.migrate();
    await store.recordCrawl(setup, 3, 0, {
      source: "uda",
      today: "2026-01-08",
      status: "failed",
      data: { items: [], docs: [] },
      findings: [{ level: "error", check: "listing.empty", detail: "the listing returned no documents" }],
      pages: {},
      fingerprints: { listing: null, doc: null },
      requests: 4,
      ms: 10,
    });
    await store.openIncident(`${setup}:uda:3`, setup, "uda", 3, [{ check: "listing.empty", detail: "x" }]);
    await store.pool.query(
      "insert into requirement_vectors(id, device, text, embedding) values ('REQ-T-1', 'PMP', 'Halden Medical must record the UDI', $1) on conflict (id) do nothing",
      [
        `[${Array(256)
          .fill(0)
          .map((_, i) => (i === 0 ? 1 : 0))
          .join(",")}]`,
      ],
    );
    assessment = await store.saveAssessment(setup, "rules", 3, {
      ref: "UDA-GD-2025-001",
      version: 2,
      changes: [
        {
          id: "c1",
          verdict: "substantive",
          affected: [{ requirement: "REQ-T-1", device: "PMP" }],
          gaps: [],
          flags: [],
        },
      ],
    });
    server = app(store, { defaultSetup: setup }).listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server?.close();
    await store?.close();
  });

  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  const get = async (p: string): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, body: await r.json() };
  };

  it("shows each source's state and its open incident", async () => {
    const { body } = await get("/api/overview");
    const uda = body.sources.find((s: { source: string }) => s.source === "uda");
    expect(uda.last.status).toBe("failed");
    expect(uda.open.id).toBe(`${setup}:uda:3`);
    expect(uda.authority).toBe("Union Device Authority");
    expect(body.sources).toHaveLength(5);
  });

  it("lists incidents and answers 404 for an unknown one", async () => {
    expect((await get("/api/incidents")).body.map((i: { id: string }) => i.id)).toEqual([`${setup}:uda:3`]);
    expect((await get("/api/incidents/nope")).status).toBe(404);
  });

  it("returns an assessment with the requirement texts it cites", async () => {
    const { body } = await get(`/api/assessments/${encodeURIComponent(assessment.id)}`);
    expect(body.body_hash).toBe(assessment.hash);
    expect(body.requirements["REQ-T-1"].text).toMatch(/UDI/);
    const list = (await get("/api/assessments")).body;
    expect(list[0]).toMatchObject({ affected: 1, substantive: 1, signed: false });
  });

  it("signs as the signed-in person, refuses strangers and stale hashes", async () => {
    const post = (headers: Record<string, string>, body: object) =>
      fetch(`${base}/api/assessments/${encodeURIComponent(assessment.id)}/signoff`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const me = { "x-user-id": "u-1", "x-user-name": "Dana Weber", "x-user-role": "regulatory_affairs" };
    expect((await post({}, { bodyHash: assessment.hash, meaning: "approved" })).status).toBe(401);
    expect(
      (await post({ ...me, "x-user-role": "sales" }, { bodyHash: assessment.hash, meaning: "approved" }))
        .status,
    ).toBe(403);
    expect((await post(me, { bodyHash: "f".repeat(64), meaning: "approved" })).status).toBe(409);
    expect((await post(me, { bodyHash: assessment.hash, meaning: "maybe" })).status).toBe(400);
    expect(
      (await post(me, { bodyHash: assessment.hash, meaning: "approved", signer: "someone-else" })).status,
    ).toBe(201);
    const { body } = await get(`/api/assessments/${encodeURIComponent(assessment.id)}`);
    expect(body.signoffs[0]).toMatchObject({ signer: "u-1", name: "Dana Weber", meaning: "approved" });
  });

  it("searches requirements by vector and verifies the audit chain", async () => {
    const s = await get("/api/requirements/search?q=record%20the%20UDI&device=PMP");
    expect(s.status).toBe(200);
    expect(s.body.some((r: { id: string }) => r.id === "REQ-T-1")).toBe(true);
    expect((await get("/api/requirements/search")).status).toBe(400);
    expect((await get("/api/audit")).body.verify.ok).toBe(true);
  });
});
