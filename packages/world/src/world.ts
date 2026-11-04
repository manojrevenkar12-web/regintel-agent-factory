/** The whole world for a season, built from config/world.yaml and a seed: what each regulator
 * publishes and when, how each site's layout drifts, which days are maintenance or rate-limited,
 * and the company whose requirements trace to it all. Everything here is truth. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { type Company, type Device, applies, buildCompany } from "./company.js";
import { type Doc, type DocVersion, TOPICS, newDoc, render, revise, sameObligation } from "./corpus.js";
import { Rng } from "./rng.js";
import {
  DRIFT_KINDS,
  type Drift,
  type Layout,
  type ShownDoc,
  initialLayout,
  layoutAt,
  scheduleDrifts,
} from "./sites.js";

export const ROOT = process.env.RIF_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export type SourceCfg = {
  id: string;
  name: string;
  ref_prefix: string;
  layout: Layout["listing"];
  docs: number;
};
export type WorldCfg = {
  seed: number;
  days: number;
  start_date: string;
  sources: SourceCfg[];
  publishing: {
    new_doc_per_100_days: number;
    revision_per_100_days: number;
    changes_per_revision: [number, number];
    editorial_share: number;
  };
  drift: { per_source: [number, number]; maintenance_days: number; rate_limit_bursts: number };
  company: { name: string; devices: Device[]; trace_link_coverage: number; wrong_link_rate: number };
};

export type Source = SourceCfg & {
  initial: Layout;
  drifts: Drift[];
  maintenance: number[];
  rateLimited: number[];
};

/** Things that happen to a site that are not ordinary drift, used by the held-out incidents:
 *   withdraw         the regulator takes its oldest documents down (the listing really shrinks)
 *   silent_edit      a published clause is corrected without a new version (the content really changed)
 *   template_split   the site moves some document pages to a new template and leaves the rest on the
 *                    old one (the first pages in reference order move, then every other one) */
export type WorldEvent = {
  kind: "withdraw" | "silent_edit" | "template_split";
  source: string;
  day: number;
  count?: number;
  change?: Partial<Layout>;
};

export type World = {
  cfg: WorldCfg;
  sources: Source[];
  docs: Doc[];
  company: Company;
  date: (day: number) => string;
  events: WorldEvent[];
};

export const loadWorldCfg = (path = join(ROOT, "config/world.yaml")): WorldCfg =>
  parse(readFileSync(path, "utf8")) as WorldCfg;

export function buildWorld(cfg: WorldCfg = loadWorldCfg()): World {
  const rng = new Rng(cfg.seed);
  const start = Date.parse(`${cfg.start_date}T00:00:00Z`);
  const date = (day: number) => new Date(start + day * 86_400_000).toISOString().slice(0, 10);
  const docs: Doc[] = [];
  // every kind of drift happens at least once in a season, spread over the sites
  const counts = cfg.sources.map((s) =>
    rng.fork(`n-${s.id}`).int(cfg.drift.per_source[0], cfg.drift.per_source[1]),
  );
  const deck = rng.fork("drifts").shuffle([...Array(DRIFT_KINDS).keys()]);
  const kinds: number[][] = counts.map(() => []);
  let k = 0;
  counts.forEach((c, i) => {
    while ((kinds[i] as number[]).length < c) {
      const pick = k < deck.length ? (deck[k] as number) : rng.int(0, DRIFT_KINDS - 1);
      k++;
      if (!(kinds[i] as number[]).includes(pick)) (kinds[i] as number[]).push(pick);
    }
  });
  const sources: Source[] = cfg.sources.map((s, si) => {
    const r = rng.fork(s.id);
    let serial = 0;
    const ref = (day: number) =>
      `${s.ref_prefix}-${date(day).slice(0, 4)}-${String(++serial).padStart(3, "0")}`;
    // documents already in force before the season, oldest first
    const before = Array.from({ length: s.docs }, () => -r.int(30, 900)).sort((a, b) => a - b);
    for (const d of before) docs.push(newDoc(r, s.id, ref(d), d));
    const mine = () => docs.filter((d) => d.source === s.id);
    for (let day = 1; day < cfg.days; day++) {
      if (r.chance(cfg.publishing.new_doc_per_100_days / 100)) docs.push(newDoc(r, s.id, ref(day), day));
      if (r.chance(cfg.publishing.revision_per_100_days / 100)) {
        const target = r.pick(mine().filter((d) => d.published < day));
        const prev = target.versions.at(-1) as DocVersion;
        if (prev.day < day) {
          const n = r.int(cfg.publishing.changes_per_revision[0], cfg.publishing.changes_per_revision[1]);
          target.versions.push(revise(r, prev, day, n, cfg.publishing.editorial_share));
        }
      }
    }
    const initial = initialLayout(s.layout);
    const drifts = scheduleDrifts(r, cfg.days, kinds[si] as number[], initial);
    const busy = new Set(drifts.map((d) => d.day));
    const pickDays = (n: number) => {
      const out: number[] = [];
      while (out.length < n) {
        const d = r.int(3, cfg.days - 2);
        if (!busy.has(d) && !out.includes(d)) out.push(d);
      }
      return out.sort((a, b) => a - b);
    };
    return {
      ...s,
      initial,
      drifts,
      maintenance: pickDays(cfg.drift.maintenance_days),
      rateLimited: pickDays(cfg.drift.rate_limit_bursts),
    };
  });
  const atStart = docs.filter((d) => d.published <= 0);
  const words = (ob: { topic: string; action: number }) => {
    const a = (TOPICS.find((t) => t.name === ob.topic) as (typeof TOPICS)[number]).actions[
      ob.action
    ] as (typeof TOPICS)[number]["actions"][number];
    return { verb: a.verb[0] as string, object: a.object[1] ?? (a.object[0] as string) };
  };
  const company = buildCompany(
    rng.fork("company"),
    cfg.company.name,
    cfg.company.devices,
    atStart,
    words,
    cfg.company.trace_link_coverage,
    cfg.company.wrong_link_rate,
    (id) => (cfg.sources.find((s) => s.id === id) as SourceCfg).name,
    (day) => date(day).slice(0, 4),
  );
  return { cfg, sources, docs, company, date, events: [] };
}

export function versionAt(doc: Doc, day: number): DocVersion | undefined {
  return [...doc.versions].reverse().find((v) => v.day <= day);
}

/** What a site shows on a day: its documents, newest first, each at its latest version. */
export function shownAt(w: World, source: string, day: number): ShownDoc[] {
  const active = w.events.filter((e) => e.source === source && e.day <= day);
  const mine = w.docs.filter((d) => d.source === source && d.published <= day);
  const withdrawn = new Set(
    active
      .filter((e) => e.kind === "withdraw")
      .flatMap((e) =>
        [...mine]
          .sort((a, b) => a.published - b.published)
          .slice(0, e.count ?? 3)
          .map((d) => d.ref),
      ),
  );
  const edited = active.some((e) => e.kind === "silent_edit")
    ? [...mine].map((d) => d.ref).sort()[0]
    : undefined;
  return mine
    .filter((d) => !withdrawn.has(d.ref))
    .map((d) => {
      const v = versionAt(d, day) as DocVersion;
      return {
        ref: d.ref,
        title: d.title,
        version: v.version,
        published: w.date(v.day),
        effective: w.date(v.day + 30),
        clauses: v.clauses.map((c, i) => {
          const text = render(c.ob, c.wording);
          // a correction published in place: same version, one clause reworded
          return {
            id: c.id,
            text:
              d.ref === edited && i === 0
                ? text.replace(/the manufacturer/i, "the legal manufacturer")
                : text,
          };
        }),
      };
    })
    .sort((a, b) =>
      a.published < b.published ? 1 : a.published > b.published ? -1 : a.ref < b.ref ? 1 : -1,
    );
}

export const layoutOf = (s: Source, day: number) => layoutAt(s.initial, s.drifts, day);

/** The layout one document page is rendered with: the site's, unless a template split left it on
 * the old template. */
export function docLayout(w: World, s: Source, day: number, ref: string): Layout {
  const l = layoutOf(s, day);
  const split = w.events.find((e) => e.kind === "template_split" && e.source === s.id && e.day <= day);
  if (!split) return l;
  const refs = shownAt(w, s.id, day)
    .map((d) => d.ref)
    .sort();
  const i = refs.indexOf(ref);
  const migrated = i < 3 || i % 2 === 1;
  return migrated ? { ...l, ...split.change } : l;
}

/** For one new version, what really changed, by clause identity (not by number, which the document
 * may have shifted): per changed clause, the kinds of change, whether an obligation changed, which
 * existing requirements it affects and which devices it newly brings into scope without one (gaps).
 * Editorial changes (rewording, renumbering) affect nothing. */
export type TruthChange = {
  uid: string;
  before: string | null; // clause number in the previous version
  after: string | null; // clause number in this version
  kinds: string[];
  substantive: boolean;
  affected: string[];
  gaps: string[];
};
export type ImpactTruth = { ref: string; version: number; changes: TruthChange[] };

export function impactTruth(w: World, ref: string, version: number, from = version - 1): ImpactTruth {
  const doc = w.docs.find((d) => d.ref === ref) as Doc;
  const v = doc.versions.find((x) => x.version === version) as DocVersion;
  const prev = doc.versions.find((x) => x.version === from) as DocVersion;
  const uids = [...new Set([...prev.clauses, ...v.clauses].map((c) => c.uid))];
  const changes: TruthChange[] = [];
  for (const uid of uids) {
    const before = prev.clauses.find((c) => c.uid === uid);
    const after = v.clauses.find((c) => c.uid === uid);
    const kinds: string[] = [];
    if (!before) kinds.push("added");
    else if (!after) kinds.push("removed");
    else {
      const a = before.ob;
      const b = after.ob;
      if (a.modal !== b.modal) kinds.push("modal");
      if (a.days !== b.days) kinds.push("deadline");
      if (a.frequency !== b.frequency) kinds.push("frequency");
      if (a.classes.join() !== b.classes.join()) kinds.push("scope");
      if (a.actor !== b.actor) kinds.push("actor");
      if (before.wording !== after.wording) kinds.push("reworded");
      if (before.id !== after.id) kinds.push("renumbered");
    }
    if (!kinds.length) continue;
    const substantive = !before || !after || !sameObligation(before.ob, after.ob);
    const affected = new Set<string>();
    const gaps = new Set<string>();
    if (substantive) {
      const reqs = w.company.requirements.filter((r) => r.truth.uid === uid);
      for (const dev of w.company.devices) {
        const had = before ? applies(before.ob, dev) : false;
        const has = after ? applies(after.ob, dev) : false;
        const mine = reqs.filter((r) => r.device === dev.id).map((r) => r.id);
        if (had && has) for (const r of mine) affected.add(r); // the obligation changed: review it
        if (had && !has) for (const r of mine) affected.add(r); // out of scope or removed: retire it
        if (!had && has) {
          if (mine.length) for (const r of mine) affected.add(r);
          else gaps.add(dev.id);
        }
      }
    }
    changes.push({
      uid,
      before: before?.id ?? null,
      after: after?.id ?? null,
      kinds,
      substantive,
      affected: [...affected].sort(),
      gaps: [...gaps].sort(),
    });
  }
  return { ref, version, changes };
}

/** Which clause (by identity) a clause number in a version holds; for scoring relinks. */
export function clauseUid(w: World, ref: string, version: number, id: string): string | null {
  const doc = w.docs.find((d) => d.ref === ref);
  return doc?.versions.find((x) => x.version === version)?.clauses.find((c) => c.id === id)?.uid ?? null;
}

/** Every revision published during the season, in order. */
export function revisions(w: World): { ref: string; source: string; version: number; day: number }[] {
  return w.docs
    .flatMap((d) =>
      d.versions
        .filter((v) => v.version > 1 && v.day > 0)
        .map((v) => ({ ref: d.ref, source: d.source, version: v.version, day: v.day })),
    )
    .sort((a, b) => a.day - b.day || a.ref.localeCompare(b.ref));
}
