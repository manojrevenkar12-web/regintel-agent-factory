/** Helpers every scraper may use. Kept deliberately small: a helper that guesses (a date parser that
 * accepts anything) is how silent errors get in. */
import * as cheerio from "cheerio";
import type { Page } from "./types.js";

export { cheerio };

export const load = (p: Page) => cheerio.load(p.body);

/** A strict ISO date (YYYY-MM-DD) from an ISO string; throws on anything else. */
export function isoDate(s: string): string {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`not an ISO date: "${s}"`);
  return checkDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** A date from day, month and year parts; throws when the parts are not a real date. */
export function checkDate(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    throw new Error(`not a date: ${y}-${m}-${d}`);
  return dt.toISOString().slice(0, 10);
}

export const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

export const text = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

export function isMaintenance(p: Page): boolean {
  return p.body.length < 3000 && /scheduled maintenance|temporarily unavailable/i.test(p.body);
}
