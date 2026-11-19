/** The SOP compliance check end to end: scored against the truth (no database), then as a durable
 * workflow with reviews over the API (RIF_TEST_DATABASE_URL; skipped without it). */
import type { Server } from "node:http";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { buildWorld } from "@rif/world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluate } from "../src/compliance-run.js";
import { procedureDetail } from "../src/compliance-store.js";
import { complianceWorkflow, setComplianceContext } from "../src/compliance-workflow.js";
import { app } from "../src/main.js";
import { Store } from "../src/store.js";

describe("the compliance check against the truth", () => {
  const r = evaluate(buildWorld());
  const [manual, keyword, rules] = r.version1;
  const [v2, v2ruled] = r.version2;

  it("the rules checker is far more often right than keyword search, and never lets a wrong 'covered' through", () => {
    expect(rules?.raw.correct).toBeGreaterThan((keyword?.raw.correct ?? 0) + 100);
    expect(rules?.final.falseCompliant).toBe(0);
    expect(keyword?.final.falseCompliant).toBeGreaterThan(50);
  });

  it("the expert reviews only what is routed, for a fraction of the manual minutes", () => {
    expect(rules?.reviewed).toBeLessThan(rules?.obligations ?? 0);
    expect(rules?.minutes.tool).toBeLessThan((manual?.minutes.manual ?? 0) * 0.4);
  });

  it("version-1 rulings cut version-2 reviews without letting an error through", () => {
    expect(v2ruled?.reviewed).toBeLessThan((v2?.reviewed ?? 0) / 2);
    expect(v2ruled?.final.falseCompliant).toBe(0);
    expect(v2ruled?.byRuling).toBeGreaterThan(0);
  });
});

const url = process.env.RIF_TEST_DATABASE_URL;
const db = url ? describe : describe.skip;

db("the compliance check as a durable workflow with reviews", () => {
  let store: Store;
  let server: Server;
  let base = "";
  const run = `t${Date.now()}`;

  beforeAll(async () => {
    store = Store.connect(url as string);
    await store.migrate();
    setComplianceContext({ store, worlds: { season: buildWorld() } });
    DBOS.setConfig({ name: "rif-compliance-test", systemDatabaseUrl: `${url}_dbos` } as never);
    await DBOS.launch();
    server = app(store).listen(0);
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server?.close();
    await DBOS.shutdown();
    await store?.close();
  });

  it("records a run once; a rerun with the same id replays it", async () => {
    const start = () =>
      DBOS.startWorkflow(complianceWorkflow, { workflowID: `compliance:${run}` })({
        run,
        world: "season",
        version: 1,
      });
    const a = await (await start()).getResult();
    const b = await (await start()).getResult();
    expect(b).toEqual(a);
    const n = await store.pool.query("select count(*)::int as n from compliance_runs where id = $1", [run]);
    expect(n.rows[0].n).toBe(1);
    const f = await store.pool.query("select body from compliance_findings where run = $1", [run]);
    expect(f.rows.length).toBe(a.findings);
    expect(JSON.stringify(f.rows)).not.toMatch(/"truth"|"why"/);
  });

  it("a review needs a signed-in reviewer with an allowed role and the finding's current hash", async () => {
    const procs = (await (await fetch(`${base}/api/compliance/runs/${run}/procedures`)).json()) as {
      id: string;
      open: number;
    }[];
    const withOpen = procs.find((p) => p.open > 0) as { id: string };
    const detail = (await procedureDetail(store, run, withOpen.id)) as {
      findings: { id: string; body_hash: string; body: { route: string; steps: string[] } }[];
    };
    const f = detail.findings.find((x) => x.body.route === "review") as (typeof detail.findings)[number];
    const post = (headers: Record<string, string>, body: object) =>
      fetch(`${base}/api/compliance/runs/${run}/findings/${encodeURIComponent(f.id)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const ok = {
      bodyHash: f.body_hash,
      decision: "corrected",
      verdict: "covered",
      steps: f.body.steps,
      note: "the passive step carries it",
    };
    expect((await post({}, ok)).status).toBe(401);
    expect((await post({ "x-user-id": "u1", "x-user-role": "intern" }, ok)).status).toBe(403);
    expect(
      (await post({ "x-user-id": "u1", "x-user-role": "regulatory_affairs" }, { ...ok, bodyHash: "stale" }))
        .status,
    ).toBe(409);
    expect(
      (await post({ "x-user-id": "u1", "x-user-role": "regulatory_affairs" }, { ...ok, note: "" })).status,
    ).toBe(400);
    expect((await post({ "x-user-id": "u1", "x-user-role": "regulatory_affairs" }, ok)).status).toBe(201);
    const rulings = await store.pool.query(
      "select verdict, by_who from compliance_rulings where by_who = 'u1' order by seq desc limit 1",
    );
    expect(rulings.rows[0]).toEqual({ verdict: "covered", by_who: "u1" });
    await expect(store.pool.query("delete from compliance_reviews where run = $1", [run])).rejects.toThrow(
      /append-only/,
    );
  });
});
