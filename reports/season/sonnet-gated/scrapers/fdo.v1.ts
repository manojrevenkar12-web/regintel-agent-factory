// deployed day 44 by agent:sonnet-gated for sonnet-gated:fdo:44
/** Federal Device Office: guidance as cards, paginated with ?page=N; clauses as sections. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^FDO-G-\d{4}-\d{3}$/;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const first = await fetch("/");
    const $ = load(first);
    const nums = $("nav a")
      .map((_, a) => Number(text($(a).text())))
      .get()
      .filter((n) => Number.isInteger(n) && n > 0);
    const pages = Math.max(1, ...nums);
    const seen = new Set<string>();
    for (let n = 1; n <= pages; n++) {
      // "/" repeats page 1, so every page is fetched from /page/N.
      const p = load(await fetch(`/page/${n}`));
      p("article.doc-card").each((_, card) => {
        const ref = text(p(card).find(".doc-ref").text());
        const a = p(card).find("h3 a");
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        if (seen.has(ref)) throw new Error(`duplicate reference ${ref}`);
        seen.add(ref);
        items.push({
          ref,
          title: text(a.text()),
          url: a.attr("href") ?? "",
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
        $("table.doc-meta tr")
          .filter((_, tr) => text($(tr).find("th").text()) === label)
          .find("td")
          .text(),
      );
    const status = meta("Status").match(/^Rev\. (\d+)$/);
    if (!status) throw new Error(`no revision in "${meta("Status")}"`);
    const clauses = $("section.doc-clause")
      .map((_, s) => ({ id: $(s).attr("data-clause") ?? "", text: text($(s).find("p").text()) }))
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
