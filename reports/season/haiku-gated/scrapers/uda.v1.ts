// deployed day 33 by agent:haiku-gated for haiku-gated:uda:33
/** Union Device Authority: a table of guidance documents, paginated with ?page=N. */
import { checkDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^UDA-GD-\d{4}-\d{3}$/;

/** The site writes dates as DD.MM.YYYY (day first). Parsed strictly; anything else throws. */
function udaDate(s: string): string {
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) throw new Error(`not a DD.MM.YYYY date: "${s}"`);
  return checkDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const first = await fetch("/");
    const $ = load(first);
    const pages = Math.max(
      1,
      ...$("nav a")
        .map((_, a) => Number($(a).text()) || 1)
        .get(),
    );
    for (let n = 1; n <= pages; n++) {
      const p = n === 1 ? $ : load(await fetch(`/?page=${n}`));
      p("table.doc-list tbody tr").each((_, tr) => {
        const ref = text(p(tr).find("td.doc-ref").text());
        const a = p(tr).find("a");
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        items.push({
          ref,
          title: text(a.text()),
          url: a.attr("href") ?? "",
          published: udaDate(text(p(tr).find("td.doc-date").text())),
        });
      });
    }
    return items;
  },

  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    const meta = (label: string) =>
      text(
        $("table.doc-meta tr")
          .filter((_, tr) => text($(tr).find("th").text()) === label)
          .find("td")
          .text(),
      );
    const status = meta("Status").match(/^Rev\. (\d+)$/);
    if (!status) throw new Error(`no revision in "${meta("Status")}"`);
    const clauses = $("ol.doc-clauses li")
      .map((_, li) => ({
        id: text($(li).find("span.num").text()),
        text: text($(li).clone().children("span.num").remove().end().text()),
      }))
      .get();
    // Key order matches the stored records, so an unchanged document serialises identically.
    const doc: ScrapedDoc = {
      ref: meta("Reference"),
      title: text($("h1").first().text()),
      clauses,
      version: Number(status[1]),
      effective: udaDate(meta("Applies from")),
      published: udaDate(meta("Published")),
    };
    return doc;
  },
};
