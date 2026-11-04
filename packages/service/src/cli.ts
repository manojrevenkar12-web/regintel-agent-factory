/** rif: run the season, the change-impact assessments and the reports.
 *
 *   rif season --setup <name> [--days N] [--fresh]   crawl and repair for a season (needs RIF_DATABASE_URL)
 *   rif impact --setup <name> [--limit N]            assess every new document version the season saw
 *   rif report                                       write reports/RESULTS.md and reports/results.json
 *   rif serve                                        the API for the console
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { factoryCfg } from "@rif/factory";
import { ROOT, SOURCES } from "@rif/ingest";
import { buildWorld, serveWorld } from "@rif/world";
import { scoreDay } from "./evaluate.js";
import { humanDelay, runSeason } from "./season.js";
import { Store } from "./store.js";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] as string) : d;
};
const db = () => {
  const url = process.env.RIF_DATABASE_URL;
  if (!url) throw new Error("set RIF_DATABASE_URL to a PostgreSQL database (with pgvector)");
  return url;
};

async function season() {
  const setup = factoryCfg().setups.find((s) => s.name === opt("setup"));
  if (!setup) throw new Error(`no setup ${opt("setup")} in config/factory.yaml`);
  const world = buildWorld();
  const days = Number(opt("days", String(world.cfg.days)));
  const store = Store.connect(db());
  await store.migrate();
  if (args.includes("--fresh")) {
    await store.reset(setup.name);
    process.env.RIF_RUN = `${Date.now()}`;
  }
  const run = process.env.RIF_RUN ?? "r1";
  DBOS.setConfig({ name: `rif-${setup.name}-${run}`, systemDatabaseUrl: `${db()}_dbos` } as never);
  await DBOS.launch();
  const server = await serveWorld(world);
  const runDir = join(ROOT, "work", "season", setup.name);
  const scores: Awaited<ReturnType<typeof scoreDay>> = [];
  const log = (s: string) => console.log(s);
  const t0 = Date.now();
  await runSeason(
    { store, world, server, setup, runDir, humanDelayDays: humanDelay(), log },
    days,
    async (day) => {
      scores.push(...(await scoreDay(store, world, setup.name, day, SOURCES)));
    },
  );
  const out = join(ROOT, "reports", "season", setup.name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "days.json"), `${JSON.stringify(scores)}\n`);
  const inc = await store.pool.query("select * from incidents where setup = $1 order by day, source", [
    setup.name,
  ]);
  writeFileSync(join(out, "incidents.json"), `${JSON.stringify(inc.rows, null, 1)}\n`);
  const dep = await store.pool.query(
    "select source, version, day, by, incident, code from deployments where setup = $1 order by source, version",
    [setup.name],
  );
  for (const d of dep.rows) {
    mkdirSync(join(out, "scrapers"), { recursive: true });
    writeFileSync(
      join(out, "scrapers", `${d.source}.v${d.version}.ts`),
      `// deployed day ${d.day} by ${d.by}${d.incident ? ` for ${d.incident}` : ""}\n${d.code}`,
    );
  }
  console.log(
    `season ${setup.name}: ${days} days in ${Math.round((Date.now() - t0) / 1000)}s, ${inc.rows.length} incidents`,
  );
  await server.close();
  await DBOS.shutdown();
  await store.close();
}

async function main() {
  const cmd = args[0];
  if (cmd === "season") return season();
  if (cmd === "impact")
    return (await import("./impact-run.js")).runImpact(
      db(),
      opt("setup", "sonnet-gated") as string,
      Number(opt("limit", "1000")),
    );
  if (cmd === "report") return (await import("./report.js")).writeReport();
  if (cmd === "serve") return (await import("./main.js")).serve();
  console.log("usage: rif season|impact|report|serve");
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
});
