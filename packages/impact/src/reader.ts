/** The model that reads. One small interface, three implementations: Claude through the Claude Code
 * CLI (what the measured runs used), Azure OpenAI (the production deployment target, chat
 * completions over HTTPS) and a scripted fake for tests. A reader only returns text; everything it
 * says is parsed and verified by code before it counts. */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Reading = { text: string; cost_usd: number; model: string; seconds: number; error?: string };
export type Reader = { name: string; read(system: string, prompt: string): Promise<Reading> };

/** Claude, headless, with no tools, no settings, no MCP servers, an empty working directory and an
 * environment of HOME and PATH only, and a spend cap per call. */
export function claudeReader(model: string, budgetUsd: number, timeoutS: number): Reader {
  const cwd = mkdtempSync(join(tmpdir(), "rif-read-"));
  return {
    name: `claude:${model}`,
    read: (system, prompt) =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const p = spawn(
          process.env.RIF_AGENT_BIN ?? "claude",
          [
            "-p",
            "--model",
            model,
            "--output-format",
            "json",
            "--tools",
            "",
            "--append-system-prompt",
            system,
            "--max-budget-usd",
            budgetUsd.toFixed(2),
            "--no-session-persistence",
            "--strict-mcp-config",
            "--setting-sources",
            "project",
            "--disable-slash-commands",
          ],
          {
            env: { HOME: process.env.HOME ?? "/root", PATH: process.env.PATH ?? "" },
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let out = "";
        let err = "";
        const timer = setTimeout(() => p.kill("SIGKILL"), timeoutS * 1000);
        p.stdout.on("data", (d: Buffer) => {
          out += d.toString();
        });
        p.stderr.on("data", (d: Buffer) => {
          err += d.toString();
        });
        p.on("close", () => {
          clearTimeout(timer);
          const seconds = (Date.now() - t0) / 1000;
          try {
            const j = JSON.parse(out) as {
              result?: string;
              total_cost_usd?: number;
              modelUsage?: Record<string, unknown>;
              is_error?: boolean;
            };
            resolve({
              text: j.result ?? "",
              cost_usd: Number(j.total_cost_usd ?? 0),
              model: Object.keys(j.modelUsage ?? {})[0] ?? model,
              seconds,
              error: j.is_error ? (j.result ?? "error") : undefined,
            });
          } catch {
            resolve({
              text: "",
              cost_usd: 0,
              model,
              seconds,
              error: `no JSON from the CLI: ${(out || err).slice(0, 300)}`,
            });
          }
        });
        p.stdin.end(prompt);
      }),
  };
}

/** Azure OpenAI chat completions (deployment name, endpoint and key from the environment). Not used
 * by the measured runs, which have no Azure access; covered by a test against a local stub. */
export function azureReader(opts?: {
  endpoint?: string;
  deployment?: string;
  key?: string;
  apiVersion?: string;
  usdPer1k?: [number, number];
}): Reader {
  const endpoint = opts?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? "";
  const deployment = opts?.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? "";
  const key = opts?.key ?? process.env.AZURE_OPENAI_API_KEY ?? "";
  const apiVersion = opts?.apiVersion ?? "2024-10-21";
  const [pin, pout] = opts?.usdPer1k ?? [0, 0];
  return {
    name: `azure:${deployment}`,
    async read(system, prompt) {
      const t0 = Date.now();
      const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "api-key": key },
          body: JSON.stringify({
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            temperature: 0,
          }),
        });
        const j = (await r.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens: number; completion_tokens: number };
          error?: { message: string };
        };
        const u = j.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
        return {
          text: j.choices?.[0]?.message?.content ?? "",
          cost_usd: (u.prompt_tokens * pin + u.completion_tokens * pout) / 1000,
          model: deployment,
          seconds: (Date.now() - t0) / 1000,
          error: r.ok ? undefined : (j.error?.message ?? `HTTP ${r.status}`),
        };
      } catch (e) {
        return {
          text: "",
          cost_usd: 0,
          model: deployment,
          seconds: (Date.now() - t0) / 1000,
          error: String(e),
        };
      }
    },
  };
}

/** A reader that answers from a function of the prompt: for tests. */
export function fakeReader(answer: (prompt: string) => string): Reader {
  return {
    name: "fake",
    read: async (_s, p) => ({ text: answer(p), cost_usd: 0, model: "fake", seconds: 0 }),
  };
}

/** The last JSON object in a text (models like to wrap it in prose or a code fence). */
export function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1] as string);
  for (const c of [...fenced.reverse(), text]) {
    const end = c.lastIndexOf("}");
    for (let start = c.lastIndexOf("{", end); start >= 0; start = c.lastIndexOf("{", start - 1)) {
      try {
        return JSON.parse(c.slice(start, end + 1));
      } catch {
        // keep widening
      }
    }
  }
  return null;
}
