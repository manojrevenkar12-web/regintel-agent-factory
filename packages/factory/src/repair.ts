/** Repair a broken scraper: a coding agent in the incident sandbox, the gates outside it, a separate
 * reviewer, and a decision that deploys only when all of them agree. A failed gate goes back to the
 * agent once with the gate's findings; after that a person takes over. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page, ROOT } from "@rif/ingest";
import { parse } from "yaml";
import { type Session, lastJson, runAgent } from "./agent.js";
import { type GateReport, runGates, unifiedDiff } from "./gates.js";
import { type Incident, makeSandbox, splitPages } from "./sandbox.js";

export type FactoryCfg = {
  work_dir: string;
  docs_visible: number;
  max_attempts: number;
  repair: { budget_usd: number; timeout_s: number };
  review: { model: string; budget_usd: number; timeout_s: number };
  setups: Setup[];
  escalation: { human_delay_days: number; human_hours_per_incident: number };
};
export type Setup = { name: string; model: string; gates: boolean; review: boolean };
export const factoryCfg = (): FactoryCfg =>
  parse(readFileSync(join(ROOT, "config/factory.yaml"), "utf8")) as FactoryCfg;

export type Review = {
  verdict: "approve" | "request_changes" | "escalate";
  issues: string[];
  session: Session;
};
export type Attempt = {
  session: Session;
  code: string;
  diff: string;
  gates: GateReport;
  review: Review | null;
  claim: string;
};
export type Decision = "deployed" | "escalated";
export type RepairRecord = {
  incident: string;
  source: string;
  day: number;
  setup: string;
  attempts: Attempt[];
  decision: Decision;
  reason: string;
  code: string | null; // what was deployed
  firstAttemptCode: string; // what an ungated pipeline would have deployed
  firstAttemptSelfCheck: boolean; // the agent's own check passed on its first attempt
  cost_usd: number;
  seconds: number;
};

export function repairPrompt(inc: Incident, feedback: string | null): string {
  return `You maintain the scraper for the regulator website "${inc.source}" in a regulatory-intelligence platform for medical device companies. Today (${inc.today}) the scraper's crawl failed its contract, most likely because the site changed its layout. Production data for this source is frozen until you fix it.

Read INCIDENT.md first. Then fix \`scrapers/${inc.source}.ts\` so it extracts every document correctly from pages like the ones in \`snapshots.json\`. Make changes with the Edit or Write tool. To check your work, run \`rif-check\` on its own: it is the only shell command available, and it cannot be combined with others.

Rules:
- Change only \`scrapers/${inc.source}.ts\`.
- Extract what the pages say. Never hard-code references, dates or clause texts, and never swallow errors: a scraper that fails loudly is better than one that returns wrong data.
- Parse dates exactly in the format the site now uses; do not guess between day-first and month-first.
- Documents whose version did not change must come out exactly as in \`last-good.json\`.
- The pages you see are a sample: your scraper will be checked on every page the site serves today.
- Not every failed contract is a scraper fault. If the pages show that the site's content really
  changed (documents withdrawn, a published clause corrected in place) and the scraper reads it
  correctly, do not change the scraper: a person must confirm such changes.
${feedback ? `\nYour previous fix was rejected. What the checks found:\n${feedback}\n` : ""}
When you are done, end with one line: DONE: <one sentence on what changed on the site and what you changed>.
If the scraper is not at fault, end instead with: ESCALATE: <one sentence on what really changed>.`;
}

export function reviewPrompt(inc: Incident): string {
  return `You review a proposed fix to a production scraper for a regulated medical-device data platform. Wrong data here goes into compliance decisions, so a fix that is wrong but passes checks is worse than no fix.

In this directory: INCIDENT.md (what broke), before.ts and after.ts (the scraper before and after the fix), fix.diff, gates.json (results of the automated checks, including pages the author never saw), and sample-pages.json (pages from the site today).

Look for: hard-coded data, swallowed errors, lenient or ambiguous date parsing (day-first vs month-first), selectors that match only the sample, pagination that stops early, validation that was removed, and anything that would silently drop or alter documents or clauses.

Answer with one JSON object on the last line:
{"verdict": "approve" | "request_changes" | "escalate", "issues": ["..."]}
Use "escalate" when a person should look before this goes to production.`;
}

export async function repair(
  inc: Incident,
  currentCode: string,
  setup: Setup,
  runDirIn: string,
): Promise<RepairRecord> {
  const cfg = factoryCfg();
  const runDir = resolve(runDirIn);
  const t0 = Date.now();
  const { visible } = splitPages(inc.pages, cfg.docs_visible);
  const sb = makeSandbox(join(runDir, "sandboxes"), inc, currentCode, visible);
  const attempts: Attempt[] = [];
  let feedback: string | null = null;
  let decision: Decision = "escalated";
  let reason = "";
  let deployed: string | null = null;
  for (let a = 1; a <= cfg.max_attempts; a++) {
    const session = await runAgent({
      role: "repair",
      prompt: repairPrompt(inc, feedback),
      cwd: sb.dir,
      binDir: sb.bin,
      model: setup.model,
      budget: cfg.repair.budget_usd,
      timeoutS: cfg.repair.timeout_s,
      transcript: join(runDir, "transcripts", `${inc.id}-repair-${a}.jsonl`),
    });
    const code = readFileSync(sb.scraper, "utf8");
    const gates = runGates(
      sb,
      inc.source,
      currentCode,
      visible,
      inc.pages,
      inc.lastGood,
      inc.today,
      join(runDir, "gates", `${inc.id}-${a}`),
    );
    const diff = unifiedDiff(currentCode, code);
    let review: Review | null = null;
    if (setup.review && gates.ok && code !== currentCode)
      review = await reviewFix(
        inc,
        currentCode,
        code,
        diff,
        gates,
        join(runDir, "reviews", `${inc.id}-${a}`),
        cfg,
      );
    const claim = (session.result.match(/(?:DONE|ESCALATE):\s*(.+)/)?.[1] ?? "").trim();
    const handBack = /ESCALATE:/.test(session.result);
    attempts.push({ session, code, diff, gates, review, claim });
    if (handBack && code === currentCode) {
      reason = `the agent found no scraper fault: ${claim}`;
      break;
    }
    if (!setup.gates) {
      decision = "deployed";
      reason = "deployed without gates (baseline)";
      deployed = code;
      break;
    }
    if (gates.ok && (!review || review.verdict === "approve")) {
      decision = "deployed";
      reason = review ? "every gate passed and the reviewer approved" : "every gate passed";
      deployed = code;
      break;
    }
    if (review && review.verdict === "escalate") {
      reason = `the reviewer escalated: ${review.issues.slice(0, 2).join("; ")}`;
      break;
    }
    feedback = [
      ...gates.gates.filter((g) => !g.ok).map((g) => `- gate "${g.name}": ${g.detail}`),
      ...(review && review.verdict !== "approve" ? review.issues.map((i) => `- reviewer: ${i}`) : []),
    ].join("\n");
    reason = `attempt ${a} rejected: ${feedback.split("\n")[0]?.slice(2) ?? ""}`;
  }
  const first = attempts[0] as Attempt;
  return {
    incident: inc.id,
    source: inc.source,
    day: inc.day,
    setup: setup.name,
    attempts,
    decision,
    reason,
    code: deployed,
    firstAttemptCode: first.code,
    firstAttemptSelfCheck:
      !!first.gates.check &&
      !first.gates.check.exception &&
      !first.gates.check.findings.some((f) => f.level === "error"),
    cost_usd: attempts.reduce((s, x) => s + x.session.cost_usd + (x.review?.session.cost_usd ?? 0), 0),
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

async function reviewFix(
  inc: Incident,
  before: string,
  after: string,
  diff: string,
  gates: GateReport,
  dir: string,
  cfg: FactoryCfg,
): Promise<Review> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "before.ts"), before);
  writeFileSync(join(dir, "after.ts"), after);
  writeFileSync(join(dir, "fix.diff"), diff);
  writeFileSync(
    join(dir, "gates.json"),
    JSON.stringify(
      { gates: gates.gates, flags: gates.staticFlags, findings: gates.hidden?.findings ?? [] },
      null,
      1,
    ),
  );
  const sample: Record<string, Page> = {};
  for (const [k, p] of Object.entries(inc.pages).slice(0, 6)) sample[k] = p;
  writeFileSync(join(dir, "sample-pages.json"), JSON.stringify(sample, null, 1));
  writeFileSync(
    join(dir, "INCIDENT.md"),
    `${inc.source} on ${inc.today}\n\n${inc.findings.map((f) => `- ${f.check}: ${f.detail}`).join("\n")}\n`,
  );
  const session = await runAgent({
    role: "review",
    prompt: reviewPrompt(inc),
    cwd: dir,
    model: cfg.review.model,
    budget: cfg.review.budget_usd,
    timeoutS: cfg.review.timeout_s,
    transcript: join(dir, "review.jsonl"),
  });
  const j = lastJson<{ verdict?: string; issues?: string[] }>(session.result);
  const verdict =
    j?.verdict === "approve" || j?.verdict === "request_changes" || j?.verdict === "escalate"
      ? j.verdict
      : "escalate";
  return {
    verdict,
    issues: (j?.issues ?? (j ? [] : ["the reviewer gave no verdict"])).map(String).slice(0, 8),
    session,
  };
}
