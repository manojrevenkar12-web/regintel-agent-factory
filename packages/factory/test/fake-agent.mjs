#!/usr/bin/env node
// A stand-in for the Claude Code CLI in tests: same arguments, same stream-json output.
//   RIF_FAKE_AGENT=edit      the repair role copies RIF_FAKE_EDIT over the scraper
//   RIF_FAKE_AGENT=escalate  the repair role changes nothing and hands the incident back
//   the review role approves, unless RIF_FAKE_EDIT's file contains "REVIEW: escalate"
import { copyFileSync, readFileSync, readdirSync } from "node:fs";
const args = process.argv.slice(2);
const tools = args[args.indexOf("--tools") + 1] ?? "";
let prompt = "";
process.stdin.on("data", (d) => {
  prompt += d;
});
process.stdin.on("end", () => {
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  out({ type: "system", subtype: "init", model: "fake-model" });
  const mode = process.env.RIF_FAKE_AGENT ?? "edit";
  let result;
  if (tools.includes("Edit")) {
    if (mode === "edit") {
      const [file] = readdirSync("scrapers");
      copyFileSync(process.env.RIF_FAKE_EDIT, `scrapers/${file}`);
      out({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "rif-check" } }] },
      });
      result = "I changed the selectors.\nDONE: the site changed and I updated the scraper.";
    } else result = "The listing really shrank.\nESCALATE: the regulator withdrew documents.";
  } else {
    const code = process.env.RIF_FAKE_EDIT ? readFileSync(process.env.RIF_FAKE_EDIT, "utf8") : "";
    const verdict = code.includes("REVIEW: escalate") ? "escalate" : "approve";
    result = `Looked at it.\n{"verdict": "${verdict}", "issues": []}`;
  }
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    total_cost_usd: 0.01,
    num_turns: 2,
    usage: { input_tokens: 10, output_tokens: 5 },
    permission_denials: [],
  });
});
