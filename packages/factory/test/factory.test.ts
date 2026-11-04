/** The factory end to end with a scripted agent in place of Claude Code: a real drift, a real
 * sandbox, the real gates and the real decision. Only the model is fake. */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrawlData, ROOT, crawl, httpFetch, loadScraper, materialize } from "@rif/ingest";
import { buildWorld, layoutOf, referenceScraper, serveWorld } from "@rif/world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOLS, command, evidenceCrawl, lastJson, parseStream, repair, staticFlags } from "../src/index.js";
import type { Incident } from "../src/sandbox.js";

const tmp = mkdtempSync(join(tmpdir(), "rif-factory-"));
const w = buildWorld();
const src = w.sources.find((s) => s.drifts.some((d) => d.loud)) as (typeof w.sources)[number];
const drift = src.drifts.find((d) => d.loud) as (typeof src.drifts)[number];
const day = drift.day;
let server: Awaited<ReturnType<typeof serveWorld>>;
let inc: Incident;
const before = referenceScraper(src.id, src.ref_prefix, layoutOf(src, day - 1));
const after = referenceScraper(src.id, src.ref_prefix, layoutOf(src, day));
const file = (name: string, code: string) => {
  const p = join(tmp, name);
  writeFileSync(p, code);
  return p;
};

beforeAll(async () => {
  server = await serveWorld(w);
  const run = async (d: number, prev: CrawlData | null) => {
    server.setDay(d);
    const rec = new Map();
    const scraper = await loadScraper(materialize(before, join(tmp, `before-${d}.ts`)));
    return crawl(src.id, scraper, httpFetch(server.url, src.id, rec), rec, w.date(d), prev);
  };
  const good = await run(day - 1, null);
  const o = await run(day, good.data);
  expect(o.status).toBe("failed");
  server.setDay(day);
  inc = {
    id: `test-${src.id}-${day}`,
    source: src.id,
    day,
    today: w.date(day),
    findings: o.findings,
    lastGood: good.data,
    pages: await evidenceCrawl(server.url, src.id),
  };
  process.env.RIF_AGENT_BIN = join(ROOT, "packages/factory/test/fake-agent.mjs");
});
afterAll(async () => {
  await server?.close();
  for (const k of ["RIF_AGENT_BIN", "RIF_FAKE_AGENT", "RIF_FAKE_EDIT"]) delete process.env[k];
});

const setup = { name: "test", model: "fake", gates: true, review: true };

describe("a repair", () => {
  it("deploys a correct fix once every gate passes and the reviewer approves", async () => {
    process.env.RIF_FAKE_AGENT = "edit";
    process.env.RIF_FAKE_EDIT = file("good.ts", after);
    const r = await repair(inc, before, setup, join(tmp, "run-good"));
    expect(r.decision).toBe("deployed");
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]?.gates.gates.every((g) => g.ok)).toBe(true);
    expect(r.code).toBe(after);
    expect(r.attempts[0]?.session.checks_run).toBe(1);
  }, 180_000);

  it("never deploys a fix that hard-codes data, however well it scores", async () => {
    const ref = inc.lastGood?.items[0]?.ref as string;
    process.env.RIF_FAKE_AGENT = "edit";
    process.env.RIF_FAKE_EDIT = file("gamed.ts", `${after}\nexport const KNOWN = ["${ref}"];\n`);
    const r = await repair(inc, before, setup, join(tmp, "run-gamed"));
    expect(r.decision).toBe("escalated");
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]?.gates.gates.find((g) => g.name === "no gaming")?.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.firstAttemptCode).toContain(ref); // what an ungated pipeline would have shipped
  }, 180_000);

  it("escalates when the reviewer says a person should look", async () => {
    process.env.RIF_FAKE_AGENT = "edit";
    process.env.RIF_FAKE_EDIT = file("doubtful.ts", `${after}\n// REVIEW: escalate\n`);
    const r = await repair(inc, before, setup, join(tmp, "run-review"));
    expect(r.decision).toBe("escalated");
    expect(r.reason).toMatch(/reviewer escalated/);
  }, 180_000);

  it("stops at once when the agent finds no scraper fault and changes nothing", async () => {
    process.env.RIF_FAKE_AGENT = "escalate";
    const r = await repair(inc, before, setup, join(tmp, "run-handback"));
    expect(r.decision).toBe("escalated");
    expect(r.attempts).toHaveLength(1);
    expect(r.reason).toMatch(/no scraper fault/);
  }, 180_000);

  it("keeps the agent's sandbox free of the world and its truth", async () => {
    process.env.RIF_FAKE_AGENT = "escalate";
    await repair(inc, before, setup, join(tmp, "run-sandbox"));
    const { execFileSync } = await import("node:child_process");
    const files = execFileSync("find", [
      join(tmp, "run-sandbox", "sandboxes"),
      "-type",
      "f",
      "-not",
      "-path",
      "*/node_modules/*",
    ]).toString();
    expect(files).not.toMatch(/world|truth|company/);
    const wrapper = files.split("\n").find((f) => f.endsWith("bin/rif-check")) as string;
    expect(readFileSync(wrapper, "utf8")).toMatch(/env -i/);
  }, 180_000);
});

describe("the agent's least privilege", () => {
  it("restricts the repair role to file tools and one check command, and the reviewer to reading", () => {
    const c = command("repair", "sonnet", 1.5);
    expect(c).toEqual(
      expect.arrayContaining([
        "--restricted",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--no-session-persistence",
      ]),
    );
    expect(c[c.indexOf("--max-budget-usd") + 1]).toBe("1.50");
    expect(TOOLS.repair.allowed.filter((t) => t.startsWith("Bash"))).toEqual([
      "Bash(rif-check:*)",
      "Bash(ls:*)",
    ]);
    expect(TOOLS.review.tools).toBe("Read,Glob,Grep");
  });

  it("reads the CLI's stream: cost, turns, denials, self-checks", () => {
    const s = parseStream([
      '{"type":"system","subtype":"init","model":"m"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"rif-check"}}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.2,"num_turns":3,"usage":{"input_tokens":5,"output_tokens":2},"permission_denials":[{}]}',
    ]);
    expect(s).toMatchObject({
      ok: true,
      model: "m",
      cost_usd: 0.2,
      turns: 3,
      checks_run: 1,
      denials: 1,
      tokens_in: 5,
    });
    expect(parseStream(['{"type":"system","subtype":"init"}']).error).toBe("ended without a result");
    expect(lastJson('text {"verdict": "approve", "issues": []}')).toEqual({ verdict: "approve", issues: [] });
  });

  it("flags gaming in a diff", () => {
    const data = {
      items: [{ ref: "UDA-GD-2025-001", title: "t", url: "/doc/x", published: "2025-01-01" }],
      docs: [],
    };
    const old = 'if (!m) throw new Error("bad");\n';
    expect(staticFlags(old, 'const r = "UDA-GD-2025-001";\n', data)).toEqual(
      expect.arrayContaining([
        "hard-codes the reference UDA-GD-2025-001",
        "removes 1 validation(s) that threw on unexpected input",
      ]),
    );
    expect(staticFlags("", "try { x() } catch (e) { return []; }\nconst d = Date.parse(s);\n", data)).toEqual(
      expect.arrayContaining([
        "swallows errors in a catch block",
        "parses dates leniently with Date.parse or new Date(string)",
      ]),
    );
  });
});
