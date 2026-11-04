/** One crawl of one source: the scraper lists and reads every document, the contract judges the
 * result against the site's sitemap and the last good crawl, and the pages seen are kept as the
 * incident's evidence. Data from a crawl with any error is never used. */
import { type CrawlData, type Finding, checkCrawl, contracts, fingerprint, sitemapRefs } from "./contract.js";
import type { Recorder } from "./fetch.js";
import { type Fetch, MaintenanceError, type Page, type Scraper } from "./types.js";

export type CrawlOutcome = {
  source: string;
  today: string;
  status: "ok" | "maintenance" | "failed";
  data: CrawlData;
  findings: Finding[];
  pages: Record<string, Page>;
  fingerprints: { listing: string | null; doc: string | null };
  requests: number;
  ms: number;
};

export async function crawl(
  source: string,
  scraper: Scraper,
  fetch: Fetch,
  rec: Recorder,
  today: string,
  prev: CrawlData | null,
): Promise<CrawlOutcome> {
  const t0 = Date.now();
  const findings: Finding[] = [];
  const data: CrawlData = { items: [], docs: [] };
  let status: CrawlOutcome["status"] = "ok";
  try {
    data.items = await scraper.list(fetch);
    for (const item of data.items) data.docs.push(await scraper.document(fetch, item.url));
  } catch (e) {
    if (e instanceof MaintenanceError) status = "maintenance";
    else
      findings.push({
        level: "error",
        check: "scraper.exception",
        detail: e instanceof Error ? e.message : String(e),
      });
  }
  let sitemap: string[] | null = null;
  if (status !== "maintenance") {
    try {
      const sm = await fetch("/sitemap.xml");
      sitemap = sitemapRefs(sm.body, new RegExp((contracts().sources[source] as { ref: string }).ref));
    } catch (e) {
      if (e instanceof MaintenanceError) status = "maintenance";
    }
  }
  if (status !== "maintenance" && !findings.some((f) => f.check === "scraper.exception"))
    findings.push(...checkCrawl(source, today, data, prev, sitemap));
  if (status !== "maintenance" && findings.some((f) => f.level === "error")) status = "failed";
  const pages = Object.fromEntries(rec);
  const listing = pages["/"] ?? null;
  const docPage = Object.entries(pages).find(([k]) => k.startsWith("/doc/"))?.[1] ?? null;
  return {
    source,
    today,
    status,
    data,
    findings,
    pages,
    fingerprints: {
      listing: listing ? fingerprint(listing.body) : null,
      doc: docPage ? fingerprint(docPage.body) : null,
    },
    requests: rec.size,
    ms: Date.now() - t0,
  };
}
