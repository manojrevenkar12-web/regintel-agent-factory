/** A short season as durable DBOS workflows on PostgreSQL: the first days crawl every source, and
 * running the same days again with the same workflow ids replays recorded results instead of
 * crawling twice. Needs RIF_TEST_DATABASE_URL; skipped without it. */
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { ROOT } from "@rif/ingest";
import { buildWorld, serveWorld } from "@rif/world";
import { describe, expect, it } from "vitest";
import { runSeason } from "../src/season.js";
import { Store } from "../src/store.js";

const url = process.env.RIF_TEST_DATABASE_URL;
const db = url ? describe : describe.skip;

db("a durable season", () => {
  it("crawls each source once a day and replays, not repeats, a rerun", async () => {
    const store = Store.connect(url as string);
    await store.migrate();
    const setup = { name: "people-test", model: "none", gates: true, review: false };
    await store.reset(setup.name);
    process.env.RIF_RUN = `t${Date.now()}`;
    DBOS.setConfig({ name: "rif-season-test", systemDatabaseUrl: `${url}_dbos` } as never);
    await DBOS.launch();
    const world = buildWorld();
    const server = await serveWorld(world);
    const ctx = {
      store,
      world,
      server,
      setup,
      runDir: join(ROOT, "work", "test-season"),
      humanDelayDays: 3,
      log: () => {},
    };
    try {
      await runSeason(ctx, 3);
      const count = async () =>
        Number(
          (await store.pool.query("select count(*) from crawls where setup = $1", [setup.name])).rows[0]
            .count,
        );
      const first = await count();
      expect(first).toBe(15);
      const before = server.requests();
      await runSeason(ctx, 3); // same workflow ids: results come from the system database
      expect(await count()).toBe(first);
      expect(server.requests()).toBe(before);
      const versions = await store.versions(setup.name);
      expect(versions.length).toBeGreaterThan(40);
    } finally {
      await server.close();
      await DBOS.shutdown();
      await store.close();
    }
  }, 120_000);
});
