// deployed day 85 by agent:sonnet-gated for sonnet-gated:fdo:85
/** Federal Device Office: guidance as cards, paginated with ?page=N; clauses as sections. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^FDO-G-\d{4}-\d{3}$/;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const $ = load(await fetch("/"));
    const seen = new Set<string>();
    const add = (ref: string, title: string, url: string, published: string) => {
      if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
      if (seen.has(ref)) throw new Error(`duplicate reference ${ref}`);
      if (!url) throw new Error(`no url for ${ref}`);
      seen.add(ref);
      items.push({ ref, title, url, published: isoDate(published) });
    };
    $("article.doc-card").each((_, card) => {
      const a = $(card).find("h3 a");
      add(
        text($(card).find(".doc-ref").text()),
        text(a.text()),
        a.attr("href") ?? "",
        text($(card).find("time").text()),
      );
    });

    // The rest of the listing is loaded by the "Load more" button from a JSON endpoint.
    const btn = $("button.doc-more");
    if (btn.length === 1) {
      const endpoint = btn.attr("data-endpoint") ?? "";
      let offset: string | null = btn.attr("data-offset") ?? "";
      if (!endpoint || !/^\d+$/.test(offset)) throw new Error("unexpected load-more button");
      const visited = new Set<string>();
      while (offset !== null) {
        if (visited.has(offset)) throw new Error(`pagination loop at offset ${offset}`);
        visited.add(offset);
        const page = await fetch(`${endpoint}?offset=${offset}`);
        const data = JSON.parse(page.body) as {
          items?: { reference: string; title: string; published: string; url: string }[];
          next?: number | string | null;
        };
        if (!Array.isArray(data.items)) throw new Error("listing JSON has no items");
        for (const it of data.items) add(it.reference, text(it.title), it.url, it.published);
        if (data.next === null || data.next === undefined) offset = null;
        else if (/^\d+$/.test(String(data.next))) offset = String(data.next);
        else throw new Error(`unexpected next cursor ${JSON.stringify(data.next)}`);
      }
    } else if (btn.length > 1) throw new Error("multiple load-more buttons");
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
