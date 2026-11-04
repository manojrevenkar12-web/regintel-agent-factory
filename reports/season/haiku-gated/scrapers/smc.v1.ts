// deployed day 26 by agent:haiku-gated for haiku-gated:smc:26
/** Swiss Medical Council: guidance as cards, paginated with ?page=N; clauses as sections. */
import { checkDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^SMC-W-\d{4}-\d{3}$/;

/** The site writes dates as DD.MM.YYYY (day first, confirmed by the sitemap's ISO lastmod values).
 * Anything else throws. */
function siteDate(s: string): string {
  const m = text(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
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
      p("article.doc-card").each((_, card) => {
        const ref = text(p(card).find(".doc-ref").text());
        const a = p(card).find("h3 a");
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        items.push({
          ref,
          url: a.attr("href") ?? "",
          title: text(a.text()),
          published: siteDate(p(card).find("time").text()),
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
      effective: siteDate(meta("Applies from")),
      published: siteDate(meta("Published")),
    };
    return doc;
  },
};
