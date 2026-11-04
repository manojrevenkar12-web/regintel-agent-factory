// deployed day 79 by agent:haiku-gated for haiku-gated:nmpa:79
/** Northern Medical Products Agency: a plain list "REF: Title (date)", paginated with ?page=N;
 * clauses as paragraphs with the number in bold. */
import { checkDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const ITEM = /^(NMPA-RG-\d{4}-\d{3}): (.+)$/;

/** The site writes dates as MM/DD/YYYY (month first, e.g. 01/26/2026). Anything else throws. */
function usDate(s: string): string {
  const m = text(s).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`not an MM/DD/YYYY date: "${s}"`);
  return checkDate(Number(m[3]), Number(m[1]), Number(m[2]));
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
      p("ul.doc-items li").each((_, li) => {
        const a = p(li).find("a");
        const m = text(a.text()).match(ITEM);
        if (!m) throw new Error(`unexpected item "${text(a.text())}"`);
        const date = text(p(li).text()).match(/\((\d{2}\/\d{2}\/\d{4})\)$/);
        if (!date) throw new Error(`no date in "${text(p(li).text())}"`);
        items.push({
          ref: m[1] as string,
          title: m[2] as string,
          url: a.attr("href") ?? "",
          published: usDate(date[1] as string),
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
    // The site writes "Version N.0". A non-zero minor is a revision this scraper does not model: throw.
    const status = meta("Status").match(/^Version (\d+)\.0$/);
    if (!status) throw new Error(`no version N.0 in "${meta("Status")}"`);
    const clauses = $("p.doc-para")
      .map((_, p) => {
        const body = $(p).clone();
        const id = text(body.find("strong").first().text());
        body.find("strong").first().remove();
        return { id, text: text(body.text()) };
      })
      .get();
    const doc: ScrapedDoc = {
      ref: meta("Reference"),
      title: text($("h1").first().text()),
      clauses,
      version: Number(status[1]),
      effective: usDate(meta("Applies from")),
      published: usDate(meta("Published")),
    };
    return doc;
  },
};
