// deployed day 25 by agent:haiku-gated for haiku-gated:tga:25
/** Tasman Goods Administration: a grid of guidance document cards, paginated with ?page=N. */
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
      ...$("nav.docx-pager a")
        .map((_, a) => Number(text($(a).text())) || 1)
        .get(),
    );
    for (let n = 1; n <= pages; n++) {
      const p = n === 1 ? $ : load(await fetch(`/?page=${n}`));
      p("div.docx-grid article.docx-card").each((_, card) => {
        const ref = text(p(card).find("span.docx-ref").text());
        const a = p(card).find("h3 a");
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        items.push({
          ref,
          url: a.attr("href") ?? "",
          title: text(a.text()),
          published: isoDate(text(p(card).find("time").text())),
        });
      });
    }
    return items;
  },

  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    const meta = (label: string) =>
      text(
        $("table.docx-meta tr")
          .filter((_, tr) => text($(tr).find("th").text()) === label)
          .find("td")
          .text(),
      );
    const status = meta("Status").match(/^Rev\. (\d+)$/);
    if (!status) throw new Error(`no revision in "${meta("Status")}"`);
    const clauses = $("ol.docx-clauses li")
      .map((_, li) => ({
        id: text($(li).find("span.num").text()),
        text: text($(li).clone().children("span.num").remove().end().text()),
      }))
      .get();
    const doc: ScrapedDoc = {
      ref: meta("Reference"),
      title: text($("h1").first().text()),
      clauses,
      version: Number(status[1]),
      effective: isoDate(meta("Applies from")),
      published: isoDate(meta("Published")),
    };
    return doc;
  },
};
