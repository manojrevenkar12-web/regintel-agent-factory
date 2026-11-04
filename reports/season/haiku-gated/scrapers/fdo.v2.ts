// deployed day 85 by agent:haiku-gated for haiku-gated:fdo:85
/** Federal Device Office: guidance as cards on the first listing page; the rest is served by a JSON
 * list API behind a "Load more" button (data-endpoint, data-offset). Clauses as sections. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, Page, ScrapedDoc, Scraper } from "../types.js";

const REF = /^FDO-G-\d{4}-\d{3}$/;

/** One item of the list API: { reference, title, published, url }. Throws on anything unexpected. */
function apiItem(x: unknown): ListingItem {
  if (typeof x !== "object" || x === null) throw new Error("list API item is not an object");
  const o = x as Record<string, unknown>;
  const { reference, title, published, url } = o;
  if (typeof reference !== "string" || !REF.test(reference))
    throw new Error(`unexpected reference "${String(reference)}"`);
  if (typeof title !== "string" || text(title) === "") throw new Error(`no title for ${reference}`);
  if (typeof url !== "string" || url === "") throw new Error(`no link for ${reference}`);
  if (typeof published !== "string") throw new Error(`no published date for ${reference}`);
  return { ref: reference, title: text(title), url, published: isoDate(published) };
}

/** A page of the list API: its items and the `next` marker (null on the last page). */
function apiPage(p: Page): { items: ListingItem[]; next: unknown } {
  if (!p.contentType.includes("application/json"))
    throw new Error(`list API ${p.url} returned ${p.contentType}, not JSON`);
  const body = JSON.parse(p.body) as { items?: unknown; next?: unknown };
  if (!Array.isArray(body.items)) throw new Error(`list API ${p.url} has no items array`);
  return { items: body.items.map(apiItem), next: body.next };
}

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const $ = load(await fetch("/"));
    const items: ListingItem[] = [];
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

    // The rest of the listing: "Load more" names the endpoint and the offset of the next items.
    const more = $("button.doc-more");
    if (more.length > 0) {
      const endpoint = more.attr("data-endpoint");
      const offset = more.attr("data-offset");
      if (!endpoint) throw new Error(`"Load more" button has no data-endpoint`);
      if (!offset || !/^\d+$/.test(offset)) throw new Error(`bad data-offset "${offset}"`);
      if (Number(offset) !== items.length)
        throw new Error(`"Load more" offset ${offset} but ${items.length} cards listed`);

      const seen = new Set<string>();
      let path: string | null = `${endpoint}?offset=${offset}`;
      while (path !== null) {
        if (seen.has(path)) throw new Error(`list API repeats ${path}`);
        seen.add(path);
        const page = apiPage(await fetch(path));
        if (page.items.length === 0 && page.next !== null)
          throw new Error(`list API ${path} returned no items but has a next page`);
        items.push(...page.items);
        const next = page.next;
        if (next === null) path = null;
        else if (typeof next === "number") path = `${endpoint}?offset=${next}`;
        else if (typeof next === "string") path = next;
        else throw new Error(`list API ${path} has an unexpected next: ${JSON.stringify(next)}`);
      }
    }

    const refs = new Set<string>();
    for (const it of items) {
      if (refs.has(it.ref)) throw new Error(`${it.ref} is listed more than once`);
      refs.add(it.ref);
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
