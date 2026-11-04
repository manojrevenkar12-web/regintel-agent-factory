/** Tasman Goods Administration: a table of guidance documents, paginated with ?page=N. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^TGA-DG-\d{4}-\d{3}$/;

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
          published: isoDate(text(p(tr).find("td.doc-date").text())),
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
    const doc: ScrapedDoc = {
      ref: meta("Reference"),
      title: text($("h1").first().text()),
      version: Number(status[1]),
      published: isoDate(meta("Published")),
      effective: isoDate(meta("Applies from")),
      clauses,
    };
    return doc;
  },
};
