/** Load a source's scraper: the committed one, or a deployed repair from a file path. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./contract.js";
import type { Scraper } from "./types.js";

export const SOURCES = ["uda", "fdo", "nmpa", "tga", "smc"] as const;
export const scraperPath = (source: string) => join(ROOT, "packages/ingest/src/scrapers", `${source}.ts`);

let loads = 0;
export async function loadScraper(path: string): Promise<Scraper> {
  // a fresh copy per load, so a repaired file is imported anew rather than from the module cache
  // (a query string would do for Node, but not for every loader)
  const copy = materialize(
    readFileSync(path, "utf8"),
    join(ROOT, "work", "loaded", `${process.pid}-${++loads}-${basename(path)}`),
  );
  const mod = (await import(pathToFileURL(copy).href)) as { scraper: Scraper };
  if (!mod.scraper?.list || !mod.scraper?.document) throw new Error(`${path} does not export a scraper`);
  return mod.scraper;
}

/** Write a scraper's code to a file outside the source tree, its helper imports pointing at the
 * platform's own helpers (a deployed repair never brings its own). */
export function materialize(code: string, path: string): string {
  const ingest = join(ROOT, "packages/ingest/src");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    code
      .replaceAll('"../parse.js"', `"${join(ingest, "parse.js")}"`)
      .replaceAll('"../types.js"', `"${join(ingest, "types.js")}"`),
  );
  return path;
}
