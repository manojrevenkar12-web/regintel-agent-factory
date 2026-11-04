// deployed day 27 by person for people-only:tga:25
/** tga: written by a person for the layout in force (reference). */
import { MONTHS, checkDate, isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^TGA\-DG-\d{4}-\d{3}$/;
const date = (s: string) => isoDate(s);
void MONTHS; void isoDate; void checkDate;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const add = (ref: string, title: string, url: string, published: string) => {
      if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
      items.push({ ref, title, url, published: date(published) });
    };
    const collect = (p: ReturnType<typeof load>) => { p("article.docx-card").each((_, card) => { const a = p(card).find("h3 a"); add(text(p(card).find(".docx-ref").text()), text(a.text()), a.attr("href") ?? "", text(p(card).find("time").text())); }); };
    const first = load(await fetch("/")); const n = Math.max(1, ...first("nav a").map((_, a) => Number(first(a).text()) || 1).get()); collect(first); for (let i = 2; i <= n; i++) collect(load(await fetch(`/?page=${i}`)));
    return items;
  },
  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    const get = (k: string) => text($("table.docx-meta tr").filter((_, tr) => text($(tr).find("th").text()) === k).find("td").text());
    const v = get("Status").match(/^Rev\. (\d+)$/);
    if (!v) throw new Error(`no version in "${get("Status")}"`);
    const doc: ScrapedDoc = { ref: get("Reference"), title: text($("h1").first().text()), version: Number(v[1]), published: date(get("Published")), effective: date(get("Applies from")), clauses: $("ol.docx-clauses li").map((_, li) => ({ id: text($(li).find("span.num").text()), text: text($(li).clone().children("span.num").remove().end().text()) })).get() };
    return doc;
  },
};
