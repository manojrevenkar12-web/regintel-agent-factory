/** The scraper a careful person would write for a layout. It stands in for the regulatory-data
 * engineer an escalated incident goes to: part of the simulated world, never of the platform (it
 * is generated from the site's true layout, which no platform component can see). */
import type { Layout } from "./sites.js";

export function referenceScraper(source: string, refPrefix: string, l: Layout): string {
  const c = l.cls;
  const refRe = `/^${refPrefix.replace(/-/g, "\\-")}-\\d{4}-\\d{3}$/`;
  const date =
    l.dateFormat === "iso"
      ? "(s: string) => isoDate(s)"
      : l.dateFormat === "dmy"
        ? `(s: string) => { const m = text(s).match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})$/); if (!m) throw new Error(\`bad date "\${s}"\`); return checkDate(+m[3], +m[2], +m[1]); }`
        : l.dateFormat === "mdy"
          ? `(s: string) => { const m = text(s).match(/^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/); if (!m) throw new Error(\`bad date "\${s}"\`); return checkDate(+m[3], +m[1], +m[2]); }`
          : `(s: string) => { const m = text(s).match(/^(\\d{1,2}) ([A-Za-z]+) (\\d{4})$/); if (!m) throw new Error(\`bad date "\${s}"\`); const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1; if (!mo) throw new Error(\`bad month "\${s}"\`); return checkDate(+m[3], mo, +m[1]); }`;
  const items =
    l.listing === "table"
      ? `p("table.${c}-list tbody tr").each((_, tr) => { const a = p(tr).find("a"); add(text(p(tr).find("td.${c}-ref").text()), text(a.text()), a.attr("href") ?? "", text(p(tr).find("td.${c}-date").text())); });`
      : l.listing === "cards"
        ? `p("article.${c}-card").each((_, card) => { const a = p(card).find("h3 a"); add(text(p(card).find(".${c}-ref").text()), text(a.text()), a.attr("href") ?? "", text(p(card).find("time").text())); });`
        : `p("ul.${c}-items li").each((_, li) => { const a = p(li).find("a"); const m = text(a.text()).match(/^(\\S+): (.+)$/); const d = text(p(li).text()).match(/\\(([^()]+)\\)$/); if (!m || !d) throw new Error("bad item"); add(m[1], m[2], a.attr("href") ?? "", d[1]); });`;
  const pages =
    l.pagination === "api"
      ? `const first = load(await fetch("/")); collect(first); let offset: number | null = ${l.pageSize}; const ep = first("button.${c}-more").attr("data-endpoint"); while (ep && offset !== null) { const j = JSON.parse((await fetch(\`\${ep}?offset=\${offset}\`)).body) as { items: { reference: string; title: string; published: string; url: string }[]; next: number | null }; for (const it of j.items) add(it.reference, it.title, it.url, it.published); offset = j.next; }`
      : `const first = load(await fetch("/")); const n = Math.max(1, ...first("nav a").map((_, a) => Number(first(a).text()) || 1).get()); collect(first); for (let i = 2; i <= n; i++) collect(load(await fetch(${l.pagination === "path" ? "`/page/${i}`" : "`/?page=${i}`"})));`;
  const meta =
    l.meta === "jsonld"
      ? `const j = JSON.parse($('script[type="application/ld+json"]').first().text() || "{}"); const get = (k: string) => text(String({ Reference: j.identifier, Status: j.version, Published: j.datePublished, "Applies from": j.legislationDateVersion }[k] ?? ""));`
      : l.meta === "dl"
        ? `const get = (k: string) => text($("dl.${c}-meta dt").filter((_, dt) => text($(dt).text()) === k).first().next("dd").text());`
        : `const get = (k: string) => text($("table.${c}-meta tr").filter((_, tr) => text($(tr).find("th").text()) === k).find("td").text());`;
  const version = l.versionLabel === "rev" ? "/^Rev\\. (\\d+)$/" : "/^Version (\\d+)\\.0$/";
  const clauses =
    l.clauses === "ol"
      ? `$("ol.${c}-clauses li").map((_, li) => ({ id: text($(li).find("span.num").text()), text: text($(li).clone().children("span.num").remove().end().text()) })).get()`
      : l.clauses === "section"
        ? `$("section.${c}-clause").map((_, s) => ({ id: $(s).attr("data-clause") ?? "", text: text($(s).find("p").text()) })).get()`
        : l.clauses === "dl"
          ? `$("dl.${c}-clauses dt").map((_, dt) => ({ id: text($(dt).text()), text: text($(dt).next("dd").text()) })).get()`
          : `$("p.${c}-para").map((_, p) => ({ id: text($(p).find("strong").first().text()), text: text($(p).clone().children("strong").first().remove().end().text()) })).get()`;
  return `/** ${source}: written by a person for the layout in force (reference). */
import { MONTHS, checkDate, isoDate, load, text } from "../parse.js";
import type { Fetch, ListingItem, ScrapedDoc, Scraper } from "../types.js";

const REF = ${refRe};
const date = ${date};
void MONTHS; void isoDate; void checkDate;

export const scraper: Scraper = {
  async list(fetch: Fetch) {
    const items: ListingItem[] = [];
    const add = (ref: string, title: string, url: string, published: string) => {
      if (!REF.test(ref)) throw new Error(\`unexpected reference "\${ref}"\`);
      items.push({ ref, title, url, published: date(published) });
    };
    const collect = (p: ReturnType<typeof load>) => { ${items} };
    ${pages}
    return items;
  },
  async document(fetch: Fetch, url: string) {
    const $ = load(await fetch(url));
    ${meta}
    const v = get("Status").match(${version});
    if (!v) throw new Error(\`no version in "\${get("Status")}"\`);
    const doc: ScrapedDoc = { ref: get("Reference"), title: text($("h1").first().text()), version: Number(v[1]), published: date(get("Published")), effective: date(get("Applies from")), clauses: ${clauses} };
    return doc;
  },
};
`;
}
