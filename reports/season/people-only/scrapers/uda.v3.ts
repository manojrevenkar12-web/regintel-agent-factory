// deployed day 95 by person for people-only:uda:93
/** uda: written by a person for the layout in force (reference). */
import { MONTHS, checkDate, isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^UDA\-GD-\d{4}-\d{3}$/;
const date = (s: string) => { const m = text(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/); if (!m) throw new Error(`bad date "${s}"`); return checkDate(+m[3], +m[2], +m[1]); };
void MONTHS; void isoDate; void checkDate;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const add = (ref: string, title: string, url: string, published: string) => {
      if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
      items.push({ ref, title, url, published: date(published) });
    };
    const collect = (p: ReturnType<typeof load>) => { p("table.doc-list tbody tr").each((_, tr) => { const a = p(tr).find("a"); add(text(p(tr).find("td.doc-ref").text()), text(a.text()), a.attr("href") ?? "", text(p(tr).find("td.doc-date").text())); }); };
    const first = load(await fetch("/")); const n = Math.max(1, ...first("nav a").map((_, a) => Number(first(a).text()) || 1).get()); collect(first); for (let i = 2; i <= n; i++) collect(load(await fetch(`/?page=${i}`)));
    return items;
  },
  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    const j = JSON.parse($('script[type="application/ld+json"]').first().text() || "{}"); const get = (k: string) => text(String({ Reference: j.identifier, Status: j.version, Published: j.datePublished, "Applies from": j.legislationDateVersion }[k] ?? ""));
    const v = get("Status").match(/^Rev\. (\d+)$/);
    if (!v) throw new Error(`no version in "${get("Status")}"`);
    const doc: ScrapedDoc = { ref: get("Reference"), title: text($("h1").first().text()), version: Number(v[1]), published: date(get("Published")), effective: date(get("Applies from")), clauses: $("section.doc-clause").map((_, s) => ({ id: $(s).attr("data-clause") ?? "", text: text($(s).find("p").text()) })).get() };
    return doc;
  },
};
