// deployed day 54 by agent:haiku-gated for haiku-gated:tga:54
/** Tasman Goods Administration: a grid of guidance document cards, paginated with ?page=N. */
import { isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^TGA-DG-\d{4}-\d{3}$/;

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
    const meta = (label: string) =>
      text(
        $("table.docx-meta tr")
          .filter((_, tr) => text($(tr).find("th").text()) === label)
          .find("td")
          .text(),
      );
    const status = meta("Status").match(/^Rev\. (\d+)$/);
    if (!status) throw new Error(`no revision in "${meta("Status")}"`);
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
