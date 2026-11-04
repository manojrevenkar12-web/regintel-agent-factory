// deployed day 54 by agent:sonnet-gated for sonnet-gated:tga:54
/** Tasman Goods Administration: a table of guidance documents, paginated with ?page=N. */
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
      ...$("nav a")
        .map((_, a) => Number($(a).text()) || 1)
        .get(),
    );
    for (let n = 1; n <= pages; n++) {
      const p = n === 1 ? $ : load(await fetch(`/?page=${n}`));
      const cards = p("article.docx-card");
      if (cards.length === 0 && n === 1) throw new Error("no document cards found on listing");
      cards.each((_, card) => {
        const ref = text(p(card).find("span.docx-ref").text());
        const a = p(card).find("h3 a").first();
        if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
        items.push({
          ref,
          title: text(a.text()),
          url: a.attr("href") ?? "",
          published: isoDate(text(p(card).find("time").first().text())),
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
    const clauses: { id: string; text: string }[] = [];
    const dl = $("dl.docx-clauses").first();
    if (dl.length === 0) throw new Error("no clause list (dl.docx-clauses) found");
    const kids = dl.children().get();
    for (let i = 0; i < kids.length; i += 2) {
      const dt = kids[i];
      const dd = kids[i + 1];
      if (!dt || !dd || dt.tagName !== "dt" || dd.tagName !== "dd")
        throw new Error(`malformed clause list near item ${i / 2 + 1}`);
      const id = text($(dt).text());
      const body = text($(dd).text());
      if (!id || !body) throw new Error(`empty clause id or text near item ${i / 2 + 1}`);
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
