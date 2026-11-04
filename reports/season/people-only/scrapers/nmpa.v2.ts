// deployed day 82 by person for people-only:nmpa:79
/** nmpa: written by a person for the layout in force (reference). */
import { MONTHS, checkDate, isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^NMPA\-RG-\d{4}-\d{3}$/;
const date = (s: string) => { const m = text(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (!m) throw new Error(`bad date "${s}"`); return checkDate(+m[3], +m[1], +m[2]); };
void MONTHS; void isoDate; void checkDate;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const add = (ref: string, title: string, url: string, published: string) => {
      if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
      items.push({ ref, title, url, published: date(published) });
    };
    const collect = (p: ReturnType<typeof load>) => { p("ul.doc-items li").each((_, li) => { const a = p(li).find("a"); const m = text(a.text()).match(/^(\S+): (.+)$/); const d = text(p(li).text()).match(/\(([^()]+)\)$/); if (!m || !d) throw new Error("bad item"); add(m[1], m[2], a.attr("href") ?? "", d[1]); }); };
    const first = load(await fetch("/")); const n = Math.max(1, ...first("nav a").map((_, a) => Number(first(a).text()) || 1).get()); collect(first); for (let i = 2; i <= n; i++) collect(load(await fetch(`/?page=${i}`)));
    return items;
  },
  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    const get = (k: string) => text($("table.doc-meta tr").filter((_, tr) => text($(tr).find("th").text()) === k).find("td").text());
    const v = get("Status").match(/^Version (\d+)\.0$/);
    if (!v) throw new Error(`no version in "${get("Status")}"`);
    const doc: ScrapedDoc = { ref: get("Reference"), title: text($("h1").first().text()), version: Number(v[1]), published: date(get("Published")), effective: date(get("Applies from")), clauses: $("p.doc-para").map((_, p) => ({ id: text($(p).find("strong").first().text()), text: text($(p).clone().children("strong").first().remove().end().text()) })).get() };
    return doc;
  },
};
