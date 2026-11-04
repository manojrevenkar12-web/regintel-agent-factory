/** A device manufacturer's traceability graph: requirements derived from regulatory clauses, the
 * SOP sections and verification tests that implement them, and the trace links the company actually
 * recorded (most, not all, and a few wrong). The truth is which clause each requirement came from. */
import { CLASSES, type DeviceClass, type Doc, type Obligation } from "./corpus.js";
import type { Rng } from "./rng.js";

export type Device = { id: string; name: string; class: DeviceClass };

export type Requirement = {
  id: string;
  device: string;
  text: string;
  topic: string;
  trace: { ref: string; clause: string } | null; // what the company recorded (may be missing or wrong)
  truth: { ref: string; uid: string }; // where it really comes from
};
export type SopSection = { id: string; title: string; topic: string; device: string; requirements: string[] };
export type Test = { id: string; title: string; requirement: string };
export type Company = {
  name: string;
  devices: Device[];
  requirements: Requirement[];
  sops: SopSection[];
  tests: Test[];
};

export const applies = (ob: Obligation, d: Device) => ob.classes.includes(d.class);

// The company words its requirements its own way: same meaning, different words from the regulator's.
const VERBS: Record<string, string> = {
  "establish and maintain": "operate and keep current",
  report: "inform the authority of",
  update: "bring up to date",
  analyse: "review",
  submit: "issue",
  investigate: "determine the cause of",
  keep: "maintain records of",
  assign: "give",
  register: "record",
  place: "print",
  document: "write down",
  classify: "rate",
  verify: "check",
  evaluate: "judge",
  maintain: "keep current",
  assess: "review",
  patch: "fix",
  perform: "complete",
  "plan and conduct": "carry out",
  justify: "support with evidence",
  establish: "run",
  review: "go over",
  identify: "list",
  conduct: "perform",
};

export function requirementText(ob: Obligation, device: Device, object: string, verb: string): string {
  const v = VERBS[verb] ?? verb;
  const when = ob.days !== null ? ` no later than ${ob.days} calendar days after it becomes known` : "";
  const freq = ob.frequency ? `, at least ${ob.frequency}` : "";
  const strength = ob.modal === "shall" ? "must" : "is expected to";
  return `Halden Medical ${strength} ${v} ${object.replace(/^the |^a |^an /, "the ")} for the ${device.name.toLowerCase()}${when}${freq}.`;
}

/** Requirements for every clause that applies to a device, for the documents in force at day 0. */
export function buildCompany(
  rng: Rng,
  name: string,
  devices: Device[],
  docs: Doc[],
  words: (ob: Obligation) => { verb: string; object: string },
  coverage: number,
  wrongRate: number,
): Company {
  const requirements: Requirement[] = [];
  const allClauses = docs.flatMap((d) => (d.versions[0]?.clauses ?? []).map((c) => ({ ref: d.ref, c })));
  let n = 0;
  for (const d of docs) {
    const v1 = d.versions[0];
    if (!v1) continue;
    for (const c of v1.clauses) {
      for (const dev of devices) {
        if (!applies(c.ob, dev)) continue;
        n++;
        const w = words(c.ob);
        let trace: Requirement["trace"] = { ref: d.ref, clause: c.id };
        if (!rng.chance(coverage)) trace = null;
        else if (rng.chance(wrongRate)) {
          const other = rng.pick(allClauses);
          trace = { ref: other.ref, clause: other.c.id };
        }
        requirements.push({
          id: `REQ-${dev.id}-${String(n).padStart(4, "0")}`,
          device: dev.id,
          text: requirementText(c.ob, dev, w.object, w.verb),
          topic: c.ob.topic,
          trace,
          truth: { ref: d.ref, uid: c.uid },
        });
      }
    }
  }
  const sops: SopSection[] = [];
  const tests: Test[] = [];
  const topics = [...new Set(requirements.map((r) => r.topic))].sort();
  for (const dev of devices) {
    topics.forEach((t, i) => {
      const reqs = requirements.filter((r) => r.device === dev.id && r.topic === t);
      if (!reqs.length) return;
      sops.push({
        id: `SOP-${dev.id}-${String(i + 1).padStart(2, "0")}`,
        title: `${t} procedure for the ${dev.name.toLowerCase()}`,
        topic: t,
        device: dev.id,
        requirements: reqs.map((r) => r.id),
      });
    });
  }
  for (const r of requirements)
    tests.push({ id: r.id.replace("REQ-", "TST-"), title: `Verification of ${r.id}`, requirement: r.id });
  return { name, devices, requirements, sops, tests };
}

export { CLASSES };
