// deployed day 93 by agent:haiku-gated for haiku-gated:uda:93
/** Union Device Authority: a table of guidance documents, paginated with ?page=N. */
import { checkDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = /^UDA-GD-\d{4}-\d{3}$/;

/** The site writes dates as DD.MM.YYYY (day first). Parsed strictly; anything else throws. */
function udaDate(s: string): string {
  const m = s.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) throw new Error(`not a DD.MM.YYYY date: "${s}"`);
  return checkDate(Number(m[3]), Number(m[2]), Number(m[1]));
}

/** The JSON-LD record on each document page. */
interface UdaLegislation {
  "@type": string;
  identifier: string;
  name: string;
  version: string;
  datePublished: string;
  legislationDateVersion: string;
}

/** A revision number from "Rev. N"; throws on anything else. */
function revision(s: string): number {
  const m = s.trim().match(/^Rev\. (\d+)$/);
  if (!m) throw new Error(`no revision in "${s}"`);
  return Number(m[1]);
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
          published: udaDate(text(p(tr).find("td.doc-date").text())),
        });
      });
    }
    return items;
  },

  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    // Metadata is a schema.org-style JSON-LD record: @type "Legislation", with the reference as
    // "identifier", the revision as "version", "datePublished" and "legislationDateVersion" (the
    // date the version applies from), all in DD.MM.YYYY. Exactly one such record must be present.
    const records = $('script[type="application/ld+json"]')
      .map((_, s) => JSON.parse($(s).text()) as Partial<UdaLegislation>)
      .get()
      .filter((r) => r["@type"] === "Legislation");
    if (records.length !== 1) throw new Error(`expected one Legislation record at ${url}, found ${records.length}`);
    const ld = records[0] as UdaLegislation;
    const ref = text(ld.identifier);
    if (!REF.test(ref)) throw new Error(`unexpected reference "${ref}" at ${url}`);
    // The visible status line must agree with the structured revision.
    const version = revision($("p.doc-status").first().text());
    if (revision(ld.version) !== version) throw new Error(`revision mismatch at ${url}`);
    // Clauses are <section class="doc-clause"> with the number in <h4> and the body in <p>.
    const clauses = $("section.doc-clause")
      .map((_, sec) => {
        const id = text($(sec).children("h4").first().text());
        const body = text($(sec).children("p").first().text());
        if (!id || !body) throw new Error(`clause without number or text in "${ref}"`);
        return { id, text: body };
      })
      .get();
    // Key order matches the stored records, so an unchanged document serialises identically.
    const doc: ScrapedDoc = {
      ref,
      title: text($("h1").first().text()),
      clauses,
      version,
      effective: udaDate(ld.legislationDateVersion),
      published: udaDate(ld.datePublished),
    };
    return doc;
  },
};
