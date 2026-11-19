/** The compliance check, piece by piece: reading clauses and steps, formulating requirements, the
 * verdicts, what goes to review, when an expert's ruling is reused, and verifying a model's reading. */
import { fakeReader } from "@rif/impact";
import { MockLanguageModelV2 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  aiSdkReader,
  applyRuling,
  checkRules,
  complianceCfg,
  formulate,
  modelCheck,
  procedure,
  readClause,
  readDays,
  readStep,
  route,
  ruled,
  rulingFrom,
} from "../src/index.js";

const cfg = complianceCfg();
const clause = (ref: string, id: string, text: string) => readClause(ref, id, text, cfg);
const device = { id: "PMP", name: "Infusion pump", class: "IIb" };
const proc = (steps: string[], customer = "C1") =>
  procedure(
    {
      id: "C1-SOP-PMP-01",
      customer,
      device: "PMP",
      title: "Vigilance and incident reporting: procedure for the infusion pump",
      steps: steps.map((t, i) => ({ id: `1.${i + 1}`, text: `1.${i + 1} ${t}` })),
    },
    cfg,
  );
const reporting = () =>
  formulate(
    [
      clause(
        "UDA-1",
        "1.1",
        "For class IIa, IIb and III devices, the manufacturer shall report serious incidents to the competent authority within 15 days.",
      ) as never,
      clause(
        "FDO-2",
        "2.3",
        "The manufacturer shall, for all devices, notify each serious incident to the competent authority within 10 days.",
      ) as never,
      clause(
        "TGA-4",
        "1.2",
        "For class III devices, the manufacturer shall report serious incidents to the competent authority within 2 days.",
      ) as never,
      clause(
        "SMC-1",
        "1.4",
        "For all devices, the importer shall report serious incidents to the competent authority within 5 days.",
      ) as never,
    ],
    device,
    "Halden Medical",
    cfg,
  );

describe("reading", () => {
  it("reads a clause's scope, actor, modal, deadline and frequency", () => {
    const c = clause(
      "UDA-1",
      "1.1",
      "The manufacturer should, for class IIb and III devices, update the PSUR every six months.",
    );
    expect(c).toMatchObject({
      classes: ["IIb", "III"],
      actor: "the manufacturer",
      modal: "should",
      days: null,
      months: 6,
    });
    expect(c?.action).toBe("update the PSUR");
  });

  it("reads deadlines in digits and in words, and ignores units it does not know", () => {
    expect(readDays("within ten (10) calendar days")).toBe(10);
    expect(readDays("no later than twenty-five days after becoming aware")).toBe(25);
    expect(readDays("within two weeks")).toBeNull();
  });

  it("reads weakening, deferral, other parties and a step that points back", () => {
    expect(readStep("1", "Where practicable, R&D fixes critical vulnerabilities.", cfg).weak).toBe(true);
    expect(readStep("1", "The importer reports each serious incident.", cfg).otherParty).toBe(true);
    expect(
      readStep(
        "1",
        "QA records whether a PSUR is needed; the decision itself is taken under a separate procedure.",
        cfg,
      ).deferred,
    ).toBe(true);
    expect(readStep("1", "The activity in 8.4 is completed within 3 days.", cfg)).toMatchObject({
      pointsTo: "8.4",
      days: 3,
    });
  });
});

describe("formulating requirements", () => {
  it("merges the same action from several documents, keeps the strictest number, lists every source", () => {
    const reqs = reporting();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.days).toBe(10); // 15 and 10 apply to class IIb; 2 is for class III only
    expect(reqs[0]?.sources.map((s) => s.ref).sort()).toEqual(["FDO-2", "UDA-1"]);
    expect(reqs[0]?.text).toMatch(/^Halden Medical shall .* within 10 days\.$/);
  });
});

describe("checking a procedure", () => {
  const req = () => reporting()[0] as NonNullable<ReturnType<typeof reporting>[0]>;

  it("covered when the step is as strict or stricter, conflict when looser, partial without a deadline", () => {
    const v = (step: string) => checkRules(req(), proc([step]), cfg).verdict;
    expect(v("The vigilance officer notifies the authority of each serious incident within 7 days.")).toBe(
      "covered",
    );
    expect(
      v("The vigilance officer reports each serious incident to the competent authority within 30 days."),
    ).toBe("conflict");
    expect(v("The vigilance officer reports each serious incident to the competent authority.")).toBe(
      "partial",
    );
    expect(
      v(
        "Where practicable, the vigilance officer reports serious incidents to the competent authority within 5 days.",
      ),
    ).toBe("partial");
  });

  it("takes the deadline from a later step that points back", () => {
    const f = checkRules(
      req(),
      proc([
        "Regulatory Affairs reports each serious incident to the competent authority.",
        "The activity in 1.1 is completed within ten (10) days.",
      ]),
      cfg,
    );
    expect(f).toMatchObject({ verdict: "covered", steps: ["1.1", "1.2"], found: { days: 10 } });
  });

  it("a look-alike step for another party is not coverage, and the expert is told why", () => {
    const f = checkRules(
      req(),
      proc(["The importer reports each serious incident to the competent authority within 5 days."]),
      cfg,
    );
    expect(f.verdict).toBe("missing");
    expect(f.reasons.join(" ")).toMatch(/another party/);
    expect(route(f, req(), cfg)).toBe("review");
  });

  it("accepts unreviewed only strong, explicit coverage", () => {
    const strong = checkRules(
      req(),
      proc(["The vigilance officer reports serious incidents to the competent authority within 5 days."]),
      cfg,
    );
    expect(route(strong, req(), cfg)).toBe("auto");
    const conflict = checkRules(
      req(),
      proc(["The vigilance officer reports serious incidents to the competent authority within 50 days."]),
      cfg,
    );
    expect(route(conflict, req(), cfg)).toBe("review");
  });
});

describe("expert rulings", () => {
  const req = () => reporting()[0] as NonNullable<ReturnType<typeof reporting>[0]>;
  const text = "Serious incidents are reported to the authority by regulatory affairs within 5 days.";

  it("are reused on the very same words, and not when a word that changes the verdict is added", () => {
    const p1 = proc([text]);
    const f1 = checkRules(req(), p1, cfg);
    const r = rulingFrom(f1, req(), p1, "covered", "expert", "passive voice: covered", [text]);
    const same = proc([text]);
    expect(ruled(checkRules(req(), same, cfg), req(), same, [r])).not.toBeNull();
    const weakened = proc([`Where practicable, ${text.charAt(0).toLowerCase()}${text.slice(1)}`]);
    expect(ruled(checkRules(req(), weakened, cfg), req(), weakened, [r])).toBeNull();
    const other = proc([text], "C2");
    expect(ruled(checkRules(req(), other, cfg), req(), other, [r])).toBeNull();
    expect(applyRuling(f1, r)).toMatchObject({ verdict: "covered", route: "ruling" });
  });

  it("a confirmed gap is reused only while the procedure is unchanged", () => {
    const p1 = proc(["Purpose: this procedure describes vigilance."]);
    const f = checkRules(req(), p1, cfg);
    const r = rulingFrom(f, req(), p1, "missing", "expert", "not there", []);
    expect(ruled(f, req(), p1, [r])).not.toBeNull();
    const p2 = proc(["Purpose: this procedure describes vigilance.", "Scope: all markets."]);
    expect(ruled(checkRules(req(), p2, cfg), req(), p2, [r])).toBeNull();
  });
});

describe("a model's reading, verified by code", () => {
  const req = () => reporting()[0] as NonNullable<ReturnType<typeof reporting>[0]>;
  const p = () =>
    proc(["The vigilance officer notifies the authority of each serious incident within 30 days."]);
  const said = (verdict: string, quote: string, steps = ["1.1"]) =>
    fakeReader(() => JSON.stringify({ findings: [{ requirement: req().id, verdict, steps, quote }] }));

  it("code recomputes the numbers: a model that calls a 30-day step covered is overruled and the expert sees both", async () => {
    const { findings } = await modelCheck(said("covered", "within 30 days"), p(), [req()], cfg);
    expect(findings[0]).toMatchObject({ verdict: "conflict", route: "review" });
    expect(findings[0]?.reasons[0]).toMatch(/model said covered; the numbers say conflict/);
  });

  it("a quote that is not in the named step does not count", async () => {
    const { findings } = await modelCheck(said("covered", "within 5 days"), p(), [req()], cfg);
    expect(findings[0]?.route).toBe("review");
    expect(findings[0]?.reasons.join(" ")).toMatch(/quote is not in the steps/);
  });

  it("any AI SDK model can be the reader (Azure OpenAI in production)", async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              findings: [
                { requirement: req().id, verdict: "conflict", steps: ["1.1"], quote: "within 30 days" },
              ],
            }),
          },
        ],
        finishReason: "stop",
        usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
        warnings: [],
      }),
    });
    const reader = aiSdkReader(model, "mock", [0.002, 0.008]);
    const { findings, cost_usd } = await modelCheck(reader, p(), [req()], cfg);
    expect(findings[0]).toMatchObject({ verdict: "conflict", by: "mock" });
    expect(cost_usd).toBeCloseTo(0.0028, 6);
  });
});
