/** Regulatory documents as meaning first, text second. A clause is an obligation (who must do what,
 * to which devices, by when); its text is rendered from that, in one of several wordings. A change
 * either changes the obligation (substantive) or only the wording or numbering (editorial), and the
 * truth records which. */
import type { Rng } from "./rng.js";

export const CLASSES = ["I", "IIa", "IIb", "III"] as const;
export type DeviceClass = (typeof CLASSES)[number];

export type Obligation = {
  topic: string;
  actor: string;
  modal: "shall" | "should";
  action: number; // index into the topic's actions
  classes: DeviceClass[]; // the devices it applies to
  days: number | null; // a deadline, when the action has one
  frequency: string | null; // a recurrence, when the action has one
};

export type Clause = { id: string; uid: string; ob: Obligation; wording: number }; // uid: the clause's identity across versions (truth only)
export type DocVersion = { version: number; day: number; clauses: Clause[]; changes: ClauseChange[] };
export type Doc = {
  ref: string;
  source: string;
  title: string;
  topic: string;
  published: number;
  versions: DocVersion[];
};

export type ChangeKind =
  | "modal"
  | "deadline"
  | "frequency"
  | "scope"
  | "added"
  | "removed"
  | "reworded"
  | "renumbered";
export type ClauseChange = {
  kind: ChangeKind;
  substantive: boolean;
  before: string | null; // clause id in the previous version
  after: string | null; // clause id in this version
};

type Topic = {
  name: string;
  title: string;
  actions: { verb: string[]; object: string[]; deadline?: [number, number]; recurring?: boolean }[];
};

/** Each action has two or three equivalent wordings; editorial changes switch between them. */
export const TOPICS: Topic[] = [
  {
    name: "pms",
    title: "Post-market surveillance",
    actions: [
      {
        verb: ["establish and maintain", "set up and keep up to date"],
        object: ["a post-market surveillance plan", "a plan for post-market surveillance"],
      },
      {
        verb: ["update", "revise"],
        object: ["the periodic safety update report", "the PSUR"],
        recurring: true,
      },
      {
        verb: ["analyse", "evaluate"],
        object: ["trend data on non-serious incidents", "trends in incidents that are not serious"],
        recurring: true,
      },
      {
        verb: ["report", "notify the authority of"],
        object: [
          "any statistically significant increase in incidents",
          "a statistically significant rise in incidents",
        ],
        deadline: [10, 30],
      },
    ],
  },
  {
    name: "vigilance",
    title: "Vigilance and incident reporting",
    actions: [
      {
        verb: ["report", "notify"],
        object: [
          "serious incidents to the competent authority",
          "each serious incident to the competent authority",
        ],
        deadline: [2, 15],
      },
      {
        verb: ["submit", "send"],
        object: [
          "a field safety notice before a field safety corrective action",
          "the field safety notice prior to any field safety corrective action",
        ],
        deadline: [1, 10],
      },
      {
        verb: ["investigate", "examine"],
        object: ["the root cause of each serious incident", "why each serious incident occurred"],
        deadline: [10, 60],
      },
      { verb: ["keep", "retain"], object: ["a record of all complaints", "records of every complaint"] },
    ],
  },
  {
    name: "udi",
    title: "Unique device identification and labelling",
    actions: [
      {
        verb: ["assign", "allocate"],
        object: ["a unique device identifier to each device", "a UDI to every device"],
      },
      {
        verb: ["register", "enter"],
        object: ["the UDI in the device database", "UDI data into the device database"],
        deadline: [5, 30],
      },
      {
        verb: ["place", "affix"],
        object: ["the UDI carrier on the label", "the UDI carrier on the device label"],
      },
      {
        verb: ["update", "amend"],
        object: ["the database entry after a change to the device", "database records after a device change"],
        deadline: [10, 30],
      },
    ],
  },
  {
    name: "software",
    title: "Medical device software lifecycle",
    actions: [
      {
        verb: ["document", "record"],
        object: ["a software development plan", "the plan for software development"],
      },
      {
        verb: ["classify", "assign"],
        object: ["each software item by its safety class", "a safety class to each software item"],
      },
      {
        verb: ["verify", "test"],
        object: [
          "software units against their acceptance criteria",
          "each software unit against its acceptance criteria",
        ],
      },
      {
        verb: ["evaluate", "assess"],
        object: ["known anomalies before release", "residual anomalies prior to release"],
      },
    ],
  },
  {
    name: "cyber",
    title: "Cybersecurity for medical devices",
    actions: [
      { verb: ["maintain", "keep"], object: ["a software bill of materials", "an SBOM for the device"] },
      {
        verb: ["assess", "evaluate"],
        object: [
          "vulnerabilities in third-party components",
          "known vulnerabilities in third-party components",
        ],
        recurring: true,
      },
      {
        verb: ["patch", "remediate"],
        object: ["critical vulnerabilities", "vulnerabilities rated critical"],
        deadline: [7, 60],
      },
      {
        verb: ["perform", "carry out"],
        object: ["penetration testing before release", "a penetration test prior to release"],
      },
    ],
  },
  {
    name: "clinical",
    title: "Clinical evaluation",
    actions: [
      {
        verb: ["plan and conduct", "plan and carry out"],
        object: ["a clinical evaluation", "the clinical evaluation of the device"],
      },
      { verb: ["update", "revise"], object: ["the clinical evaluation report", "the CER"], recurring: true },
      {
        verb: ["justify", "give reasons for"],
        object: [
          "any claim of equivalence to another device",
          "each claim of equivalence with another device",
        ],
      },
    ],
  },
  {
    name: "risk",
    title: "Risk management",
    actions: [
      { verb: ["establish", "set up"], object: ["a risk management process", "the risk management process"] },
      {
        verb: ["review", "re-examine"],
        object: ["the risk management file", "the file for risk management"],
        recurring: true,
      },
      { verb: ["evaluate", "assess"], object: ["the overall residual risk", "residual risk as a whole"] },
    ],
  },
  {
    name: "usability",
    title: "Usability engineering",
    actions: [
      {
        verb: ["identify", "determine"],
        object: [
          "the user interface characteristics related to safety",
          "safety-related characteristics of the user interface",
        ],
      },
      {
        verb: ["conduct", "run"],
        object: ["a summative usability evaluation", "the summative evaluation of usability"],
      },
    ],
  },
];

export const ACTORS = ["the manufacturer", "the authorised representative", "the importer"];
export const FREQUENCIES = ["annually", "every two years", "every six months", "quarterly"];

const topicOf = (name: string) => TOPICS.find((t) => t.name === name) as Topic;

export function newObligation(rng: Rng, topic: string, actionIndex?: number): Obligation {
  const t = topicOf(topic);
  const action = actionIndex ?? rng.int(0, t.actions.length - 1);
  const a = t.actions[action] as Topic["actions"][number];
  const from = rng.int(0, 2);
  return {
    topic,
    actor: rng.chance(0.8) ? (ACTORS[0] as string) : rng.pick(ACTORS),
    modal: rng.chance(0.85) ? "shall" : "should",
    action,
    classes: CLASSES.slice(from) as DeviceClass[],
    days: a.deadline ? rng.int(a.deadline[0], a.deadline[1]) : null,
    frequency: a.recurring ? rng.pick(FREQUENCIES) : null,
  };
}

const classList = (cs: DeviceClass[]) =>
  cs.length === 4
    ? "all devices"
    : cs.length === 1
      ? `class ${cs[0]} devices`
      : `class ${cs.slice(0, -1).join(", ")} and ${cs.at(-1)} devices`;

/** The clause text for an obligation in one of its wordings. Wording changes are editorial. */
export function render(ob: Obligation, wording: number): string {
  const a = topicOf(ob.topic).actions[ob.action] as Topic["actions"][number];
  const verb = a.verb[wording % a.verb.length] as string;
  const object = a.object[wording % a.object.length] as string;
  const scope =
    wording % 2 === 0
      ? `For ${classList(ob.classes)}, ${ob.actor} ${ob.modal}`
      : `${cap(ob.actor)} ${ob.modal}, for ${classList(ob.classes)},`;
  const when = ob.days !== null ? ` within ${ob.days} days` : "";
  const freq = ob.frequency ? ` ${ob.frequency}` : "";
  const sentence = `${scope} ${verb} ${object}${when}${freq}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function topicTitle(topic: string) {
  return topicOf(topic).title;
}

export function sameObligation(a: Obligation, b: Obligation): boolean {
  return (
    a.topic === b.topic &&
    a.actor === b.actor &&
    a.modal === b.modal &&
    a.action === b.action &&
    a.days === b.days &&
    a.frequency === b.frequency &&
    a.classes.join() === b.classes.join()
  );
}

/** Revise a document: a few clause changes, each recorded with whether it changes an obligation. */
export function revise(
  rng: Rng,
  prev: DocVersion,
  day: number,
  n: number,
  editorialShare: number,
): DocVersion {
  let clauses = prev.clauses.map((c) => ({ ...c, ob: { ...c.ob, classes: [...c.ob.classes] } }));
  const changes: ClauseChange[] = [];
  const topic = clauses[0]?.ob.topic ?? "pms";
  for (let i = 0; i < n; i++) {
    const editorial = rng.chance(editorialShare);
    if (editorial) {
      if (rng.chance(0.25) && clauses.length > 3) {
        // renumbering: a clause moves to the end and every id after it shifts
        const k = rng.int(0, clauses.length - 2);
        const [moved] = clauses.splice(k, 1);
        clauses.push(moved as Clause);
        const renamed = renumber(clauses);
        for (const [from, to] of renamed)
          changes.push({ kind: "renumbered", substantive: false, before: from, after: to });
        clauses = clauses.map((c) => ({ ...c, id: renamed.get(c.id) ?? c.id }));
      } else {
        const c = rng.pick(clauses);
        c.wording = c.wording + 1;
        changes.push({ kind: "reworded", substantive: false, before: c.id, after: c.id });
      }
      continue;
    }
    const roll = rng.next();
    if (roll < 0.15) {
      const id = nextId(clauses);
      const usedPairs = new Set(clauses.map((c) => `${c.ob.topic}:${c.ob.action}`));
      const free = TOPICS.flatMap((t) => t.actions.map((_, a) => [t.name, a] as const)).filter(
        ([t, a]) => !usedPairs.has(`${t}:${a}`),
      );
      const [t, a] = rng.pick(free);
      clauses.push({
        id,
        uid: `${prev.clauses[0]?.uid.split("#")[0]}#v${prev.version + 1}-${clauses.length}`,
        ob: newObligation(rng, t, a),
        wording: 0,
      });
      changes.push({ kind: "added", substantive: true, before: null, after: id });
    } else if (roll < 0.25 && clauses.length > 6) {
      const k = rng.int(0, clauses.length - 1);
      const [gone] = clauses.splice(k, 1);
      changes.push({ kind: "removed", substantive: true, before: (gone as Clause).id, after: null });
    } else {
      const c = rng.pick(clauses);
      const a = topicOf(c.ob.topic).actions[c.ob.action] as Topic["actions"][number];
      const options: ChangeKind[] = ["modal", "scope"];
      if (c.ob.days !== null && a.deadline) options.push("deadline", "deadline");
      if (c.ob.frequency) options.push("frequency");
      const kind = rng.pick(options);
      if (kind === "modal") c.ob.modal = c.ob.modal === "shall" ? "should" : "shall";
      if (kind === "deadline" && c.ob.days !== null) {
        let d = c.ob.days;
        while (d === c.ob.days)
          d = rng.int((a.deadline as [number, number])[0], (a.deadline as [number, number])[1]);
        c.ob.days = d;
      }
      if (kind === "frequency") c.ob.frequency = rng.pick(FREQUENCIES.filter((f) => f !== c.ob.frequency));
      if (kind === "scope") {
        // widen to one more class (more common) or narrow by one
        const from = CLASSES.indexOf(c.ob.classes[0] as DeviceClass);
        const to = from === 0 ? 1 : from === 3 ? 2 : rng.chance(0.7) ? from - 1 : from + 1;
        c.ob.classes = CLASSES.slice(to) as DeviceClass[];
      }
      changes.push({ kind, substantive: true, before: c.id, after: c.id });
    }
  }
  return { version: prev.version + 1, day, clauses, changes: dedupe(changes) };
}

function renumber(clauses: Clause[]): Map<string, string> {
  const m = new Map<string, string>();
  clauses.forEach((c, i) => {
    const id = clauseId(i);
    if (id !== c.id) m.set(c.id, id);
  });
  return m;
}

export const clauseId = (i: number) => `${Math.floor(i / 4) + 1}.${(i % 4) + 1}`;
const indexOf = (id: string) => {
  const [a, b] = id.split(".").map(Number);
  return ((a ?? 1) - 1) * 4 + ((b ?? 1) - 1);
};
const nextId = (clauses: Clause[]) => clauseId(Math.max(-1, ...clauses.map((c) => indexOf(c.id))) + 1);

function dedupe(changes: ClauseChange[]): ClauseChange[] {
  const seen = new Set<string>();
  return changes.filter((c) => {
    const k = `${c.kind}:${c.before}:${c.after}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function newDoc(rng: Rng, source: string, ref: string, day: number): Doc {
  const topic = rng.pick(TOPICS).name;
  // a document covers its own topic fully and borrows obligations from two others, never repeating one
  const others = rng.shuffle(TOPICS.filter((t) => t.name !== topic)).slice(0, 2);
  const pool = [topicOf(topic), ...others].flatMap((t) => t.actions.map((_, a) => [t.name, a] as const));
  const own = pool.filter(([t]) => t === topic);
  const borrowed = rng.shuffle(pool.filter(([t]) => t !== topic)).slice(0, rng.int(2, 6));
  const picked = [...own, ...borrowed];
  const clauses: Clause[] = picked.map(([t, a], i) => ({
    id: clauseId(i),
    uid: `${ref}#${i}`,
    ob: newObligation(rng, t, a),
    wording: rng.int(0, 1),
  }));
  const kind = rng.pick(["Guidance on", "Requirements for", "Questions and answers on", "Position paper on"]);
  return {
    ref,
    source,
    title: `${kind} ${topicTitle(topic).toLowerCase()}`,
    topic,
    published: day,
    versions: [{ version: 1, day, clauses, changes: [] }],
  };
}
