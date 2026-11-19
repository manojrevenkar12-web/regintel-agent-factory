/** Reading regulatory clauses and procedure steps into what the check compares: the action in the
 * platform's own words, the deadline, the frequency, and the words that weaken or defer it. Plain
 * code over text; no truth from the simulator reaches here. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { terms } from "@rif/impact";
import { ROOT } from "@rif/ingest";
import { parse } from "yaml";

export type ComplianceCfg = {
  canonical: [string, string[]][];
  frequency_months: Record<string, number>;
  weakening: string[];
  deferral: string[];
  other_parties: string[];
  formulate: { same_obligation: number };
  check: { min_coverage: number; auto_cover: number; missing_auto: number; keyword_min_score: number };
  review: { manual_per_obligation: number; confirm: number; correct: number };
  model: { max_obligations_per_call: number };
};

export const complianceCfg = (): ComplianceCfg =>
  parse(readFileSync(join(ROOT, "config/compliance.yaml"), "utf8")) as ComplianceCfg;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** "ten", "twenty-five" or "25" as a number. */
export function readNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.toLowerCase().split("-");
  let n = 0;
  for (const p of parts) {
    const v = NUMBER_WORDS[p];
    if (v === undefined) return null;
    n += v;
  }
  return n;
}

/** Rewrite every phrase in the glossary to its one word, longest phrases first. */
export function canonicalise(text: string, cfg: ComplianceCfg): string {
  let t = ` ${text
    .toLowerCase()
    .replace(/[(),;:]/g, " ")
    .replace(/\s+/g, " ")} `;
  const pairs = cfg.canonical
    .flatMap(([word, phrases]) => phrases.map((p) => [p, word] as const))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [p, w] of pairs) t = t.split(` ${p} `).join(` ${w} `);
  return t.trim();
}

/** The content words of an action, after the glossary. */
export const actionTerms = (text: string, cfg: ComplianceCfg) => [...new Set(terms(canonicalise(text, cfg)))];

const DAYS = /(?:within|no later than)\s+(?:([a-z-]+)\s*\((\d+)\)|(\d+)|([a-z-]+))\s+(?:calendar\s+)?days?/i;

/** The deadline in days, if the text sets one. */
export function readDays(text: string): number | null {
  const m = text.match(DAYS);
  if (!m) return null;
  if (m[2]) return Number(m[2]);
  if (m[3]) return Number(m[3]);
  return m[4] ? readNumber(m[4]) : m[1] ? readNumber(m[1]) : null;
}

/** The interval in months, if the text sets a recurrence. */
export function readMonths(text: string, cfg: ComplianceCfg): number | null {
  const t = text.toLowerCase();
  let best: number | null = null;
  for (const [p, m] of Object.entries(cfg.frequency_months))
    if (t.includes(p) && (best === null || m < best)) best = m;
  return best;
}

export type Clause = {
  ref: string;
  clause: string;
  text: string;
  classes: string[] | "all";
  actor: string;
  modal: "shall" | "should";
  action: string; // the clause's action with scope, actor, modal, deadline and frequency removed
  days: number | null;
  months: number | null;
};

/** Read one clause: who must do what, for which device classes, by when, how often. */
export function readClause(ref: string, clause: string, text: string, cfg: ComplianceCfg): Clause | null {
  const t = text.replace(/\.$/, "");
  const scope = t.match(/for (all devices|class ([IVab, and]+?) devices)/i);
  const classes: Clause["classes"] = !scope
    ? "all"
    : scope[1]?.toLowerCase() === "all devices"
      ? "all"
      : ((scope[2] ?? "").match(/III|IIb|IIa|I/g) ?? []);
  const actor = (
    t.match(/the manufacturer|the authorised representative|the importer/i)?.[0] ?? ""
  ).toLowerCase();
  const modal = (t.match(/\b(shall|should)\b/i)?.[1]?.toLowerCase() ?? "") as Clause["modal"];
  if (!actor || !modal) return null;
  let action = t.slice((t.toLowerCase().indexOf(` ${modal}`) as number) + modal.length + 1);
  action = action.replace(/^,?\s*for (all devices|class [IVab, and]+? devices),?\s*/i, "");
  action = action.replace(DAYS, "");
  for (const p of Object.keys(cfg.frequency_months))
    action = action.replace(new RegExp(`\\s*${p}\\b`, "i"), "");
  return {
    ref,
    clause,
    text,
    classes,
    actor,
    modal,
    action: action.trim(),
    days: readDays(t),
    months: readMonths(t, cfg),
  };
}

export const appliesTo = (c: Clause, deviceClass: string) =>
  c.classes === "all" || c.classes.includes(deviceClass);

export type Step = {
  id: string;
  text: string; // without its number
  terms: string[];
  days: number | null;
  months: number | null;
  weak: boolean;
  deferred: boolean;
  otherParty: boolean;
  pointsTo: string | null; // "The activity in 8.4 is completed within ..." points to 8.4
};

/** Read one procedure step. */
export function readStep(id: string, raw: string, cfg: ComplianceCfg): Step {
  const text = raw.replace(/^\d+\.\d+\s+/, "");
  const low = text.toLowerCase();
  const pointsTo = text.match(/(?:activity|step|steps|notifications?) (?:in|under) (\d+\.\d+)/i)?.[1] ?? null;
  return {
    id,
    text,
    terms: actionTerms(text, cfg),
    days: readDays(text),
    months: readMonths(text, cfg),
    weak: cfg.weakening.some((w) => new RegExp(`\\b${w}\\b`, "i").test(low)),
    deferred: cfg.deferral.some((d) => low.includes(d)),
    otherParty: cfg.other_parties.some((p) => low.startsWith(p)),
    pointsTo,
  };
}
