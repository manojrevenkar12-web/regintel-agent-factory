import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DRIFT_KINDS,
  buildWorld,
  clauseUid,
  docLayout,
  impactTruth,
  layoutOf,
  revisions,
  shownAt,
} from "../src/index.js";

const w = buildWorld();
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

describe("the simulated world", () => {
  it("is the same world every time for a seed", () => {
    const again = buildWorld();
    expect(hash(again.docs)).toBe(hash(w.docs));
    expect(hash(again.company)).toBe(hash(w.company));
    expect(hash(again.sources.map((s) => s.drifts))).toBe(hash(w.sources.map((s) => s.drifts)));
  });

  it("puts every kind of drift into a season", () => {
    const kinds = new Set(w.sources.flatMap((s) => s.drifts.map((d) => d.kind)));
    expect(kinds.size).toBe(DRIFT_KINDS);
  });

  it("shows documents newest first, each at its latest version", () => {
    for (const s of w.sources) {
      const shown = shownAt(w, s.id, 60);
      const dates = shown.map((d) => d.published);
      expect([...dates].sort().reverse()).toEqual(dates);
      for (const d of shown) {
        const doc = w.docs.find((x) => x.ref === d.ref);
        const latest = doc?.versions.filter((v) => v.day <= 60).at(-1);
        expect(d.version).toBe(latest?.version);
      }
    }
  });

  it("gives every requirement a true origin and records most links, a few wrongly", () => {
    const reqs = w.company.requirements;
    const linked = reqs.filter((r) => r.trace);
    expect(linked.length / reqs.length).toBeGreaterThan(0.75);
    expect(linked.length / reqs.length).toBeLessThan(0.85);
    const wrong = linked.filter(
      (r) =>
        r.trace?.ref !== r.truth.ref || clauseUid(w, r.truth.ref, 1, r.trace?.clause ?? "") !== r.truth.uid,
    );
    expect(wrong.length).toBeGreaterThan(0);
    expect(wrong.length / linked.length).toBeLessThan(0.08);
  });
});

describe("impact truth", () => {
  const all = revisions(w).map((r) => impactTruth(w, r.ref, r.version));
  const changes = all.flatMap((t) => t.changes);

  it("affects nothing with editorial changes", () => {
    for (const c of changes.filter((x) => !x.substantive)) {
      expect(c.affected).toEqual([]);
      expect(c.gaps).toEqual([]);
      expect(c.kinds.every((k) => k === "reworded" || k === "renumbered")).toBe(true);
    }
  });

  it("only names requirements that come from the changed clause", () => {
    const byId = new Map(w.company.requirements.map((r) => [r.id, r]));
    for (const c of changes) for (const id of c.affected) expect(byId.get(id)?.truth.uid).toBe(c.uid);
  });

  it("has both kinds of change, affected requirements and gaps", () => {
    expect(changes.filter((c) => c.substantive).length).toBeGreaterThan(40);
    expect(changes.filter((c) => !c.substantive).length).toBeGreaterThan(40);
    expect(changes.some((c) => c.kinds.includes("renumbered"))).toBe(true);
    expect(changes.flatMap((c) => c.gaps).length).toBeGreaterThan(5);
  });
});

describe("held-out events", () => {
  const src = w.sources.find((s) => s.id === "tga");
  it("withdraws the oldest documents", () => {
    const before = shownAt(w, "tga", 20);
    const ww = { ...w, events: [{ kind: "withdraw" as const, source: "tga", day: 20, count: 3 }] };
    const after = shownAt(ww, "tga", 20);
    expect(after.length).toBe(before.length - 3);
    expect(shownAt(ww, "tga", 19).length).toBe(shownAt(w, "tga", 19).length);
  });

  it("corrects a clause in place without a new version", () => {
    const ww = { ...w, events: [{ kind: "silent_edit" as const, source: "tga", day: 20 }] };
    const a = shownAt(w, "tga", 20);
    const b = shownAt(ww, "tga", 20);
    const changed = b.filter((d, i) => JSON.stringify(d.clauses) !== JSON.stringify(a[i]?.clauses));
    expect(changed.length).toBe(1);
    expect(changed[0]?.version).toBe(a.find((d) => d.ref === changed[0]?.ref)?.version);
  });

  it("splits document pages between two templates", () => {
    if (!src) throw new Error("no tga");
    const ww = {
      ...w,
      events: [
        { kind: "template_split" as const, source: "tga", day: 20, change: { clauses: "dl" as const } },
      ],
    };
    const refs = shownAt(ww, "tga", 20)
      .map((d) => d.ref)
      .sort();
    const layouts = refs.map((r) => docLayout(ww, src, 20, r).clauses);
    expect(layouts.slice(0, 3)).toEqual(["dl", "dl", "dl"]);
    expect(layouts).toContain(layoutOf(src, 20).clauses);
  });
});
