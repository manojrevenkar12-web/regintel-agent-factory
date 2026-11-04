/** Northern Medical Products Agency: a plain list "REF: Title (date)", paginated with ?page=N;
 * clauses as paragraphs with the number in bold. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const ITEM = /^(NMPA-RG-\d{4}-\d{3}): (.+)$/;

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
      p("ul.doc-items li").each((_, li) => {
        const a = p(li).find("a");
        const m = text(a.text()).match(ITEM);
        if (!m) throw new Error(`unexpected item "${text(a.text())}"`);
        const date = text(p(li).text()).match(/\((\d{4}-\d{2}-\d{2})\)$/);
        if (!date) throw new Error(`no date in "${text(p(li).text())}"`);
        items.push({
          ref: m[1] as string,
          title: m[2] as string,
          url: a.attr("href") ?? "",
          published: isoDate(date[1] as string),
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
    const clauses = $("p.doc-para")
      .map((_, p) => ({
        id: text($(p).find("strong").first().text()),
        text: text($(p).clone().children("strong").first().remove().end().text()),
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
