/** Run a scraper on recorded pages through the production contract.
 *
 *   tsx check.ts <snapshots.json> [--prev last-good.json] [--scraper path] [--json]
 *
 * Documents whose page is not in the snapshots are listed but not read. With --json the result is
 * machine-readable (the gates use that); otherwise it prints what a person needs to fix the scraper.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type CrawlData, checkCrawl, contracts, sitemapRefs } from "./contract.js";
import { replayFetch } from "./fetch.js";
import type { Page, ScrapedDoc, Scraper } from "./types.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const snapPath = args[0] ?? "snapshots.json";
const snap = JSON.parse(readFileSync(snapPath, "utf8")) as {
  source: string;
  today: string;
  pages: Record<string, Page>;
};
const prev = JSON.parse(readFileSync(opt("--prev") ?? "last-good.json", "utf8")) as CrawlData;
const scraperFile = resolve(opt("--scraper") ?? `scrapers/${snap.source}.ts`);
const json = args.includes("--json");

const result: {
  listed: number;
  read: number;
  skipped: number;
  exception: string | null;
  findings: ReturnType<typeof checkCrawl>;
  data: CrawlData;
} = {
  listed: 0,
  read: 0,
  skipped: 0,
  exception: null,
  findings: [],
  data: { items: [], docs: [] },
};

try {
  const { scraper } = (await import(pathToFileURL(scraperFile).href)) as { scraper: Scraper };
  const fetch = replayFetch(snap.pages, snap.source);
  result.data.items = await scraper.list(fetch);
  result.listed = result.data.items.length;
  const docs: ScrapedDoc[] = [];
  for (const it of result.data.items) {
    const path = it.url.replace(new RegExp(`^/${snap.source}`), "");
    if (!snap.pages[path] && !snap.pages[decodeURIComponent(path)]) {
      result.skipped++;
      continue;
    }
    docs.push(await scraper.document(fetch, it.url));
  }
  result.data.docs = docs;
  result.read = docs.length;
  const sm = snap.pages["/sitemap.xml"];
  const sitemap = sm
    ? sitemapRefs(sm.body, new RegExp((contracts().sources[snap.source] as { ref: string }).ref))
    : null;
  result.findings = checkCrawl(snap.source, snap.today, result.data, prev, sitemap);
} catch (e) {
  result.exception = e instanceof Error ? `${e.message}` : String(e);
}

if (json) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  const errors = result.findings.filter((f) => f.level === "error");
  console.log(`listed ${result.listed} documents, read ${result.read}, not in snapshots ${result.skipped}`);
  if (result.exception) console.log(`EXCEPTION: ${result.exception}`);
  for (const f of result.findings)
    console.log(`${f.level.toUpperCase()} ${f.check}${f.ref ? ` [${f.ref}]` : ""}: ${f.detail}`);
  const prevDocs = new Map(prev.docs.map((d) => [d.ref, d]));
  for (const d of result.data.docs.slice(0, 3)) {
    const p = prevDocs.get(d.ref);
    console.log(
      `  ${d.ref} v${d.version} published ${d.published} effective ${d.effective}, ${d.clauses.length} clauses${p ? (p.version === d.version ? (JSON.stringify(p) === JSON.stringify(d) ? " (same as last good)" : " (DIFFERS from last good)") : ` (last good: v${p.version})`) : " (new)"}`,
    );
  }
  console.log(result.exception || errors.length ? `FAIL: ${errors.length} error(s)` : "PASS");
  process.exitCode = result.exception || errors.length ? 1 : 0;
}
