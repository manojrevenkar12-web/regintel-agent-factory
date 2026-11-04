/** The platform against the simulated regulators: scrapers exact against the truth, the truth kept
 * out of everything that decides, and a short durable season in PostgreSQL. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SOURCES, crawl, httpFetch, loadScraper, materialize, scraperPath } from "@rif/ingest";
import { buildWorld, layoutOf, referenceScraper, serveWorld } from "@rif/world";
import { describe, expect, it } from "vitest";
import { scoreDocs } from "../src/evaluate.js";
import { requirementsExport } from "../src/impact-run.js";

const w = buildWorld();

async function crawlScore(
  code: string,
  source: string,
  day: number,
  server: Awaited<ReturnType<typeof serveWorld>>,
  tag: string,
) {
  server.setDay(day);
  const rec = new Map();
  const scraper = await loadScraper(materialize(code, join(ROOT, "work", "test", `${source}-${tag}.ts`)));
  const o = await crawl(source, scraper, httpFetch(server.url, source, rec), rec, w.date(day), null);
  return { o, s: scoreDocs(w, source, day, o.data.docs) };
}

describe("scrapers against the truth", () => {
  it("the committed scrapers are exact before the first drift", async () => {
    const server = await serveWorld(w);
    for (const source of SOURCES) {
      const src = w.sources.find((s) => s.id === source) as (typeof w.sources)[number];
      const day = Math.min(...src.drifts.map((d) => d.day)) - 1;
      const quiet = [...Array(day + 1).keys()]
        .reverse()
        .find((d) => !src.maintenance.includes(d) && !src.rateLimited.includes(d)) as number;
      const { o, s } = await crawlScore(
        readFileSync(scraperPath(source), "utf8"),
        source,
        quiet,
        server,
        "committed",
      );
      expect(o.status, `${source} day ${quiet}`).toBe("ok");
      expect(s.wrong + s.missing + s.stale + s.phantom, source).toBe(0);
    }
    await server.close();
  });

  it("the person's reference scraper is exact on every drift", async () => {
    const server = await serveWorld(w);
    for (const src of w.sources)
      for (const d of src.drifts) {
        const day = [d.day, d.day + 1, d.day + 2].find((x) => !src.maintenance.includes(x)) as number;
        const { o, s } = await crawlScore(
          referenceScraper(src.id, src.ref_prefix, layoutOf(src, day)),
          src.id,
          day,
          server,
          `ref-${day}`,
        );
        expect(o.status, `${src.id} day ${day} (${d.kind})`).toBe("ok");
        expect(s.wrong + s.missing + s.phantom, `${src.id} ${d.kind}`).toBe(0);
      }
    await server.close();
  }, 120_000);

  it("every drift breaks the scraper written for the layout before it, loudly", async () => {
    const server = await serveWorld(w);
    let silent = 0;
    for (const src of w.sources)
      for (const d of src.drifts) {
        const day = [d.day, d.day + 1, d.day + 2].find((x) => !src.maintenance.includes(x)) as number;
        const { o, s } = await crawlScore(
          referenceScraper(src.id, src.ref_prefix, layoutOf(src, d.day - 1)),
          src.id,
          day,
          server,
          `old-${day}`,
        );
        // the contract must notice; if it ever passed, the data would have to be right
        if (o.status === "ok") expect(s.wrong).toBe(0);
        if (o.status === "ok") silent++;
      }
    expect(silent).toBe(0);
    await server.close();
  }, 120_000);
});

describe("truth isolation", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );

  it("nothing that decides imports the world", () => {
    for (const pkg of ["ingest", "factory", "impact"])
      for (const f of files(join(ROOT, "packages", pkg, "src")))
        expect(readFileSync(f, "utf8"), f).not.toMatch(/@rif\/world|packages\/world|config\/world/);
    // the service hosts the harness: only these files may touch the world
    const allowed = [
      "season.ts",
      "evaluate.ts",
      "cli.ts",
      "counterfactual.ts",
      "heldout.ts",
      "impact-run.ts",
      "report.ts",
    ];
    for (const f of files(join(ROOT, "packages", "service", "src")))
      if (/@rif\/world/.test(readFileSync(f, "utf8"))) expect(allowed, f).toContain(f.split("/").at(-1));
  });

  it("the requirements export carries no truth", () => {
    const { graph, links } = requirementsExport(w);
    const text = JSON.stringify({ graph, links: [...links] });
    expect(text).not.toMatch(/"truth"|"uid"/);
    expect(graph.requirements.length).toBe(w.company.requirements.length);
  });

  it("the API and the console never import the world", () => {
    for (const f of ["main.ts", "store.ts"])
      expect(readFileSync(join(ROOT, "packages/service/src", f), "utf8")).not.toMatch(/@rif\/world/);
  });
});
