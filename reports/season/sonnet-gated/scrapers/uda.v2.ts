// deployed day 57 by agent:sonnet-gated for sonnet-gated:uda:57
/** Union Device Authority: a table of guidance documents, paginated with ?page=N. */
import { checkDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^UDA-GD-\d{4}-\d{3}$/;

/** The site now shows dates as DD.MM.YYYY (day first, dotted). Strict: anything else throws. */
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
      p("table.doc-list tbody tr").each((_, tr) => {
        const ref = text(p(tr).find("td.doc-ref").text());
        const a = p(tr).find("a");
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        items.push({
          ref,
          title: text(a.text()),
          url: a.attr("href") ?? "",
          published: siteDate(p(tr).find("td.doc-date").text()),
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
      .map((_, s) => {
        const id = text($(s).children("h4").first().text());
        const attr = $(s).attr("data-clause");
        if (!id || (attr !== undefined && text(attr) !== id)) {
          throw new Error(`clause id mismatch: heading "${id}" vs data-clause "${attr}"`);
        }
        return { id, text: text($(s).children("p").text()) };
      })
      .get();
    if (clauses.length === 0) throw new Error(`no clauses found on ${url}`);
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
