/** Requirements formulation: the clauses in force that bind the manufacturer of a device become one
 * requirement per obligation. Clauses from different documents that ask for the same action are one
 * requirement, with the strictest deadline and frequency kept and every source clause listed, so a
 * finding can always be traced back to the regulation behind it. */
import { type Clause, type ComplianceCfg, actionTerms, appliesTo } from "./parse.js";

export type Requirement = {
  id: string;
  device: string;
  action: string; // the clearest wording among its clauses
  terms: string[];
  days: number | null; // strictest
  months: number | null; // strictest
  modal: "shall" | "should";
  sources: { ref: string; clause: string; text: string }[];
  text: string; // the requirement as the platform states it
};

const jaccard = (a: string[], b: string[]) => {
  const B = new Set(b);
  const inter = a.filter((x) => B.has(x)).length;
  return inter / Math.max(1, new Set([...a, ...b]).size);
};

export function formulate(
  clauses: Clause[],
  device: { id: string; name: string; class: string },
  company: string,
  cfg: ComplianceCfg,
): Requirement[] {
  const mine = clauses.filter((c) => c.actor === "the manufacturer" && appliesTo(c, device.class));
  const groups: { terms: string[]; clauses: Clause[] }[] = [];
  for (const c of mine) {
    const t = actionTerms(c.action, cfg);
    let best: (typeof groups)[number] | null = null;
    let bestScore = cfg.formulate.same_obligation;
    for (const g of groups) {
      const s = jaccard(t, g.terms);
      if (s >= bestScore) {
        best = g;
        bestScore = s;
      }
    }
    if (best) best.clauses.push(c);
    else groups.push({ terms: t, clauses: [c] });
  }
  return groups
    .map((g, i) => {
      const days = g.clauses.reduce<number | null>(
        (m, c) => (c.days !== null && (m === null || c.days < m) ? c.days : m),
        null,
      );
      const months = g.clauses.reduce<number | null>(
        (m, c) => (c.months !== null && (m === null || c.months < m) ? c.months : m),
        null,
      );
      const modal = g.clauses.some((c) => c.modal === "shall") ? "shall" : "should";
      const action = [...g.clauses].sort((a, b) => a.action.length - b.action.length)[0]?.action ?? "";
      const when = days !== null ? ` within ${days} day${days === 1 ? "" : "s"}` : "";
      const often = months !== null ? `, at least every ${months} months` : "";
      return {
        id: `${device.id}-R${String(i + 1).padStart(3, "0")}`,
        device: device.id,
        action,
        terms: g.terms,
        days,
        months,
        modal,
        sources: g.clauses.map((c) => ({ ref: c.ref, clause: c.clause, text: c.text })),
        text: `${company} ${modal} ${action} for the ${device.name.toLowerCase()}${when}${often}.`,
      } satisfies Requirement;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
