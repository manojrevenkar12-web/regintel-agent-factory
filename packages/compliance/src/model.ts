/** A model reads the procedure next to the requirements and proposes a verdict, the steps and an exact
 * quote for each. Code then decides: the quote must be in the steps it names, the numbers in those
 * steps are compared with the requirement by code, and any disagreement goes to the expert with both
 * views. The reader is Claude through the CLI, Azure OpenAI over HTTPS, or any AI SDK model (Azure
 * OpenAI through @ai-sdk/azure in production). */
import { createAzure } from "@ai-sdk/azure";
import { type Reader, lastJsonObject } from "@rif/impact";
import { type LanguageModel, generateText } from "ai";
import { type Finding, type Procedure, type Verdict, checkRules, route } from "./check.js";
import type { Requirement } from "./formulate.js";
import type { ComplianceCfg } from "./parse.js";

export const SYSTEM = `You check a medical device manufacturer's procedure against regulatory requirements.
For each requirement decide one verdict:
- covered: a step makes the company do the action, with a deadline and frequency at least as strict as required
- partial: the action is there but a required deadline or frequency is missing, or the step weakens it ("where practicable", "aims to", "should")
- conflict: the step sets a longer deadline or a less frequent interval than required
- missing: no step makes the company do it (a step about another party, or one that defers the decision, does not count)
Quote the exact words from the procedure that carry your verdict. Answer with JSON only:
{"findings":[{"requirement":"<id>","verdict":"covered|partial|conflict|missing","steps":["<step id>"],"quote":"<exact words>"}]}`;

export function prompt(p: Procedure, reqs: Requirement[]): string {
  const r = reqs.map((q) => `${q.id}: ${q.text}`).join("\n");
  const s = p.steps.map((x) => `${x.id} ${x.text}`).join("\n");
  return `Procedure ${p.id}: ${p.title}\n${s}\n\nRequirements:\n${r}`;
}

type Proposal = { requirement: string; verdict: Verdict; steps: string[]; quote: string };

/** Parse what the model said; anything malformed is dropped (and the rules' finding stands). */
export function proposals(text: string): Proposal[] {
  const j = lastJsonObject(text) as { findings?: unknown } | null;
  if (!j || !Array.isArray(j.findings)) return [];
  return j.findings.filter(
    (f): f is Proposal =>
      typeof f?.requirement === "string" &&
      ["covered", "partial", "conflict", "missing"].includes(f.verdict) &&
      Array.isArray(f.steps) &&
      typeof f.quote === "string",
  );
}

/** Code's verdict over the steps the model chose: the same number and weakening rules as the checker. */
function verdictOn(
  req: Requirement,
  p: Procedure,
  stepIds: string[],
): { verdict: Verdict; days: number | null; months: number | null } {
  const steps = p.steps.filter((s) => stepIds.includes(s.id));
  const pointers = p.steps.filter((s) => s.pointsTo && stepIds.includes(s.pointsTo));
  const all = [...steps, ...pointers];
  const days = all.find((s) => s.days !== null)?.days ?? null;
  const months = all.find((s) => s.months !== null)?.months ?? null;
  let verdict: Verdict = "covered";
  if (
    (req.days !== null && days !== null && days > req.days) ||
    (req.months !== null && months !== null && months > req.months)
  )
    verdict = "conflict";
  else if (
    (req.days !== null && days === null) ||
    (req.months !== null && months === null) ||
    steps.some((s) => s.weak)
  )
    verdict = "partial";
  return { verdict, days, months };
}

/** Verify one proposal against the procedure; the result says what counts and what goes to review. */
export function verify(
  prop: Proposal | undefined,
  req: Requirement,
  p: Procedure,
  cfg: ComplianceCfg,
  by: string,
): Finding {
  const rules = checkRules(req, p, cfg);
  rules.route = route(rules, req, cfg);
  if (!prop)
    return {
      ...rules,
      reasons: [...rules.reasons, "the model gave no verdict: the rules' finding stands"],
      route: "review",
    };
  const known = prop.steps.filter((id) => p.steps.some((s) => s.id === id));
  const text = p.steps
    .filter((s) => known.includes(s.id))
    .map((s) => s.text)
    .join(" ");
  const quoted = prop.quote.trim().length > 0 && text.includes(prop.quote.trim());
  if (prop.verdict === "missing") {
    const disagree = rules.verdict !== "missing" && rules.coverage >= cfg.check.auto_cover;
    return {
      ...rules,
      verdict: "missing",
      steps: [],
      quotes: [],
      by,
      route: disagree ? "review" : "auto",
      reasons: disagree
        ? [`the model found nothing; the rules found ${rules.steps.join(", ")}`]
        : ["the model found nothing"],
    };
  }
  if (!known.length || !quoted)
    return {
      ...rules,
      by,
      route: "review",
      reasons: [...rules.reasons, "the model's quote is not in the steps it named"],
    };
  const code = verdictOn(req, p, known);
  const agree = code.verdict === prop.verdict;
  return {
    requirement: req.id,
    procedure: p.id,
    verdict: code.verdict,
    steps: known,
    quotes: known.map((id) => p.steps.find((s) => s.id === id)?.text ?? ""),
    coverage: rules.coverage,
    found: { days: code.days, months: code.months },
    reasons: agree
      ? [`quoted: "${prop.quote}"`]
      : [`the model said ${prop.verdict}; the numbers say ${code.verdict}`],
    route: agree && code.verdict === "covered" && rules.verdict === "covered" ? "auto" : "review",
    by,
  };
}

/** Read a procedure with a model in batches, then verify every proposal. */
export async function modelCheck(
  reader: Reader,
  p: Procedure,
  reqs: Requirement[],
  cfg: ComplianceCfg,
): Promise<{ findings: Finding[]; cost_usd: number; errors: string[] }> {
  const out: Finding[] = [];
  const errors: string[] = [];
  let cost = 0;
  for (let i = 0; i < reqs.length; i += cfg.model.max_obligations_per_call) {
    const batch = reqs.slice(i, i + cfg.model.max_obligations_per_call);
    const r = await reader.read(SYSTEM, prompt(p, batch));
    cost += r.cost_usd;
    if (r.error) errors.push(r.error);
    const props = proposals(r.text);
    for (const q of batch)
      out.push(
        verify(
          props.find((x) => x.requirement === q.id),
          q,
          p,
          cfg,
          reader.name,
        ),
      );
  }
  return { findings: out, cost_usd: cost, errors };
}

/** Any AI SDK language model as a reader. */
export function aiSdkReader(model: LanguageModel, name: string, usdPer1k: [number, number] = [0, 0]): Reader {
  return {
    name,
    async read(system, prompt) {
      const t0 = Date.now();
      try {
        const r = await generateText({ model, system, prompt, temperature: 0 });
        const cost =
          ((r.usage.inputTokens ?? 0) * usdPer1k[0] + (r.usage.outputTokens ?? 0) * usdPer1k[1]) / 1000;
        return { text: r.text, cost_usd: cost, model: name, seconds: (Date.now() - t0) / 1000 };
      } catch (e) {
        return { text: "", cost_usd: 0, model: name, seconds: (Date.now() - t0) / 1000, error: String(e) };
      }
    },
  };
}

/** Azure OpenAI through the AI SDK (resource, key and deployment from the environment). */
export function azureSdkReader(): Reader {
  const azure = createAzure({
    resourceName: process.env.AZURE_RESOURCE_NAME ?? "",
    apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
  });
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "";
  return aiSdkReader(azure(deployment), `azure-sdk:${deployment}`);
}
