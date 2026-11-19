/** The company's standard operating procedures as text, and the truth about whether each one meets the
 * obligations that apply to it.
 *
 * For every device and topic the world takes the obligations on the manufacturer that apply to the
 * device's class (documents in force at day 0), keeps the strictest deadline, frequency and modal of
 * each action, and writes a procedure that meets each obligation, meets it only in part, contradicts
 * it, or leaves it out. Procedures are written in the company's own words: other verbs, deadlines as
 * words or digits, a deadline in a later step that points back, stricter numbers than required, and
 * distractor steps that look right but are about another party or another action. The platform reads
 * the procedure text only; the verdicts stay here. */
import { type Device, applies } from "./company.js";
import { ACTORS, type Doc, type Obligation, TOPICS, topicTitle } from "./corpus.js";
import type { Rng } from "./rng.js";

export type Verdict = "covered" | "partial" | "conflict" | "missing";
export type SopStep = { id: string; text: string };
export type SopDoc = {
  id: string;
  customer: string;
  device: string;
  topic: string;
  title: string;
  version: number;
  steps: SopStep[];
};
export type ObligationTruth = {
  key: string; // customer:device:topic:action, the obligation's identity
  customer: string;
  device: string;
  topic: string;
  action: number;
  sources: string[]; // ref#clauseId of every clause behind it
  days: number | null; // strictest
  frequency: string | null; // strictest
  verdict: Verdict;
  steps: string[]; // the steps that carry it (empty when missing)
  why: string; // what was done to the text, for reading failures
};
export type SopWorld = { docs: SopDoc[]; truth: ObligationTruth[] };

export type SopCfg = {
  verdicts: { covered: number; stricter: number; partial: number; conflict: number; missing: number };
  split_step: number; // share of covered obligations whose deadline sits in a later step that points back
  number_words: number; // share of numbers written as words
  distractor: number; // share of missing obligations that get a look-alike step
  revise_share: number; // share of obligations whose step is rewritten in the next version
  customers: number; // device makers whose procedures are checked (the same devices, their own texts)
  passive: number; // share of steps written in the passive voice
  other_units: number; // share of deadlines given in weeks, months or hours instead of days
  other_frequency_words: number; // share of recurrences in words the glossary may not know
};

// Months between occurrences: smaller is stricter.
export const INTERVAL: Record<string, number> = {
  quarterly: 3,
  "every six months": 6,
  annually: 12,
  "every two years": 24,
};
const FREQ_WORDS: Record<number, string[]> = {
  3: ["quarterly", "every three months", "at least four times a year"],
  6: ["every six months", "twice a year", "semi-annually"],
  12: ["annually", "once a year", "at least every 12 months"],
  24: ["every two years", "biennially", "at least every 24 months"],
};
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];
const TENS: Record<number, string> = {
  2: "twenty",
  3: "thirty",
  4: "forty",
  5: "fifty",
  6: "sixty",
  7: "seventy",
  8: "eighty",
  9: "ninety",
};
export function numberWord(n: number): string {
  if (n <= 20) return WORDS[n] as string;
  const t = TENS[Math.floor(n / 10)] as string;
  return n % 10 ? `${t}-${WORDS[n % 10]}` : t;
}

// The company writes procedures in its own verbs; some are not the regulator's.
const SOP_VERBS: Record<string, string[]> = {
  "establish and maintain": ["operates and keeps current", "sets up and maintains"],
  report: ["reports", "notifies"],
  update: ["brings up to date", "revises"],
  analyse: ["reviews", "analyses"],
  submit: ["issues", "sends"],
  investigate: ["determines the cause of", "investigates"],
  keep: ["keeps", "retains"],
  assign: ["gives", "allocates"],
  register: ["records", "enters"],
  place: ["prints", "affixes"],
  document: ["writes down", "documents"],
  classify: ["rates", "classifies"],
  verify: ["checks", "tests"],
  evaluate: ["judges", "evaluates"],
  maintain: ["keeps current", "maintains"],
  assess: ["reviews", "assesses"],
  patch: ["fixes", "remediates"],
  perform: ["completes", "carries out"],
  "plan and conduct": ["plans and carries out", "plans and performs"],
  justify: ["supports with evidence", "justifies"],
  establish: ["runs", "establishes"],
  review: ["goes over", "re-examines"],
  identify: ["lists", "identifies"],
  conduct: ["performs", "conducts"],
};
const ROLES: Record<string, string[]> = {
  pms: ["The PMS lead", "Quality Assurance"],
  vigilance: ["The vigilance officer", "Regulatory Affairs"],
  udi: ["Regulatory Affairs", "The labelling team"],
  software: ["The software lead", "R&D"],
  cyber: ["The product security officer", "R&D"],
  clinical: ["The clinical lead", "Medical Affairs"],
  risk: ["The risk manager", "Quality Assurance"],
  usability: ["The usability engineer", "R&D"],
};
// Passive forms of the company's verbs.
const PASSIVE: Record<string, string> = {
  "establish and maintain": "set up and maintained",
  report: "reported to the authority",
  update: "updated",
  analyse: "analysed",
  submit: "issued",
  investigate: "investigated",
  keep: "kept",
  assign: "assigned",
  register: "registered",
  place: "affixed",
  document: "documented",
  classify: "classified",
  verify: "verified",
  evaluate: "evaluated",
  maintain: "maintained",
  assess: "assessed",
  patch: "remediated",
  perform: "performed",
  "plan and conduct": "planned and carried out",
  justify: "justified",
  establish: "established",
  review: "reviewed",
  identify: "identified",
  conduct: "conducted",
};
const OTHER_FREQ: Record<number, string[]> = {
  3: ["every quarter", "each quarter"],
  6: ["every half year", "each half-year"],
  12: ["each year", "every calendar year"],
  24: ["every second year", "in alternate years"],
};
const WEAK = ["where practicable, ", "aims to ", "should, where possible, "];

type Action = { verb: string[]; object: string[]; deadline?: [number, number]; recurring?: boolean };
const actionOf = (topic: string, i: number) =>
  (TOPICS.find((t) => t.name === topic) as (typeof TOPICS)[number]).actions[i] as Action;

/** The obligations on the manufacturer for a device, one per action, strictest parameters kept. */
export function obligationsFor(
  docs: Doc[],
  device: Device,
  customer = "C1",
): Omit<ObligationTruth, "verdict" | "steps" | "why">[] {
  const by = new Map<string, Omit<ObligationTruth, "verdict" | "steps" | "why">>();
  for (const d of docs) {
    const v = d.versions[0];
    if (!v || d.published > 0) continue;
    for (const c of v.clauses) {
      const ob: Obligation = c.ob;
      if (ob.actor !== ACTORS[0] || !applies(ob, device)) continue;
      const key = `${customer}:${device.id}:${ob.topic}:${ob.action}`;
      const cur = by.get(key);
      const freqOf = (f: string | null) => (f ? (INTERVAL[f] as number) : Number.POSITIVE_INFINITY);
      if (!cur)
        by.set(key, {
          key,
          customer,
          device: device.id,
          topic: ob.topic,
          action: ob.action,
          sources: [`${d.ref}#${c.id}`],
          days: ob.days,
          frequency: ob.frequency,
        });
      else {
        cur.sources.push(`${d.ref}#${c.id}`);
        if (ob.days !== null && (cur.days === null || ob.days < cur.days)) cur.days = ob.days;
        if (ob.frequency && freqOf(ob.frequency) < freqOf(cur.frequency)) cur.frequency = ob.frequency;
      }
    }
  }
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function days(rng: Rng, n: number, words: number, otherUnits = 0): string {
  if (rng.chance(otherUnits)) {
    if (n % 7 === 0) return `within ${numberWord(n / 7)} week${n === 7 ? "" : "s"}`;
    if (n === 30) return "within one month";
    if (n <= 3) return `within ${n * 24} hours`;
  }
  const num = rng.chance(words) ? `${numberWord(n)} (${n})` : `${n}`;
  const unit = n === 1 ? "day" : "days";
  return rng.pick([
    `within ${num} calendar ${unit}`,
    `no later than ${num} ${unit} after becoming aware`,
    `within ${num} ${unit}`,
  ]);
}
function freq(rng: Rng, months: number, other = 0): string {
  return rng.pick((rng.chance(other) ? OTHER_FREQ[months] : FREQ_WORDS[months]) as string[]);
}
const looser = (m: number) => (m === 3 ? 6 : m === 6 ? 12 : 24);
const stricter = (m: number) => (m === 24 ? 12 : m === 12 ? 6 : 3);

type Draft = { truth: ObligationTruth; steps: string[] };

function draftSteps(
  rng: Rng,
  cfg: SopCfg,
  o: Omit<ObligationTruth, "verdict" | "steps" | "why">,
  device: Device,
): Draft {
  const a = actionOf(o.topic, o.action);
  const verbs = SOP_VERBS[a.verb[0] as string] ?? [`${a.verb[0]}s`];
  const object = (rng.pick(a.object) as string).replace(/^the |^a |^an /, "the ");
  const who = rng.pick(ROLES[o.topic] ?? ["Quality Assurance"]);
  const v = cfg.verdicts;
  const roll = rng.next() * (v.covered + v.stricter + v.partial + v.conflict + v.missing);
  let verdict: Verdict;
  let why: string;
  let d = o.days;
  let m = o.frequency ? (INTERVAL[o.frequency] as number) : null;
  let weak = "";
  if (roll < v.covered) {
    verdict = "covered";
    why = "as required";
  } else if (roll < v.covered + v.stricter) {
    verdict = "covered";
    why = "stricter than required";
    if (d !== null) d = Math.max(1, d - rng.int(1, Math.max(1, Math.floor(d / 2))));
    if (m !== null) m = stricter(m);
  } else if (roll < v.covered + v.stricter + v.partial) {
    verdict = "partial";
    if (d !== null || m !== null) {
      if (rng.chance(0.6)) {
        why = d !== null ? "deadline left out" : "frequency left out";
        d = null;
        m = null;
      } else {
        why = "weakened to 'where practicable'";
        weak = rng.pick(WEAK);
      }
    } else {
      why = "weakened to 'where practicable'";
      weak = rng.pick(WEAK);
    }
  } else if (roll < v.covered + v.stricter + v.partial + v.conflict && d === null && m === null) {
    verdict = "partial"; // nothing numeric to contradict: the procedure weakens it instead
    why = "weakened to 'where practicable'";
    weak = rng.pick(WEAK);
  } else if (roll < v.covered + v.stricter + v.partial + v.conflict) {
    verdict = "conflict";
    why = d !== null ? "deadline longer than required" : "less often than required";
    if (d !== null) d = d + rng.int(3, 30);
    if (m !== null) m = looser(m);
  } else {
    verdict = "missing";
    why = "not in the procedure";
  }
  const steps: string[] = [];
  if (verdict === "missing") {
    if (rng.chance(cfg.distractor)) {
      const other = ACTORS[rng.int(1, ACTORS.length - 1)] as string;
      steps.push(
        rng.chance(0.5)
          ? `${other.charAt(0).toUpperCase()}${other.slice(1)} ${rng.pick(verbs)} ${object} and informs ${device.name.toLowerCase()} quality assurance.`
          : `${who} records whether ${object} is needed for the ${device.name.toLowerCase()}; the decision itself is taken under a separate procedure.`,
      );
      why = steps[0]?.includes("separate procedure")
        ? "only a look-alike step that defers it"
        : "only a look-alike step for another party";
    }
    return { truth: { ...o, verdict, steps: [], why }, steps };
  }
  const verb = rng.pick(verbs);
  const tail = [
    d !== null ? days(rng, d, cfg.number_words, cfg.other_units) : "",
    m !== null ? freq(rng, m, cfg.other_frequency_words) : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (!weak && rng.chance(cfg.passive)) {
    const subject = object.charAt(0).toUpperCase() + object.slice(1);
    const plural =
      /^(the )?(records|vulnerabilities|software units|known anomalies|residual anomalies|database records|udi data)/i.test(
        object,
      );
    const part = PASSIVE[a.verb[0] as string] ?? `${a.verb[0]}ed`;
    steps.push(
      `${subject} for the ${device.name.toLowerCase()} ${plural ? "are" : "is"} ${part} by ${who.startsWith("The ") ? `the ${who.slice(4)}` : who}${tail ? ` ${tail}` : ""}.`,
    );
    return { truth: { ...o, verdict, steps: [], why: `${why}; passive voice` }, steps };
  }
  if (verdict === "covered" && d !== null && rng.chance(cfg.split_step)) {
    steps.push(`${who} ${verb} ${object} for the ${device.name.toLowerCase()}.`);
    steps.push(`@PREV The step above is completed ${days(rng, d, cfg.number_words, cfg.other_units)}.`);
    return { truth: { ...o, verdict, steps: [], why: `${why}; deadline in the next step` }, steps };
  }
  const body =
    weak.startsWith("should") || weak.startsWith("aims")
      ? `${who} ${weak}${verb.replace(/s(\s|$)/, "$1")} ${object} for the ${device.name.toLowerCase()}`
      : `${weak ? `${weak.charAt(0).toUpperCase()}${weak.slice(1)}` : ""}${weak && who.startsWith("The ") ? `the ${who.slice(4)}` : who} ${verb} ${object} for the ${device.name.toLowerCase()}`;
  steps.push(`${body}${tail ? ` ${tail}` : ""}.`);
  return { truth: { ...o, verdict, steps: [], why }, steps };
}

const FILLER = (topic: string, device: Device) => [
  `Purpose: this procedure describes how Halden Medical handles ${topicTitle(topic).toLowerCase()} for the ${device.name.toLowerCase()}.`,
  `Scope: it applies to the ${device.name.toLowerCase()} (class ${device.class}) in every market where it is placed.`,
  "Records created under this procedure are kept in the quality management system.",
];

/** Write one procedure per customer, device and topic; version 2 rewrites a share of the steps. */
export function buildSops(rng: Rng, docs: Doc[], devices: Device[], cfg: SopCfg, version = 1): SopWorld {
  const out: SopWorld = { docs: [], truth: [] };
  for (let k = 1; k <= cfg.customers; k++) {
    const customer = `C${k}`;
    for (const dev of devices) {
      const obs = obligationsFor(docs, dev, customer);
      const topics = [...new Set(obs.map((o) => o.topic))].sort();
      topics.forEach((topic, ti) => {
        const r = rng.fork(`sop-${customer}-${dev.id}-${topic}`);
        const r2 = rng.fork(`sop-${customer}-${dev.id}-${topic}-v${version}`);
        const drafts = obs
          .filter((o) => o.topic === topic)
          .map((o) => {
            const first = draftSteps(r, cfg, o, dev);
            if (version === 1 || !r2.chance(cfg.revise_share)) return first;
            const again = draftSteps(r2, cfg, o, dev);
            return {
              ...again,
              truth: { ...again.truth, why: `${again.truth.why} (rewritten in v${version})` },
            };
          });
        const order = r.shuffle([...drafts.keys()]);
        const steps: SopStep[] = [];
        const add = (text: string) => {
          const n = `${ti + 1}.${steps.length + 1}`;
          steps.push({ id: n, text: `${n} ${text}` });
          return n;
        };
        for (const f of FILLER(topic, dev)) add(f);
        for (const i of order) {
          const dft = drafts[i] as Draft;
          const ids: string[] = [];
          let prev = "";
          for (const s of dft.steps) {
            const n = add(
              s.startsWith("@PREV ") ? s.replace("@PREV The step above", `The activity in ${prev}`) : s,
            );
            prev = n;
            ids.push(n);
          }
          // a look-alike step carries no obligation: the truth lists no steps for a missing one
          dft.truth.steps = dft.truth.verdict === "missing" ? [] : ids;
          out.truth.push(dft.truth);
        }
        out.docs.push({
          id: `${customer}-SOP-${dev.id}-${String(ti + 1).padStart(2, "0")}`,
          customer,
          device: dev.id,
          topic,
          title: `${topicTitle(topic)}: procedure for the ${dev.name.toLowerCase()}`,
          version,
          steps,
        });
      });
    }
  }
  return out;
}
