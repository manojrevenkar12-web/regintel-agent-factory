/** A coding-agent session (Claude Code, headless) in a sandbox directory.
 *
 * Least privilege: file tools confined to the sandbox (--restricted); the shell may run only the
 * commands the role allows; anything else is refused without asking and recorded as a denial. The
 * session starts with an empty environment (HOME and PATH), no user settings, skills or MCP servers,
 * and a hard spend cap. The reviewer role gets read-only tools.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "repair" | "review";

export type Session = {
  ok: boolean;
  error: string;
  result: string;
  cost_usd: number;
  turns: number;
  tool_calls: number;
  checks_run: number; // how often the agent ran the check command itself
  denials: number;
  tokens_in: number;
  tokens_out: number;
  seconds: number;
  model: string;
};

export const TOOLS: Record<Role, { tools: string; allowed: string[] }> = {
  repair: {
    tools: "Read,Edit,Write,Glob,Grep,Bash",
    allowed: ["Read", "Edit", "Write", "Glob", "Grep", "Bash(rif-check:*)", "Bash(ls:*)"],
  },
  review: { tools: "Read,Glob,Grep", allowed: ["Read", "Glob", "Grep"] },
};

export function command(role: Role, model: string, budget: number): string[] {
  return [
    process.env.RIF_AGENT_BIN ?? "claude",
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--restricted",
    "--tools",
    TOOLS[role].tools,
    "--allowedTools",
    ...TOOLS[role].allowed,
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    budget.toFixed(2),
  ];
}

export function parseStream(lines: string[]): Omit<Session, "seconds"> {
  const s: Omit<Session, "seconds"> = {
    ok: false,
    error: "",
    result: "",
    cost_usd: 0,
    turns: 0,
    tool_calls: 0,
    checks_run: 0,
    denials: 0,
    tokens_in: 0,
    tokens_out: 0,
    model: "",
  };
  let sawResult = false;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") s.model = String(ev.model ?? "");
    if (ev.type === "assistant") {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as {
        type: string;
        name?: string;
        input?: { command?: string };
      }[];
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        s.tool_calls++;
        if (c.name === "Bash" && /\brif-check\b/.test(c.input?.command ?? "")) s.checks_run++;
      }
    } else if (ev.type === "result") {
      sawResult = true;
      const u = (ev.usage ?? {}) as Record<string, number>;
      s.ok = ev.subtype === "success" && !ev.is_error;
      s.error = s.ok ? "" : String(ev.subtype ?? "error");
      s.result = String(ev.result ?? "");
      s.cost_usd = Number(ev.total_cost_usd ?? 0);
      s.turns = Number(ev.num_turns ?? 0);
      s.tokens_in =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      s.tokens_out = u.output_tokens ?? 0;
      s.denials = ((ev.permission_denials as unknown[]) ?? []).length;
    }
  }
  if (!sawResult && lines.length) s.error = "ended without a result";
  return s;
}

export function runAgent(opts: {
  role: Role;
  prompt: string;
  cwd: string;
  binDir?: string;
  model: string;
  budget: number;
  timeoutS: number;
  transcript: string;
}): Promise<Session> {
  mkdirSync(dirname(opts.transcript), { recursive: true });
  const [bin, ...args] = command(opts.role, opts.model, opts.budget);
  const env: Record<string, string> = {
    HOME: process.env.HOME ?? "/root",
    PATH: `${opts.binDir ? `${opts.binDir}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`,
  };
  for (const k of ["RIF_FAKE_AGENT", "RIF_FAKE_EDIT"]) if (process.env[k]) env[k] = process.env[k] as string;
  const t0 = Date.now();
  return new Promise((resolve) => {
    // the prompt goes on stdin: command lines are visible to every process on the machine
    const p = spawn(bin as string, args, {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const out = createWriteStream(opts.transcript);
    const lines: string[] = [];
    let buf = "";
    let err = "";
    let timedOut = false;
    p.stdout.on("data", (d: Buffer) => {
      out.write(d);
      buf += d.toString();
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      lines.push(...parts);
    });
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(p.pid as number), "SIGKILL");
      } catch {}
    }, opts.timeoutS * 1000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (buf) lines.push(buf);
      out.end();
      const s: Session = { ...parseStream(lines), seconds: Math.round((Date.now() - t0) / 1000) };
      if (timedOut) {
        s.ok = false;
        s.error = "timeout";
        s.cost_usd = Math.max(s.cost_usd, opts.budget); // a killed session reports no cost
      } else if (!lines.length) s.error = `no output (exit ${code}): ${err.trim().slice(0, 300)}`;
      resolve(s);
    });
    p.stdin.end(opts.prompt);
  });
}

/** The last JSON object in a model's final message. */
export function lastJson<T = Record<string, unknown>>(text: string): T | null {
  const matches = [...text.matchAll(/\{[^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*\}/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i]?.[0] ?? "") as T;
    } catch {}
  }
  return null;
}
