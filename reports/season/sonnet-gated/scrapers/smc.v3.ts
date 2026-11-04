// deployed day 87 by agent:sonnet-gated for sonnet-gated:smc:87
/** Swiss Medical Council: guidance as cards, paginated with ?page=N; clauses as sections. */
import { checkDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^SMC-W-\d{4}-\d{3}$/;

/** The site now uses strict day-first dates: DD.MM.YYYY. Anything else throws. */
function siteDate(s: string): string {
  const m = text(s).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) throw new Error(`not a DD.MM.YYYY date: "${s}"`);
  return checkDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

/** fetch() is relative to the /smc base; the site emits absolute paths including it. */
function rel(p: string): string {
  return p.replace(/^\/smc(?=\/)/, "");
}

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const $ = load(await fetch("/"));
    $("tr.docx-row").each((_, card) => {
      const ref = text($(card).find(".docx-ref").text());
      const a = $(card).find("a").first();
      if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
      items.push({
        ref,
        title: text(a.text()),
        url: rel(a.attr("href") ?? ""),
        published: siteDate($(card).find(".docx-date").text()),
      });
    });
    const btn = $("button.docx-more");
    if (btn.length) {
      const endpoint = btn.attr("data-endpoint");
      const off = btn.attr("data-offset");
      if (!endpoint || off === undefined || !/^\d+$/.test(off)) {
        throw new Error("unrecognised load-more button");
      }
      let next: unknown = Number(off);
      const seen = new Set<number>();
      while (next !== null && next !== undefined) {
        if (typeof next !== "number" || !Number.isInteger(next) || seen.has(next)) {
          throw new Error(`unexpected pagination cursor ${JSON.stringify(next)}`);
        }
        seen.add(next);
        const page = await fetch(`${rel(endpoint)}?offset=${next}`);
        if (page.status !== 200) throw new Error(`list api returned ${page.status}`);
        const data = JSON.parse(page.body);
        if (!data || !Array.isArray(data.items)) throw new Error("unexpected list response");
        for (const it of data.items) {
          const ref = text(String(it.reference ?? ""));
          if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}"`);
          if (!it.url) throw new Error(`no url for ${ref}`);
          items.push({
            ref,
            title: text(String(it.title ?? "")),
            url: rel(String(it.url)),
            published: siteDate(String(it.published ?? "")),
          });
        }
        next = data.next;
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
