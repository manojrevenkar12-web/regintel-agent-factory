/** The only way a scraper reaches a site: polite (a budget per second), patient with 429s, honest
 * about maintenance pages, and recording every page it saw so an incident carries its evidence. */
import { isMaintenance } from "./parse.js";
import { type Fetch, MaintenanceError, type Page } from "./types.js";

export type Recorder = Map<string, Page>;

export function httpFetch(
  base: string,
  source: string,
  rec: Recorder,
  opts: { retries?: number; minGapMs?: number } = {},
): Fetch {
  const retries = opts.retries ?? 6;
  const gap = opts.minGapMs ?? 0;
  let last = 0;
  return async (path: string) => {
    const rel = path.startsWith(`/${source}/`) ? path.slice(source.length + 1) : path;
    const url = `${base}/${source}${rel.startsWith("/") ? rel : `/${rel}`}`;
    for (let attempt = 0; ; attempt++) {
      const wait = last + gap - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const r = await fetch(url);
      const body = await r.text();
      const page: Page = {
        url: rel,
        status: r.status,
        body,
        contentType: r.headers.get("content-type") ?? "",
      };
      if (r.status === 429 && attempt < retries) {
        await sleep(1000 * Number(r.headers.get("retry-after") ?? 1));
        continue;
      }
      rec.set(rel, page);
      if (r.status >= 400) throw new Error(`HTTP ${r.status} for ${rel}`);
      if (isMaintenance(page)) throw new MaintenanceError(rel);
      return page;
    }
  };
}

/** Replays recorded pages: how scrapers are tested on snapshots, and how repairs are checked. */
export function replayFetch(pages: Record<string, Page>, source: string): Fetch {
  return async (raw: string) => {
    const path = raw.startsWith(`/${source}/`) ? raw.slice(source.length + 1) : raw;
    const key = Object.keys(pages).find(
      (k) => k === path || decodeURIComponent(k) === decodeURIComponent(path),
    );
    const p = key ? pages[key] : undefined;
    if (!p) throw new Error(`no snapshot for ${path}`);
    if (p.status >= 400) throw new Error(`HTTP ${p.status} for ${path}`);
    if (isMaintenance(p)) throw new MaintenanceError(path);
    return p;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
