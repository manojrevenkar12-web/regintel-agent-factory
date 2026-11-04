// deployed day 44 by agent:haiku-gated for haiku-gated:fdo:44
/** Federal Device Office: guidance as cards, paginated through numbered pager links (/fdo/page/N);
 * clauses as sections. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^FDO-G-\d{4}-\d{3}$/;

type Listing$ = ReturnType<typeof load>;

/** Page number -> href, for every numbered link in the pager of a listing page. */
function pagerLinks($: Listing$): Map<number, string> {
  const links = new Map<number, string>();
  $("nav.doc-pager a").each((_, a) => {
    const label = text($(a).text());
    if (!/^\d+$/.test(label)) return;
    const href = $(a).attr("href");
    if (!href) throw new Error(`pager link ${label} has no href`);
    links.set(Number(label), href);
  });
  return links;
}

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    // Page number -> the href the site gives it. Page 1 is the root listing.
    const known = new Map<number, string>([[1, "/"]]);
    const read = new Set<number>();
    for (;;) {
      const todo = [...known.keys()].filter((n) => !read.has(n)).sort((a, b) => a - b);
      const n = todo[0];
      if (n === undefined) break;
      read.add(n);
      const $ = load(await fetch(known.get(n) as string));
      $("article.doc-card").each((_, card) => {
        const ref = text($(card).find(".doc-ref").text());
        const a = $(card).find("h3 a");
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        const url = a.attr("href");
        if (!url) throw new Error(`no link for ${ref}`);
        items.push({
          ref,
          title: text(a.text()),
          url,
          published: isoDate(text($(card).find("time").text())),
        });
      });
      for (const [m, href] of pagerLinks($)) if (!known.has(m)) known.set(m, href);
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
    const clauses = $("section.doc-clause")
      .map((_, s) => ({
        id: $(s).attr("data-clause") ?? "",
        text: $(s)
          .find("p")
          .map((_, p) => text($(p).text()))
          .get()
          .join(" "),
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
