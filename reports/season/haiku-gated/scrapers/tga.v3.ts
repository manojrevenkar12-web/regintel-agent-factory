// deployed day 86 by agent:haiku-gated for haiku-gated:tga:86
/** Tasman Goods Administration: a grid of guidance document cards, paginated with ?page=N. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^TGA-DG-\d{4}-\d{3}$/;

/** "Rev. N" to N, or null when the text is not a revision. */
const revision = (s: string): number | null => {
  const m = s.match(/^Rev\. (\d+)$/);
  return m ? Number(m[1]) : null;
};

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

    // The document's metadata is one JSON-LD block: identifier, version, datePublished and
    // legislationDateVersion (the date the revision applies from). Exactly one must be present.
    const blocks = $('script[type="application/ld+json"]');
    if (blocks.length !== 1) throw new Error(`expected one metadata block, found ${blocks.length}`);
    let meta: unknown;
    try {
      meta = JSON.parse(blocks.text());
    } catch (e) {
      throw new Error(`metadata block is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("metadata block is not an object");
    const field = (key: string): string => {
      const v = (meta as Record<string, unknown>)[key];
      if (typeof v !== "string") throw new Error(`metadata has no "${key}"`);
      return v;
    };

    const ref = field("identifier");
    if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}" in metadata`);

    // The revision as shown on the page must agree with the metadata.
    const shown = text($("p.docx-status").first().text());
    const version = revision(shown);
    if (version === null) throw new Error(`no revision in "${shown}"`);
    const metaVersion = revision(field("version"));
    if (metaVersion !== version) throw new Error(`page shows revision ${version}, metadata says "${field("version")}"`);

    const list = $("dl.docx-clauses");
    if (list.length !== 1) throw new Error(`expected one clause list, found ${list.length}`);
    // Terms (dt) and definitions (dd) must strictly alternate: id, text, id, text, ...
    const clauses: { id: string; text: string }[] = [];
    const parts = list.children().toArray();
    if (parts.length % 2 !== 0) throw new Error(`clause list has an unpaired entry (${parts.length} items)`);
    for (let i = 0; i < parts.length; i += 2) {
      const dt = parts[i];
      const dd = parts[i + 1];
      if (dt.tagName.toLowerCase() !== "dt" || dd.tagName.toLowerCase() !== "dd")
        throw new Error(`clause list is not dt/dd pairs at item ${i + 1}`);
      const id = text($(dt).text());
      const body = text($(dd).text());
      if (!id || !body) throw new Error(`empty clause at item ${i + 1}`);
      clauses.push({ id, text: body });
    }
    const doc: ScrapedDoc = {
      ref,
      title: text($("h1").first().text()),
      clauses,
      version,
      effective: isoDate(field("legislationDateVersion")),
      published: isoDate(field("datePublished")),
    };
    return doc;
  },
};
