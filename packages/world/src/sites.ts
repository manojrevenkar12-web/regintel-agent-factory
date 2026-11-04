/** Regulator websites. Each site renders its documents through a layout, and the layout drifts over
 * the season the way real authority sites do: a redesign, a new pagination, another date format,
 * clauses in new markup, metadata moved into JSON-LD. Some drifts break a scraper loudly (nothing
 * parses); others break it silently (it parses, but wrong or incomplete). */
import type { Rng } from "./rng.js";

export type Layout = {
  listing: "table" | "cards" | "list";
  pagination: "query" | "path" | "api"; // ?page=2, /page/2, or a JSON endpoint behind "load more"
  pageSize: number;
  dateFormat: "iso" | "dmy" | "long" | "mdy"; // 2026-03-04, 04.03.2026, 4 March 2026, 03/04/2026
  clauses: "ol" | "section" | "dl" | "para"; // how clauses are marked up on a document page
  meta: "table" | "jsonld" | "dl"; // where ref, version and dates live
  versionLabel: "rev" | "version"; // "Rev. 3" or "Version 3.0"
  cls: string; // a CSS class prefix (redesigns rename classes)
  sitemap: boolean;
};

export type Drift = { day: number; kind: string; loud: boolean; change: Partial<Layout> };

export const initialLayout = (family: Layout["listing"]): Layout => ({
  listing: family,
  pagination: "query",
  pageSize: 8,
  dateFormat: "iso",
  clauses: family === "list" ? "para" : family === "cards" ? "section" : "ol",
  meta: "table",
  versionLabel: "rev",
  cls: "doc",
  sitemap: true,
});

/** The drifts real sites go through, each with what it does to a scraper written for the old layout. */
const DRIFTS: ((l: Layout, rng: Rng) => { kind: string; loud: boolean; change: Partial<Layout> })[] = [
  (l) => ({
    kind: "redesign: listing markup and class names",
    loud: true,
    change: { listing: l.listing === "table" ? "cards" : "table", cls: `${l.cls}x` },
  }),
  (l) => ({
    kind: "pagination moved to a load-more API",
    loud: false,
    change: { pagination: l.pagination === "api" ? "path" : "api" },
  }),
  (l) => ({
    kind: "pagination moved into the path",
    loud: false,
    change: { pagination: l.pagination === "path" ? "query" : "path" },
  }),
  (l) => ({
    kind: "dates switched to day.month.year",
    loud: true,
    change: { dateFormat: l.dateFormat === "dmy" ? "long" : "dmy" },
  }),
  (l) => ({
    kind: "dates switched to month/day/year",
    loud: false,
    change: { dateFormat: l.dateFormat === "mdy" ? "iso" : "mdy" },
  }),
  (l, rng) => ({
    kind: "clauses in new markup",
    loud: true,
    change: { clauses: rng.pick((["ol", "section", "dl", "para"] as const).filter((c) => c !== l.clauses)) },
  }),
  (l) => ({
    kind: "document metadata moved to JSON-LD",
    loud: true,
    change: { meta: l.meta === "jsonld" ? "dl" : "jsonld" },
  }),
  (l) => ({
    kind: "version label reworded",
    loud: true,
    change: { versionLabel: l.versionLabel === "rev" ? "version" : "rev" },
  }),
];

export const DRIFT_KINDS = DRIFTS.length;

/** Drifts for one site: `picks` are indices into the drift catalogue (the world spreads them so that
 * every kind happens somewhere in a season). */
export function scheduleDrifts(rng: Rng, days: number, picks: number[], initial: Layout): Drift[] {
  const out: Drift[] = [];
  let layout = initial;
  const used = new Set<number>();
  const n = picks.length;
  const at = Array.from(
    { length: n },
    (_, i) => Math.floor(((i + 1) * days) / (n + 1)) + rng.int(-6, 6),
  ).sort((a, b) => a - b);
  picks.forEach((k, i) => {
    let day = Math.max(5, Math.min(days - 8, at[i] as number));
    while (used.has(day)) day++;
    used.add(day);
    const d = (DRIFTS[k] as (typeof DRIFTS)[number])(layout, rng);
    layout = { ...layout, ...d.change };
    out.push({ day, ...d });
  });
  return out;
}

export function layoutAt(initial: Layout, drifts: Drift[], day: number): Layout {
  const l: Layout = { ...initial };
  for (const d of drifts) if (d.day <= day) Object.assign(l, d.change);
  return l;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatDate(iso: string, f: Layout["dateFormat"]): string {
  const [y, m, d] = iso.split("-");
  if (f === "iso") return iso;
  if (f === "dmy") return `${d}.${m}.${y}`;
  if (f === "mdy") return `${m}/${d}/${y}`;
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export type ShownDoc = {
  ref: string;
  title: string;
  version: number;
  published: string;
  effective: string;
  clauses: { id: string; text: string }[];
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, l: Layout) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><header class="${l.cls}-site"><a href="./">${esc(title)}</a></header><main class="${l.cls}-main">${body}</main><footer class="${l.cls}-foot">Official publication</footer></body></html>`;
}

export function renderListing(
  name: string,
  src: string,
  docs: ShownDoc[],
  l: Layout,
  pageNo: number,
): { html: string; pages: number } {
  const pages = Math.max(1, Math.ceil(docs.length / l.pageSize));
  const slice = docs.slice((pageNo - 1) * l.pageSize, pageNo * l.pageSize);
  const href = (d: ShownDoc) => `/${src}/doc/${encodeURIComponent(d.ref)}`;
  let items = "";
  if (l.listing === "table") {
    items = `<table class="${l.cls}-list"><thead><tr><th>Reference</th><th>Title</th><th>Published</th></tr></thead><tbody>${slice
      .map(
        (d) =>
          `<tr class="${l.cls}-row"><td class="${l.cls}-ref">${esc(d.ref)}</td><td><a href="${href(d)}">${esc(d.title)}</a></td><td class="${l.cls}-date">${formatDate(d.published, l.dateFormat)}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  } else if (l.listing === "cards") {
    items = `<div class="${l.cls}-grid">${slice
      .map(
        (d) =>
          `<article class="${l.cls}-card"><h3><a href="${href(d)}">${esc(d.title)}</a></h3><p class="${l.cls}-meta"><span class="${l.cls}-ref">${esc(d.ref)}</span> <time>${formatDate(d.published, l.dateFormat)}</time></p></article>`,
      )
      .join("")}</div>`;
  } else {
    items = `<ul class="${l.cls}-items">${slice.map((d) => `<li><a href="${href(d)}">${esc(d.ref)}: ${esc(d.title)}</a> (${formatDate(d.published, l.dateFormat)})</li>`).join("")}</ul>`;
  }
  let nav = "";
  if (l.pagination === "query" && pages > 1)
    nav = `<nav class="${l.cls}-pager">${Array.from({ length: pages }, (_, i) => `<a href="/${src}/?page=${i + 1}">${i + 1}</a>`).join(" ")}</nav>`;
  if (l.pagination === "path" && pages > 1)
    nav = `<nav class="${l.cls}-pager">${Array.from({ length: pages }, (_, i) => `<a href="/${src}/page/${i + 1}">${i + 1}</a>`).join(" ")}</nav>`;
  if (l.pagination === "api" && pages > 1)
    nav = `<button class="${l.cls}-more" data-endpoint="/${src}/api/list" data-offset="${l.pageSize}">Load more</button>`;
  return { html: page(`${name}: guidance documents`, `<h1>Guidance documents</h1>${items}${nav}`, l), pages };
}

export function renderApiList(src: string, docs: ShownDoc[], l: Layout, offset: number) {
  const slice = docs.slice(offset, offset + l.pageSize);
  return {
    items: slice.map((d) => ({
      reference: d.ref,
      title: d.title,
      published: formatDate(d.published, l.dateFormat),
      url: `/${src}/doc/${encodeURIComponent(d.ref)}`,
    })),
    next: offset + l.pageSize < docs.length ? offset + l.pageSize : null,
  };
}

export function renderDoc(name: string, d: ShownDoc, l: Layout): string {
  const version = l.versionLabel === "rev" ? `Rev. ${d.version}` : `Version ${d.version}.0`;
  let meta = "";
  if (l.meta === "table")
    meta = `<table class="${l.cls}-meta"><tr><th>Reference</th><td>${esc(d.ref)}</td></tr><tr><th>Status</th><td>${version}</td></tr><tr><th>Published</th><td>${formatDate(d.published, l.dateFormat)}</td></tr><tr><th>Applies from</th><td>${formatDate(d.effective, l.dateFormat)}</td></tr></table>`;
  if (l.meta === "dl")
    meta = `<dl class="${l.cls}-meta"><dt>Reference</dt><dd>${esc(d.ref)}</dd><dt>Status</dt><dd>${version}</dd><dt>Published</dt><dd>${formatDate(d.published, l.dateFormat)}</dd><dt>Applies from</dt><dd>${formatDate(d.effective, l.dateFormat)}</dd></dl>`;
  if (l.meta === "jsonld")
    meta = `<script type="application/ld+json">${JSON.stringify({ "@type": "Legislation", identifier: d.ref, name: d.title, version, datePublished: formatDate(d.published, l.dateFormat), legislationDateVersion: formatDate(d.effective, l.dateFormat) })}</script><p class="${l.cls}-status">${version}</p>`;
  let body = "";
  if (l.clauses === "ol")
    body = `<ol class="${l.cls}-clauses">${d.clauses.map((c) => `<li id="c-${c.id}"><span class="num">${c.id}</span> ${esc(c.text)}</li>`).join("")}</ol>`;
  if (l.clauses === "section")
    body = d.clauses
      .map(
        (c) =>
          `<section class="${l.cls}-clause" data-clause="${c.id}"><h4>${c.id}</h4><p>${esc(c.text)}</p></section>`,
      )
      .join("");
  if (l.clauses === "dl")
    body = `<dl class="${l.cls}-clauses">${d.clauses.map((c) => `<dt>${c.id}</dt><dd>${esc(c.text)}</dd>`).join("")}</dl>`;
  if (l.clauses === "para")
    body = d.clauses
      .map((c) => `<p class="${l.cls}-para"><strong>${c.id}</strong> ${esc(c.text)}</p>`)
      .join("");
  return page(
    `${name}: ${d.ref}`,
    `<h1>${esc(d.title)}</h1>${meta}<div class="${l.cls}-body">${body}</div>`,
    l,
  );
}

export function renderSitemap(src: string, docs: ShownDoc[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${docs
    .map(
      (d) =>
        `<url><loc>/${src}/doc/${encodeURIComponent(d.ref)}</loc><lastmod>${d.published}</lastmod></url>`,
    )
    .join("")}</urlset>`;
}

export const MAINTENANCE = (name: string) =>
  `<!doctype html><html lang="en"><head><title>${esc(name)}</title></head><body><main><h1>Scheduled maintenance</h1><p>This service is temporarily unavailable. Please try again later.</p></main></body></html>`;
