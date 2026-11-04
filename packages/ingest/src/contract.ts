/** Is a crawl's data trustworthy? Checked from the crawl itself, the site's own sitemap and the last
 * good crawl, never from the truth. Silent breakage is the dangerous kind (a scraper that returns
 * plausible but wrong data), so most checks compare with what the source said before. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { ListingItem, ScrapedDoc } from "./types.js";

export const ROOT = process.env.RIF_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Contracts = {
  defaults: {
    min_date: string;
    max_days_ahead: number;
    listing_drop: number;
    clause_drop: number;
    min_clause_chars: number;
    clause_id: string;
  };
  sources: Record<string, { ref: string }>;
};
let cached: Contracts | null = null;
export const contracts = (): Contracts => {
  if (!cached) cached = parse(readFileSync(join(ROOT, "config/contracts.yaml"), "utf8")) as Contracts;
  return cached;
};

export type Finding = { level: "error" | "warn"; check: string; detail: string; ref?: string };

export type CrawlData = { items: ListingItem[]; docs: ScrapedDoc[] };

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function checkCrawl(
  source: string,
  today: string,
  now: CrawlData,
  prev: CrawlData | null,
  sitemap: string[] | null,
): Finding[] {
  const c = contracts();
  const d = c.defaults;
  const refRe = new RegExp((c.sources[source] as { ref: string }).ref);
  const idRe = new RegExp(d.clause_id);
  const out: Finding[] = [];
  const err = (check: string, detail: string, ref?: string) =>
    out.push({ level: "error", check, detail, ref });
  const warn = (check: string, detail: string, ref?: string) =>
    out.push({ level: "warn", check, detail, ref });
  const dateOk = (s: string, latest: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) && s >= d.min_date && s <= latest;

  if (!now.items.length) err("listing.empty", "the listing returned no documents");
  const refs = now.items.map((i) => i.ref);
  if (new Set(refs).size !== refs.length) err("listing.duplicates", "the same reference appears twice");
  for (const i of now.items) {
    if (!refRe.test(i.ref))
      err("listing.ref", `reference "${i.ref}" does not match the source's pattern`, i.ref);
    if (!i.title) err("listing.title", "an item has no title", i.ref);
    if (!dateOk(i.published, today))
      err("listing.date", `published "${i.published}" is not a valid past date`, i.ref);
  }
  if (prev?.items.length && now.items.length < prev.items.length * (1 - d.listing_drop))
    err(
      "listing.shrank",
      `${now.items.length} documents listed, ${prev.items.length} on the last good crawl`,
    );
  if (sitemap) {
    const missing = sitemap.filter((r) => !refs.includes(r));
    if (missing.length)
      err(
        "listing.sitemap",
        `${missing.length} document(s) in the sitemap are missing from the listing: ${missing.slice(0, 3).join(", ")}`,
      );
  }
  const prevDocs = new Map((prev?.docs ?? []).map((x) => [x.ref, x]));
  const prevItems = new Map((prev?.items ?? []).map((x) => [x.ref, x]));
  for (const doc of now.docs) {
    const item = now.items.find((i) => i.ref === doc.ref);
    if (!item) err("doc.ref", `document "${doc.ref}" is not in the listing`, doc.ref);
    if (!Number.isInteger(doc.version) || doc.version < 1)
      err("doc.version", `version "${doc.version}" is not a positive integer`, doc.ref);
    if (!dateOk(doc.published, today))
      err("doc.published", `published "${doc.published}" is not a valid past date`, doc.ref);
    if (!dateOk(doc.effective, addDays(today, d.max_days_ahead)))
      err("doc.effective", `effective "${doc.effective}" is not plausible`, doc.ref);
    if (doc.effective < doc.published) err("doc.dates", "applies before it was published", doc.ref);
    if (item && item.published !== doc.published)
      err("doc.listing_date", `listing says ${item.published}, page says ${doc.published}`, doc.ref);
    if (!doc.clauses.length) err("doc.clauses", "no clauses extracted", doc.ref);
    const ids = doc.clauses.map((x) => x.id);
    if (new Set(ids).size !== ids.length) err("doc.clause_ids", "duplicate clause numbers", doc.ref);
    for (const cl of doc.clauses) {
      if (!idRe.test(cl.id)) err("doc.clause_id", `clause number "${cl.id}" is malformed`, doc.ref);
      if (cl.text.length < d.min_clause_chars || /<[a-z]/i.test(cl.text))
        err("doc.clause_text", `clause ${cl.id} text looks wrong`, doc.ref);
    }
    const before = prevDocs.get(doc.ref);
    if (before) {
      if (doc.version < before.version)
        err("doc.version_back", `version went from ${before.version} to ${doc.version}`, doc.ref);
      if (doc.version === before.version) {
        // the same version must be the same document; anything else is the scraper, not the regulator
        if (doc.published !== before.published)
          err(
            "doc.date_changed",
            `same version, published ${before.published} became ${doc.published}`,
            doc.ref,
          );
        if (doc.clauses.length < before.clauses.length * (1 - d.clause_drop))
          err(
            "doc.clauses_lost",
            `same version, ${before.clauses.length} clauses became ${doc.clauses.length}`,
            doc.ref,
          );
        else if (JSON.stringify(doc.clauses) !== JSON.stringify(before.clauses))
          err("doc.content_changed", "same version, different clauses", doc.ref);
      }
    }
    const pi = prevItems.get(doc.ref);
    if (pi && before && doc.version === before.version && item && pi.published !== item.published)
      err(
        "listing.date_changed",
        `same version, listing date ${pi.published} became ${item.published}`,
        doc.ref,
      );
  }
  return out;
}

/** A page's skeleton: tags and classes, no text. A new skeleton means the site changed its layout,
 * even when every check still passes. */
export function fingerprint(html: string): string {
  const tags = [...html.matchAll(/<([a-z0-9]+)([^>]*)>/gi)].map((m) => {
    const cls = (m[2] ?? "").match(/class="([^"]*)"/)?.[1] ?? "";
    return `${(m[1] as string).toLowerCase()}.${cls}`;
  });
  const uniq = [...new Set(tags)].sort().join("|");
  let h = 2166136261;
  for (let i = 0; i < uniq.length; i++) h = Math.imul(h ^ uniq.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
}

export function sitemapRefs(xml: string, refRe: RegExp): string[] {
  return [...xml.matchAll(/<loc>[^<]*\/doc\/([^<]+)<\/loc>/g)]
    .map((m) => decodeURIComponent(m[1] as string))
    .filter((r) => refRe.test(r));
}
