import { createServer } from "node:http";
import type { ScrapedDoc } from "@rif/ingest";
import { describe, expect, it } from "vitest";
import {
  type Context,
  Index,
  assess,
  azureReader,
  diffVersions,
  embed,
  fakeReader,
  lastJsonObject,
  paramAgreement,
  rationaleMatch,
  readParams,
  verifyPick,
} from "../src/index.js";

const doc = (version: number, clauses: [string, string][]): ScrapedDoc => ({
  ref: "UDA-GD-2025-001",
  title: "Guidance on post-market surveillance",
  version,
  published: "2025-03-01",
  effective: "2025-03-31",
  clauses: clauses.map(([id, text]) => ({ id, text })),
});

const A = "For all devices, the manufacturer shall establish and maintain a post-market surveillance plan.";
const B =
  "For class IIb and III devices, the manufacturer shall notify the authority of a serious incident within 15 days.";
const C =
  "For class IIa, IIb and III devices, the manufacturer shall update the periodic safety update report annually.";
const D =
  "For class IIb and III devices, the manufacturer shall register the UDI in the device database within 26 days.";

describe("clause diff", () => {
  it("reads the obligation's parameters", () => {
    expect(readParams(B)).toEqual({
      modal: "shall",
      days: 15,
      frequency: null,
      classes: ["IIb", "III"],
      actor: "the manufacturer",
    });
    expect(readParams(A).classes).toEqual(["I", "IIa", "IIb", "III"]);
    expect(readParams(C).frequency).toBe("annually");
  });

  it("calls a renumbering editorial, not a removal and an addition", () => {
    const ch = diffVersions(
      doc(1, [
        ["1.1", A],
        ["1.2", B],
        ["1.3", C],
      ]),
      doc(2, [
        ["1.1", A],
        ["1.2", C],
        ["1.3", B],
      ]),
    );
    expect(ch.map((c) => [c.kind, c.rule, c.before?.id, c.after?.id])).toEqual([
      ["moved", "editorial", "1.2", "1.3"],
      ["moved", "editorial", "1.3", "1.2"],
    ]);
  });

  it("calls a changed deadline, strength or scope substantive and names the parameter", () => {
    const ch = diffVersions(
      doc(1, [
        ["1.1", A],
        ["1.2", B],
        ["1.3", C],
      ]),
      doc(2, [
        ["1.1", A.replace("shall", "should")],
        ["1.2", B.replace("15 days", "10 days")],
        ["1.3", C.replace("class IIa, IIb and III", "class IIb and III")],
      ]),
    );
    const byId = Object.fromEntries(ch.map((c) => [c.before?.id, [c.rule, c.params.changed]]));
    expect(byId).toEqual({
      "1.1": ["substantive", ["modal"]],
      "1.2": ["substantive", ["days"]],
      "1.3": ["substantive", ["classes"]],
    });
  });

  it("leaves a rewording with the same parameters to a person, even when renumbered", () => {
    const reworded =
      "The manufacturer shall, for class IIb and III devices, inform the authority about a serious incident within 15 days.";
    const ch = diffVersions(
      doc(1, [
        ["1.1", A],
        ["1.2", B],
      ]),
      doc(2, [
        ["1.1", reworded],
        ["1.2", A],
      ]),
    );
    const c = ch.find((x) => x.before?.id === "1.2");
    expect(c?.kind).toBe("modified");
    expect(c?.rule).toBe("unclear");
  });

  it("reports added and removed clauses", () => {
    const ch = diffVersions(
      doc(1, [
        ["1.1", A],
        ["1.2", B],
      ]),
      doc(2, [
        ["1.1", A],
        ["1.2", D],
      ]),
    );
    expect(ch.map((c) => c.kind).sort()).toEqual(["added", "removed"]);
    expect(ch.every((c) => c.rule === "substantive")).toBe(true);
  });
});

describe("retrieval", () => {
  it("embeds deterministically and normalised", () => {
    const v = embed("register the UDI in the device database");
    expect(v).toEqual(embed("register the UDI in the device database"));
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
  });

  it("ranks the requirement that states the obligation first", () => {
    const ix = new Index([
      { id: "r1", text: "Halden Medical must record the UDI in the device database for the infusion pump." },
      {
        id: "r2",
        text: "Halden Medical must operate and keep current a post-market surveillance plan for the infusion pump.",
      },
      { id: "r3", text: "Halden Medical must review trends in incidents for the infusion pump." },
    ]);
    expect(ix.search(D)[0]?.id).toBe("r1");
    expect(ix.search(A)[0]?.id).toBe("r2");
    expect(ix.search(A, new Set(["r1", "r3"])).map((h) => h.id)).not.toContain("r2");
  });
});

describe("evidence the matchers use", () => {
  const meta = {
    ref: "UDA-GD-2025-001",
    title: "Guidance on post-market surveillance",
    source: "uda",
    authority: "Union Device Authority",
    published: "2025-03-01",
  };
  it("scores a rationale by authority, subject and year", () => {
    const full = rationaleMatch(
      "Derived from the Union Device Authority guidance on post-market surveillance (2025).",
      meta,
    );
    const vague = rationaleMatch("Union Device Authority expectation.", meta);
    const other = rationaleMatch(
      "Derived from the Federal Device Office guidance on risk management (2023).",
      meta,
    );
    expect(full).toBeGreaterThan(vague);
    expect(vague).toBeGreaterThan(other);
    expect(rationaleMatch("", meta)).toBe(0);
  });

  it("agrees or disagrees on deadlines and recurrences", () => {
    const p = readParams(B);
    expect(
      paramAgreement(
        "Halden Medical must inform the authority of a serious incident no later than 15 calendar days after it becomes known.",
        p,
      ),
    ).toBeGreaterThan(0);
    expect(
      paramAgreement(
        "Halden Medical must inform the authority of a serious incident no later than 30 calendar days after it becomes known.",
        p,
      ),
    ).toBeLessThan(0);
  });
});

describe("model answers", () => {
  it("finds the last JSON object in prose or a fence", () => {
    expect(lastJsonObject('Sure.\n```json\n{"picks": [{"a": 1}]}\n```')).toEqual({ picks: [{ a: 1 }] });
    expect(lastJsonObject('first {"x": 1} then {"y": {"z": 2}}')).toEqual({ y: { z: 2 } });
    expect(lastJsonObject("no json here")).toBeNull();
  });

  it("calls Azure OpenAI chat completions and prices the tokens", async () => {
    let seen: { url?: string; key?: string; body?: string } = {};
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        seen = { url: req.url, key: req.headers["api-key"] as string, body };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            choices: [{ message: { content: '{"picks": []}' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 100 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const reader = azureReader({
      endpoint: `http://127.0.0.1:${port}/`,
      deployment: "gpt-x",
      key: "k",
      usdPer1k: [0.002, 0.008],
    });
    const r = await reader.read("system", "prompt");
    server.close();
    expect(r.text).toBe('{"picks": []}');
    expect(r.cost_usd).toBeCloseTo(0.0028, 6);
    expect(seen.url).toContain("/openai/deployments/gpt-x/chat/completions?api-version=");
    expect(seen.key).toBe("k");
    expect(JSON.parse(seen.body ?? "{}").messages[0].role).toBe("system");
  });
});

describe("assessment with a verifier", () => {
  const prev = doc(1, [
    ["1.1", A],
    ["1.2", B],
  ]);
  const next = doc(2, [
    ["1.1", A],
    ["1.2", B.replace("15 days", "10 days")],
  ]);
  const graph = {
    devices: [
      { id: "PMP", name: "Infusion pump", class: "IIb" },
      { id: "DRS", name: "Wound dressing", class: "I" },
    ],
    requirements: [
      {
        id: "REQ-PMP-1",
        device: "PMP",
        topic: "vigilance",
        rationale: "Derived from the Union Device Authority guidance on post-market surveillance (2025).",
        text: "Halden Medical must inform the authority of a serious incident for the infusion pump no later than 15 calendar days after it becomes known.",
      },
      {
        id: "REQ-PMP-2",
        device: "PMP",
        topic: "vigilance",
        rationale: "Federal Device Office expectation.",
        text: "Halden Medical must inform the authority of a serious incident for the infusion pump no later than 15 calendar days after it becomes known.",
      },
      {
        id: "REQ-PMP-3",
        device: "PMP",
        topic: "pms",
        rationale: "",
        text: "Halden Medical must operate and keep current a post-market surveillance plan for the infusion pump.",
      },
      {
        id: "REQ-DRS-1",
        device: "DRS",
        topic: "pms",
        rationale: "",
        text: "Halden Medical must operate and keep current a post-market surveillance plan for the wound dressing.",
      },
    ],
  };
  const otherClause =
    "For class IIb and III devices, the manufacturer shall notify the authority of a serious incident within 15 days.";
  const ctx = (answer: string): Context => ({
    graph,
    links: new Map([["REQ-PMP-2", { ref: "FDO-G-2024-002", clause: "2.1" }]]),
    index: new Index(graph.requirements.map((r) => ({ id: r.id, text: r.text }))),
    clauseText: (ref, id) =>
      ref === "FDO-G-2024-002" && id === "2.1"
        ? otherClause
        : (prev.clauses.find((c) => c.id === id)?.text ?? null),
    meta: {
      ref: prev.ref,
      title: prev.title,
      source: "uda",
      authority: "Union Device Authority",
      published: "2025-03-01",
    },
    rules: { link_agreement: 0.145, min_score: 0.35, rationale_weight: 0.5, margin: 0.08 },
    perDevice: 6,
    minSimilarity: 0.6,
    reader: fakeReader(() => answer),
  });

  const good = {
    change: "c1",
    device: "PMP",
    requirement: "REQ-PMP-1",
    quote: "Union Device Authority guidance on post-market surveillance",
    why: "rationale names this document",
  };
  const answer = (...picks: object[]) => JSON.stringify({ picks });

  it("keeps a verified pick and proposes the missing trace link", async () => {
    const a = await assess(prev, next, "model", ctx(answer(good)));
    expect(a.changes[0]?.affected.map((p) => p.requirement)).toEqual(["REQ-PMP-1"]);
    expect(a.relinks).toEqual([
      expect.objectContaining({ requirement: "REQ-PMP-1", from: null, to: { ref: prev.ref, clause: "1.2" } }),
    ]);
    expect(a.rejected).toEqual([]);
  });

  it("rejects picks that are not candidates, out of scope, misquoted or linked elsewhere", async () => {
    const a = await assess(
      prev,
      next,
      "model",
      ctx(
        answer(
          { ...good, requirement: "REQ-XYZ-9" },
          { ...good, device: "DRS", requirement: "REQ-DRS-1" },
          { ...good, quote: "words that appear nowhere at all" },
          { ...good, requirement: "REQ-PMP-2", quote: "inform the authority of a serious incident" },
        ),
      ),
    );
    expect(a.changes[0]?.affected).toEqual([]);
    expect(a.rejected.map((r) => r.reason)).toEqual([
      "REQ-XYZ-9 was not a candidate for PMP",
      "device DRS is not in scope for this change",
      "the quote is not in the requirement, its rationale or its trace link",
      "REQ-PMP-2 is linked to FDO-G-2024-002 2.1, which states this obligation too",
    ]);
  });

  it("the raw model keeps what the verifier would drop", async () => {
    const a = await assess(
      prev,
      next,
      "model-raw",
      ctx(
        answer(good, {
          ...good,
          requirement: "REQ-PMP-2",
          quote: "inform the authority of a serious incident",
        }),
      ),
    );
    expect(a.changes[0]?.affected.map((p) => p.requirement).sort()).toEqual(["REQ-PMP-1", "REQ-PMP-2"]);
  });

  it("rejects a pick whose deadline disagrees with the clause", () => {
    const c = ctx("");
    const ch = diffVersions(prev, next)[0];
    const it2 = {
      ch: ch as NonNullable<typeof ch>,
      devices: ["PMP"],
      cands: new Map([["PMP", ["REQ-PMP-3"]]]),
    };
    graph.requirements[2] = {
      ...(graph.requirements[2] as (typeof graph.requirements)[number]),
      text: "Halden Medical must inform the authority of a serious incident no later than 30 calendar days after it becomes known.",
    };
    expect(
      verifyPick(c, it2, {
        device: "PMP",
        requirement: "REQ-PMP-3",
        quote: "inform the authority of a serious incident",
      }),
    ).toBe("the requirement's deadline or recurrence disagrees with the clause");
  });

  it("accepts a linked requirement whose deadline is already out of date, and says so", async () => {
    const c = ctx(
      answer({
        change: "c1",
        device: "PMP",
        requirement: "REQ-PMP-3",
        quote: "trace link: UDA-GD-2025-001 1.2",
      }),
    );
    c.links.set("REQ-PMP-3", { ref: prev.ref, clause: "1.2" });
    const a = await assess(prev, next, "model", c);
    expect(a.changes[0]?.affected.map((p) => p.requirement)).toContain("REQ-PMP-3");
    expect(a.changes[0]?.flags.some((f) => /out of date/.test(f))).toBe(true);
  });

  it("the rules matcher picks by rationale and flags what it cannot tell apart", async () => {
    const a = await assess(prev, next, "rules", ctx(""));
    expect(a.changes[0]?.affected.map((p) => p.requirement)).toEqual(["REQ-PMP-1"]);
  });

  it("turns a widened scope into a gap, and an unparseable answer into an error", async () => {
    const widened = doc(2, [
      ["1.1", A],
      ["1.2", B.replace("class IIb and III", "class I, IIa, IIb and III")],
    ]);
    const a = await assess(prev, widened, "model", ctx("I cannot answer that."));
    expect(a.changes[0]?.gaps.map((g) => g.device)).toEqual(["DRS"]);
    expect(a.errors[0]).toMatch(/no picks/);
  });
});
