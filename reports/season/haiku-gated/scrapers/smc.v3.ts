// deployed day 87 by agent:haiku-gated for haiku-gated:smc:87
/** Swiss Medical Council: guidance as table rows on the first page; the rest come from a "Load more"
 * JSON endpoint (offset-paginated, named by the button); clauses as sections. */
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

/** A listing item from its raw parts; throws when the reference or link is not what we expect. */
function listed(ref: string, url: string, title: string, published: string): ListingItem {
  if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
  if (!url) throw new Error(`no link for ${ref}`);
  return { ref, url, title: text(title), published: siteDate(published) };
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new Error(`${what} is not a string: ${JSON.stringify(v)}`);
  return v;
};

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const $ = load(await fetch("/"));
    $("table.docx-list tr.docx-row").each((_, row) => {
      const r = $(row);
      const a = r.find("td a").first();
      items.push(
        listed(text(r.find("td.docx-ref").text()), a.attr("href") ?? "", a.text(), r.find("td.docx-date").text()),
      );
    });

    // "Load more" fetches the next block of items from its endpoint, at the offset it names.
    // Keep going while the response's `next` is not null.
    const more = $("button.docx-more");
    if (more.length) {
      const endpoint = more.attr("data-endpoint");
      let offset = Number(more.attr("data-offset"));
      if (!endpoint || !Number.isInteger(offset) || offset < 0)
        throw new Error("the load-more button has no usable endpoint or offset");
      for (;;) {
        const body = JSON.parse((await fetch(`${endpoint}?offset=${offset}`)).body) as {
          items?: unknown;
          next?: unknown;
        };
        if (!Array.isArray(body.items)) throw new Error("listing response has no items array");
        for (const it of body.items as Record<string, unknown>[]) {
          items.push(
            listed(
              str(it.reference, "reference"),
              str(it.url, "url"),
              str(it.title, "title"),
              str(it.published, "published"),
            ),
          );
        }
        if (body.next === null) break;
        if (body.next === undefined) throw new Error("listing response has no next field");
        if (body.items.length === 0) throw new Error(`listing stalled at offset ${offset}`);
        offset += body.items.length;
      }
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
    const clauses = $("section.docx-clause")
      .map((_, s) => ({ id: $(s).attr("data-clause") ?? "", text: text($(s).find("p").text()) }))
      .get();
    if (clauses.some((c) => c.id === "" || c.text === ""))
      throw new Error(`clause without id or text in ${url}`);
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
