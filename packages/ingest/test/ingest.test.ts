import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  type CrawlData,
  MaintenanceError,
  checkCrawl,
  checkDate,
  fingerprint,
  httpFetch,
  isMaintenance,
  isoDate,
  materialize,
  sitemapRefs,
} from "../src/index.js";

const doc = (ref: string, version: number, clauses: string[], published = "2025-02-01") => ({
  ref,
  title: "Guidance on risk management",
  version,
  published,
  effective: "2025-03-03",
  clauses: clauses.map((t, i) => ({ id: `1.${i + 1}`, text: t })),
});
const item = (ref: string, published = "2025-02-01") => ({
  ref,
  title: "Guidance on risk management",
  url: `/doc/${ref}`,
  published,
});
const T1 = "For all devices, the manufacturer shall establish a risk management process.";
const T2 = "For all devices, the manufacturer shall keep the risk management file up to date.";
const data = (n: number, f = (i: number) => doc(`UDA-GD-2025-00${i + 1}`, 1, [T1, T2])): CrawlData => ({
  items: Array.from({ length: n }, (_, i) => item(`UDA-GD-2025-00${i + 1}`)),
  docs: Array.from({ length: n }, (_, i) => f(i)),
});
const checks = (now: CrawlData, prev: CrawlData | null, sitemap: string[] | null = null) =>
  checkCrawl("uda", "2026-02-01", now, prev, sitemap)
    .filter((f) => f.level === "error")
    .map((f) => f.check);

describe("the extraction contract", () => {
  it("passes a clean crawl", () => {
    expect(
      checks(
        data(5),
        data(5),
        data(5).items.map((i) => i.ref),
      ),
    ).toEqual([]);
  });

  it("catches an empty or shrunken listing and documents missing from the sitemap", () => {
    expect(checks(data(0), data(5))).toContain("listing.empty");
    expect(checks(data(3), data(5))).toContain("listing.shrank");
    expect(checks(data(3), null, [...data(3).items.map((i) => i.ref), "UDA-GD-2025-009"])).toContain(
      "listing.sitemap",
    );
  });

  it("catches references, dates and clause text that look wrong", () => {
    const bad = data(2);
    (bad.items[0] as { ref: string }).ref = "UDA-2025-1";
    (bad.docs[1] as { published: string }).published = "2027-01-01";
    (bad.docs[1] as { clauses: { id: string; text: string }[] }).clauses = [
      { id: "1", text: "<span>short</span>" },
    ];
    expect(checks(bad, null)).toEqual(
      expect.arrayContaining(["listing.ref", "doc.published", "doc.clause_id", "doc.clause_text"]),
    );
  });

  it("treats a changed document under the same version as the scraper's fault", () => {
    const prev = data(3);
    expect(
      checks(
        data(3, (i) => doc(`UDA-GD-2025-00${i + 1}`, 1, i === 0 ? [T2, T1] : [T1, T2])),
        prev,
      ),
    ).toContain("doc.content_changed");
    expect(
      checks(
        data(3, (i) => doc(`UDA-GD-2025-00${i + 1}`, 1, i === 0 ? [T1] : [T1, T2])),
        prev,
      ),
    ).toContain("doc.clauses_lost");
    expect(
      checks(
        data(3, (i) => doc(`UDA-GD-2025-00${i + 1}`, i === 0 ? 0 : 1, [T1, T2])),
        prev,
      ),
    ).toContain("doc.version");
    // a new version may change anything
    expect(
      checks(
        data(3, (i) => doc(`UDA-GD-2025-00${i + 1}`, i === 0 ? 2 : 1, i === 0 ? [T2] : [T1, T2])),
        prev,
      ),
    ).toEqual([]);
  });
});

describe("parsing helpers", () => {
  it("accepts only strict ISO dates and real calendar dates", () => {
    expect(isoDate(" 2025-02-28 ")).toBe("2025-02-28");
    expect(() => isoDate("28.02.2025")).toThrow();
    expect(() => isoDate("2025-02-30")).toThrow();
    expect(() => checkDate(2025, 13, 1)).toThrow();
  });

  it("recognises a maintenance page and a sitemap", () => {
    expect(
      isMaintenance({
        url: "/",
        status: 200,
        contentType: "text/html",
        body: "<h1>Scheduled maintenance</h1>",
      }),
    ).toBe(true);
    expect(
      isMaintenance({
        url: "/",
        status: 200,
        contentType: "text/html",
        body: `<h1>Guidance</h1>${"x".repeat(4000)} scheduled maintenance`,
      }),
    ).toBe(false);
    expect(
      sitemapRefs(
        "<loc>https://x/doc/UDA-GD-2025-001</loc><loc>https://x/doc/other</loc>",
        /^UDA-GD-\d{4}-\d{3}$/,
      ),
    ).toEqual(["UDA-GD-2025-001"]);
  });

  it("fingerprints layout, not text", () => {
    expect(fingerprint('<table class="doc-list"><tr><td>A</td></tr></table>')).toBe(
      fingerprint('<table class="doc-list"><tr><td>B</td></tr></table>'),
    );
    expect(fingerprint('<table class="doc-list"></table>')).not.toBe(
      fingerprint('<div class="doc-cards"></div>'),
    );
  });

  it("rewrites a deployed scraper's imports to the platform's helpers", () => {
    const path = materialize(
      'import { load } from "../parse.js";\nimport type { Fetch } from "../types.js";\n',
      "/tmp/rif-test/x.ts",
    );
    const code = readFileSync(path, "utf8");
    expect(code).not.toContain('"../parse.js"');
    expect(code).toMatch(/packages\/ingest\/src\/parse\.js/);
  });
});

describe("fetching", () => {
  it("waits out a 429, records every page and stops on a maintenance page", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (req.url === "/uda/busy" && hits === 1) return void res.writeHead(429, { "retry-after": "0" }).end();
      if (req.url === "/uda/down")
        return void res
          .writeHead(200, { "content-type": "text/html" })
          .end("<p>Temporarily unavailable for scheduled maintenance</p>");
      res.writeHead(200, { "content-type": "text/html" }).end(`<p>${req.url}</p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const rec = new Map();
    const f = httpFetch(base, "uda", rec);
    expect((await f("/busy")).body).toBe("<p>/uda/busy</p>");
    await expect(f("/down")).rejects.toBeInstanceOf(MaintenanceError);
    expect([...rec.keys()]).toContain("/busy");
    server.close();
  });
});
