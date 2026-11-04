/** What stands between an agent's repair and production. Every gate is deterministic and runs
 * outside the sandbox: the agent cannot see the hidden pages or change the checks. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CrawlData, type Finding, type Page, ROOT, materialize } from "@rif/ingest";
import { type Sandbox, hash } from "./sandbox.js";

export type CheckResult = {
  listed: number;
  read: number;
  skipped: number;
  exception: string | null;
  findings: Finding[];
  data: CrawlData;
};
export type Gate = { name: string; ok: boolean; detail: string };
export type GateReport = {
  ok: boolean;
  gates: Gate[];
  check: CheckResult | null;
  hidden: CheckResult | null;
  staticFlags: string[];
};

const tsx = () => join(ROOT, "node_modules/.bin/tsx");

/** Run the production check (the repository's own check.ts and contract, never the sandbox copies). */
export function runCheck(
  cwd: string,
  snapshotsPath: string,
  prevPath: string,
  scraperFile: string,
): CheckResult {
  const args = [
    join(ROOT, "packages/ingest/src/check.ts"),
    snapshotsPath,
    "--json",
    "--prev",
    prevPath,
    "--scraper",
    scraperFile,
  ];
  const r = spawnSync(tsx(), args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp", RIF_ROOT: ROOT },
  });
  const line = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as CheckResult;
  } catch {
    return {
      listed: 0,
      read: 0,
      skipped: 0,
      exception: `check did not run: ${(r.stderr ?? "").slice(-400)}`,
      findings: [],
      data: { items: [], docs: [] },
    };
  }
}

const errors = (c: CheckResult | null) => (c ? c.findings.filter((f) => f.level === "error") : []);
const passed = (c: CheckResult | null) => !!c && !c.exception && errors(c).length === 0 && c.listed > 0;

/** Signs of a repair that makes the checks pass without making the scraper right. */
export function staticFlags(oldCode: string, newCode: string, data: CrawlData | null): string[] {
  const flags: string[] = [];
  const added = newCode.split("\n").filter((l) => !oldCode.includes(l));
  const addedText = added.join("\n");
  for (const it of data?.items ?? []) {
    if (addedText.includes(`"${it.ref}"`) || addedText.includes(`'${it.ref}'`))
      flags.push(`hard-codes the reference ${it.ref}`);
  }
  if (/["'`]\d{4}-\d{2}-\d{2}["'`]|["'`]\d{2}[./]\d{2}[./]\d{4}["'`]/.test(addedText))
    flags.push("hard-codes a date");
  if (/catch\s*(\([^)]*\))?\s*\{\s*(return\s*(\[\]|null|undefined|""|\{\})?;?\s*)?\}/.test(addedText))
    flags.push("swallows errors in a catch block");
  if (/\bDate\.parse\(|new Date\((?!Date\.UTC)[^)]/.test(addedText))
    flags.push("parses dates leniently with Date.parse or new Date(string)");
  const throwsBefore = (oldCode.match(/\bthrow\b/g) ?? []).length;
  const throwsAfter = (newCode.match(/\bthrow\b/g) ?? []).length;
  if (throwsAfter < throwsBefore)
    flags.push(`removes ${throwsBefore - throwsAfter} validation(s) that threw on unexpected input`);
  return [...new Set(flags)];
}

const BLOCKING = /hard-codes|swallows/;

export function runGates(
  sb: Sandbox,
  source: string,
  oldCode: string,
  visible: Record<string, Page>,
  allPages: Record<string, Page>,
  lastGood: CrawlData | null,
  today: string,
  gateDir: string,
): GateReport {
  const gates: Gate[] = [];
  // 1. scope: only the scraper changed
  const changedLocked = Object.entries(sb.locked)
    .filter(([f, h]) => !existsSync(join(sb.dir, f)) || hash(readFileSync(join(sb.dir, f), "utf8")) !== h)
    .map(([f]) => f);
  const extra = readdirSync(join(sb.dir, "scrapers")).filter((f) => f !== `${source}.ts`);
  gates.push({
    name: "scope",
    ok: !changedLocked.length && !extra.length,
    detail:
      changedLocked.length || extra.length
        ? `changed or added: ${[...changedLocked, ...extra].join(", ")}`
        : "only the scraper changed",
  });
  const newCode = readFileSync(sb.scraper, "utf8");
  // the gates run a copy of the repaired scraper against the original helpers and checks
  mkdirSync(gateDir, { recursive: true });
  const frozen = join(gateDir, `${source}.ts`);
  materialize(newCode, frozen);
  const prevPath = join(gateDir, "last-good.json");
  writeFileSync(prevPath, JSON.stringify(lastGood ?? { items: [], docs: [] }));
  const visiblePath = join(gateDir, "visible-pages.json");
  writeFileSync(visiblePath, JSON.stringify({ source, today, pages: visible }));
  // 2. type check
  const tc = spawnSync(join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], {
    cwd: sb.dir,
    encoding: "utf8",
    timeout: 180_000,
  });
  const tcErrors = `${tc.stdout}${tc.stderr}`.split("\n").filter((l) => /error TS/.test(l));
  gates.push({
    name: "typecheck",
    ok: tc.status === 0,
    detail: tc.status === 0 ? "passes" : tcErrors.slice(0, 3).join("; ") || "tsc failed",
  });
  // 3. the pages the agent saw
  const check = runCheck(gateDir, visiblePath, prevPath, frozen);
  gates.push({ name: "contract on the agent's pages", ok: passed(check), detail: summary(check) });
  // 4. every page of the site today, including the ones the agent never saw
  const allPath = join(gateDir, "all-pages.json");
  writeFileSync(allPath, JSON.stringify({ source, today, pages: allPages }));
  const hidden = runCheck(gateDir, allPath, prevPath, frozen);
  gates.push({
    name: "contract on every page",
    ok: passed(hidden) && hidden.skipped === 0,
    detail: `${summary(hidden)}${hidden.skipped ? `, ${hidden.skipped} listed document(s) missing from the evidence` : ""}`,
  });
  // 5. static signs of a fix that games the checks
  const flags = staticFlags(oldCode, newCode, hidden.data);
  const blocking = flags.filter((f) => BLOCKING.test(f));
  gates.push({
    name: "no gaming",
    ok: !blocking.length,
    detail: blocking.join("; ") || (flags.length ? `for the reviewer: ${flags.join("; ")}` : "none found"),
  });
  return { ok: gates.every((g) => g.ok), gates, check, hidden, staticFlags: flags };
}

function summary(c: CheckResult | null): string {
  if (!c) return "did not run";
  if (c.exception) return `exception: ${c.exception.slice(0, 200)}`;
  const e = errors(c);
  return `${c.listed} listed, ${c.read} read${
    e.length
      ? `; ${e.length} error(s): ${e
          .slice(0, 2)
          .map((f) => `${f.check} ${f.detail}`)
          .join("; ")
          .slice(0, 240)}`
      : "; contract passes"
  }`;
}

export function unifiedDiff(a: string, b: string): string {
  const dir = join("/tmp", `rif-diff-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "before.ts"), a);
  writeFileSync(join(dir, "after.ts"), b);
  try {
    execFileSync("git", ["diff", "--no-index", "--no-color", "before.ts", "after.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    return "";
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
}
