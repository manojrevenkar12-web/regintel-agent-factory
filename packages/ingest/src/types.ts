/** What every scraper produces and the one way it may reach a site. Scrapers are small, per-source
 * modules (src/scrapers/<source>.ts) because that is what breaks when a site changes, and what the
 * agent factory repairs. They never see the world's truth: only pages. */
export type ListingItem = { ref: string; title: string; url: string; published: string }; // published: ISO date
export type Clause = { id: string; text: string };
export type ScrapedDoc = {
  ref: string;
  title: string;
  version: number;
  published: string;
  effective: string;
  clauses: Clause[];
};

export type Page = { url: string; status: number; body: string; contentType: string };

/** Fetches a page relative to the source's base URL. Handles 429 (Retry-After) and transient errors. */
export type Fetch = (path: string) => Promise<Page>;

export interface Scraper {
  /** Every document the site lists, across all its pages. */
  list(fetch: Fetch): Promise<ListingItem[]>;
  /** One document page. */
  document(fetch: Fetch, url: string): Promise<ScrapedDoc>;
}

export class MaintenanceError extends Error {
  constructor(url: string) {
    super(`maintenance page at ${url}`);
  }
}
