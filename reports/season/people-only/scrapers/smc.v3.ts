// deployed day 89 by person for people-only:smc:87
/** smc: written by a person for the layout in force (reference). */
import { MONTHS, checkDate, isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^SMC\-W-\d{4}-\d{3}$/;
const date = (s: string) => { const m = text(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/); if (!m) throw new Error(`bad date "${s}"`); return checkDate(+m[3], +m[2], +m[1]); };
void MONTHS; void isoDate; void checkDate;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const add = (ref: string, title: string, url: string, published: string) => {
      if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
      items.push({ ref, title, url, published: date(published) });
    };
    const collect = (p: ReturnType<typeof load>) => { p("table.docx-list tbody tr").each((_, tr) => { const a = p(tr).find("a"); add(text(p(tr).find("td.docx-ref").text()), text(a.text()), a.attr("href") ?? "", text(p(tr).find("td.docx-date").text())); }); };
    const first = load(await fetch("/")); collect(first); let offset: number | null = 8; const ep = first("button.docx-more").attr("data-endpoint"); while (ep && offset !== null) { const j = JSON.parse((await fetch(`${ep}?offset=${offset}`)).body) as { items: { reference: string; title: string; published: string; url: string }[]; next: number | null }; for (const it of j.items) add(it.reference, it.title, it.url, it.published); offset = j.next; }
    return items;
  },
  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    const get = (k: string) => text($("table.docx-meta tr").filter((_, tr) => text($(tr).find("th").text()) === k).find("td").text());
    const v = get("Status").match(/^Rev\. (\d+)$/);
    if (!v) throw new Error(`no version in "${get("Status")}"`);
    const doc: ScrapedDoc = { ref: get("Reference"), title: text($("h1").first().text()), version: Number(v[1]), published: date(get("Published")), effective: date(get("Applies from")), clauses: $("section.docx-clause").map((_, s) => ({ id: $(s).attr("data-clause") ?? "", text: text($(s).find("p").text()) })).get() };
    return doc;
  },
};
