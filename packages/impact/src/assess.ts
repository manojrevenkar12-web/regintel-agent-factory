import type { ScrapedDoc } from "@rif/ingest";
/** Change impact for one new document version.
 *
 *   rules read the clause diff (what changed, editorial or substantive, which devices were and are
 *   in scope); for each substantive change a matcher finds the requirements that implement the
 *   clause, per device in scope; devices newly in scope with no such requirement are gaps; trace
 *   links to renumbered clauses are moved, links to removed clauses retired, and missing links to
 *   matched requirements proposed.
 *
 * Matchers, so each can be measured against the others:
 *   links       the company's recorded trace links only
 *   retrieval   the best retrieval hit per device
 *   rules       links checked against the clause text, then retrieval + rationale + parameter
 *               agreement, with a margin; ambiguous cases are flagged for the expert, not guessed
 *   model       a model reads the clause and the candidates and picks, quoting the requirement;
 *               a verifier drops any pick that is not a candidate, not in scope or misquoted
 *   model-raw   the same reading without the verifier (to measure what the verifier is worth)
 */
import { type Change, type Params, diffVersions, readParams, similarity } from "./diff.js";
import { type Reader, lastJsonObject } from "./reader.js";
import { type Index, terms } from "./retrieve.js";

export type Device = { id: string; name: string; class: string };
export type Requirement = { id: string; device: string; text: string; topic: string; rationale: string };
export type Link = { ref: string; clause: string };
export type Graph = { devices: Device[]; requirements: Requirement[] };
export type DocMeta = { ref: string; title: string; source: string; authority: string; published: string };
export type Method = "links" | "retrieval" | "rules" | "model" | "model-raw";

export type Pick = {
  requirement: string;
  device: string;
  via: "link" | "rules" | "retrieval" | "model";
  quote?: string;
  why: string;
};
export type AssessedChange = {
  id: string;
  kind: Change["kind"];
  before: { id: string; text: string } | null;
  after: { id: string; text: string } | null;
  verdict: "substantive" | "editorial";
  rule: Change["rule"];
  changed: (keyof Params)[];
  scopeBefore: string[];
  scopeAfter: string[];
  affected: Pick[];
  gaps: { device: string; why: string }[];
  flags: string[]; // for the expert: what the platform could not decide
};
export type Relink = { requirement: string; from: Link | null; to: Link | null; why: string };
export type Assessment = {
  ref: string;
  version: number;
  method: Method;
  changes: AssessedChange[];
  relinks: Relink[];
  rejected: { change: string; pick: unknown; reason: string }[];
  cost_usd: number;
  seconds: number;
  model_calls: number;
  errors: string[];
};

export type RulesCfg = {
  link_agreement: number;
  min_score: number;
  rationale_weight: number;
  margin: number;
};
export type Context = {
  graph: Graph;
  links: Map<string, Link>; // requirement id -> its current recorded link
  index: Index; // over requirement text + rationale
  clauseText: (ref: string, clause: string) => string | null; // the platform's current copy of any clause
  meta: DocMeta;
  rules: RulesCfg;
  perDevice: number;
  minSimilarity: number;
  reader?: Reader;
};

const inScope = (p: Params | null, devices: Device[]) =>
  p === null
    ? []
    : p.classes === null
      ? devices.map((d) => d.id)
      : devices.filter((d) => p.classes?.includes(d.class)).map((d) => d.id);

/** How well a requirement's free-text rationale points at this document: authority, subject, year. */
export function rationaleMatch(rationale: string, meta: DocMeta): number {
  if (!rationale) return 0;
  const r = new Set(terms(rationale));
  const has = (s: string) => {
    const t = terms(s);
    return t.length ? t.filter((w) => r.has(w)).length / t.length : 0;
  };
  const subject = meta.title.replace(
    /^(Guidance on|Requirements for|Questions and answers on|Position paper on) /,
    "",
  );
  const kind = meta.title.slice(0, meta.title.length - subject.length);
  const year = meta.published.slice(0, 4);
  return (has(meta.authority) + has(subject) + (r.has(year) ? 1 : 0) + 0.5 * has(kind)) / 3.5;
}

/** Do the requirement's stated deadline, recurrence and strength agree with the clause? */
export function paramAgreement(req: string, clause: Params): number {
  let s = 0;
  const days = req.match(/no later than (\d+) calendar days/);
  if (clause.days !== null) s += days && Number(days[1]) === clause.days ? 0.15 : -0.3;
  else if (days) s -= 0.3;
  const freq = req.match(/at least ([a-z ]+?)[.,]/)?.[1] ?? null;
  if (clause.frequency !== null) s += freq === clause.frequency ? 0.15 : -0.3;
  else if (freq) s -= 0.3;
  return s;
}

function candidates(ctx: Context, clause: string, device: string, k: number) {
  const mine = new Set(ctx.graph.requirements.filter((r) => r.device === device).map((r) => r.id));
  return ctx.index.search(clause, mine).slice(0, k);
}

const reqOf = (ctx: Context, id: string) => ctx.graph.requirements.find((r) => r.id === id);

/** A recorded link counts if the requirement reads like the clause it points at. */
function linkHolds(ctx: Context, req: Requirement, link: Link): boolean {
  const t = ctx.clauseText(link.ref, link.clause);
  return t !== null && similarity(req.text, t) >= ctx.rules.link_agreement;
}

function matchLinks(ctx: Context, ch: Change, device: string): Pick[] {
  const b = ch.before;
  if (!b) return [];
  return ctx.graph.requirements
    .filter(
      (r) =>
        r.device === device &&
        ctx.links.get(r.id)?.ref === ctx.meta.ref &&
        ctx.links.get(r.id)?.clause === b.id,
    )
    .map((r) => ({
      requirement: r.id,
      device,
      via: "link" as const,
      why: `recorded trace link to ${ctx.meta.ref} ${b.id}`,
    }));
}

function matchRetrieval(ctx: Context, ch: Change, device: string): Pick[] {
  const b = ch.before;
  if (!b) return [];
  const top = candidates(ctx, b.text, device, 1)[0];
  return top && top.score >= ctx.rules.min_score
    ? [{ requirement: top.id, device, via: "retrieval", why: `best retrieval hit (${top.score.toFixed(2)})` }]
    : [];
}

function matchRules(ctx: Context, ch: Change, device: string, flags: string[]): Pick[] {
  const b = ch.before;
  if (!b) return [];
  const linked = matchLinks(ctx, ch, device).filter((p) =>
    linkHolds(ctx, reqOf(ctx, p.requirement) as Requirement, ctx.links.get(p.requirement) as Link),
  );
  if (linked.length)
    return linked.map((p) => ({
      ...p,
      via: "rules",
      why: `${p.why}, and the requirement reads like the clause`,
    }));
  const params = readParams(b.text);
  const scored = candidates(ctx, b.text, device, ctx.perDevice * 2)
    .map((h) => {
      const r = reqOf(ctx, h.id) as Requirement;
      const link = ctx.links.get(r.id);
      // a requirement whose own link holds belongs to another clause
      if (link && !(link.ref === ctx.meta.ref && link.clause === b.id) && linkHolds(ctx, r, link))
        return null;
      const score =
        h.score +
        ctx.rules.rationale_weight * rationaleMatch(r.rationale, ctx.meta) +
        paramAgreement(r.text, params);
      return { r, score };
    })
    .filter((x): x is { r: Requirement; score: number } => x !== null)
    .sort((x, y) => y.score - x.score);
  const [best, next] = scored;
  if (!best || best.score < ctx.rules.min_score) return [];
  if (next && best.score - next.score < ctx.rules.margin) {
    flags.push(
      `${device}: ${best.r.id} or ${next.r.id} may implement ${ctx.meta.ref} ${b.id}; the rules cannot tell them apart`,
    );
    return [];
  }
  return [
    {
      requirement: best.r.id,
      device,
      via: "rules",
      why: `retrieval, rationale and parameters agree (${best.score.toFixed(2)})`,
    },
  ];
}

const SYSTEM = `You map changes in a regulatory document to a medical-device manufacturer's requirements.
For each change you get the clause before and after, the devices in scope, and candidate requirements
per device with their recorded trace link (if any) and the author's free-text rationale.

Each requirement was written for one clause of one document. Several documents often impose the same
obligation, so several requirements can read the same; what tells them apart is the trace link, the
rationale (which names the authority, the subject, the year), and the deadline or recurrence.
- A requirement whose trace link points at this document's clause implements it, unless its text
  plainly states a different obligation (then the link is wrong).
- A requirement whose trace link points at another document's clause that states the same
  obligation belongs to that clause: do not pick it.
- Without a usable link, pick a requirement only when its rationale points at this document and
  nothing points elsewhere. If two or more candidates are equally plausible, pick none of them and
  list them as uncertain: an expert will decide.
Pick only from the candidates and quote the words (from the requirement, its rationale or its trace
link) that support the pick. Answer with one JSON object and nothing else.`;

type ModelOut = {
  picks?: { change?: string; device?: string; requirement?: string; quote?: string; why?: string }[];
  uncertain?: { change?: string; device?: string; requirements?: string[]; why?: string }[];
};

function modelPrompt(
  ctx: Context,
  items: { id: string; ch: Change; devices: string[]; cands: Map<string, string[]> }[],
) {
  const lines: string[] = [
    `Document: ${ctx.meta.ref} "${ctx.meta.title}" by the ${ctx.meta.authority}, version published ${ctx.meta.published}.`,
    "",
  ];
  for (const it of items) {
    lines.push(
      `## Change ${it.id} (${it.ch.kind})`,
      `Before (clause ${it.ch.before?.id}): ${it.ch.before?.text}`,
    );
    lines.push(`After: ${it.ch.after ? `(clause ${it.ch.after.id}) ${it.ch.after.text}` : "(removed)"}`);
    for (const d of it.devices) {
      const dev = ctx.graph.devices.find((x) => x.id === d) as Device;
      lines.push(`Candidates for device ${d} (${dev.name}, class ${dev.class}):`);
      for (const id of it.cands.get(d) ?? []) {
        const r = reqOf(ctx, id) as Requirement;
        const l = ctx.links.get(id);
        const lt = l ? ctx.clauseText(l.ref, l.clause) : null;
        lines.push(
          `- ${id}: ${r.text}`,
          `  rationale: ${r.rationale || "(empty)"}`,
          `  trace link: ${l ? `${l.ref} ${l.clause}${lt ? ` "${lt}"` : ""}` : "(none recorded)"}`,
        );
      }
    }
    lines.push("");
  }
  lines.push(
    'Answer: {"picks": [{"change": "c1", "device": "PMP", "requirement": "REQ-...", "quote": "exact words", "why": "one sentence"}],',
    '         "uncertain": [{"change": "c1", "device": "IMG", "requirements": ["REQ-...", "REQ-..."], "why": "one sentence"}]}',
    "One pick per requirement that implements the clause as it was before the change. Leave a device out if none does.",
  );
  return lines.join("\n");
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/["“”'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export async function assess(
  prev: ScrapedDoc,
  next: ScrapedDoc,
  method: Method,
  ctx: Context,
): Promise<Assessment> {
  const t0 = Date.now();
  const diff = diffVersions(prev, next, ctx.minSimilarity);
  const out: Assessment = {
    ref: next.ref,
    version: next.version,
    method,
    changes: [],
    relinks: [],
    rejected: [],
    cost_usd: 0,
    seconds: 0,
    model_calls: 0,
    errors: [],
  };
  const toRead: {
    id: string;
    ch: Change;
    devices: string[];
    cands: Map<string, string[]>;
    target: AssessedChange;
  }[] = [];
  diff.forEach((ch, i) => {
    const id = `c${i + 1}`;
    const verdict = ch.rule === "substantive" ? "substantive" : "editorial";
    const scopeBefore = inScope(ch.params.before, ctx.graph.devices);
    const scopeAfter = inScope(ch.params.after, ctx.graph.devices);
    const a: AssessedChange = {
      id,
      kind: ch.kind,
      before: ch.before,
      after: ch.after,
      verdict,
      rule: ch.rule,
      changed: ch.params.changed,
      scopeBefore,
      scopeAfter,
      affected: [],
      gaps: [],
      flags:
        ch.rule === "unclear"
          ? ["the text changed but every obligation parameter reads the same: treated as editorial"]
          : [],
    };
    out.changes.push(a);
    if (verdict !== "substantive") return;
    const devices = [...new Set([...scopeBefore, ...scopeAfter])];
    if (!ch.before) {
      for (const d of scopeAfter)
        a.gaps.push({ device: d, why: "new obligation: no requirement implements it yet" });
      return;
    }
    // A device that was out of the clause's scope can only have a requirement for it if someone
    // recorded one: for those, only a trace link counts.
    const newly = devices.filter((d) => !scopeBefore.includes(d));
    for (const d of newly) a.affected.push(...matchLinks(ctx, ch, d));
    if (method === "model" || method === "model-raw") {
      const cands = new Map<string, string[]>();
      for (const d of scopeBefore) {
        const linked = matchLinks(ctx, ch, d).map((p) => p.requirement);
        const hits = candidates(ctx, ch.before.text, d, ctx.perDevice).map((h) => h.id);
        cands.set(d, [...new Set([...linked, ...hits])]);
      }
      if (scopeBefore.length) toRead.push({ id, ch, devices: scopeBefore, cands, target: a });
      else finishScope(a);
      return;
    }
    for (const d of scopeBefore) {
      const picks =
        method === "links"
          ? matchLinks(ctx, ch, d)
          : method === "retrieval"
            ? matchRetrieval(ctx, ch, d)
            : matchRules(ctx, ch, d, a.flags);
      a.affected.push(...picks);
    }
    finishScope(a);
  });

  if (toRead.length && ctx.reader) {
    const reading = await ctx.reader.read(SYSTEM, modelPrompt(ctx, toRead));
    out.model_calls++;
    out.cost_usd += reading.cost_usd;
    if (reading.error) out.errors.push(reading.error);
    const parsed = lastJsonObject(reading.text) as ModelOut | null;
    if (!parsed?.picks) out.errors.push(`no picks in the model's answer: ${reading.text.slice(0, 200)}`);
    for (const p of parsed?.picks ?? []) {
      const it = toRead.find((x) => x.id === p.change);
      const reason = verifyPick(ctx, it, p);
      if (method === "model" && reason) {
        out.rejected.push({ change: String(p.change), pick: p, reason });
        continue;
      }
      if (!it) continue;
      it.target.affected.push({
        requirement: String(p.requirement),
        device: String(p.device),
        via: "model",
        quote: p.quote,
        why: p.why ?? "",
      });
      const req = reqOf(ctx, String(p.requirement));
      if (req && it.ch.before && paramAgreement(req.text, readParams(it.ch.before.text)) < 0)
        it.target.flags.push(
          `${req.id} already states a different deadline or recurrence than ${ctx.meta.ref} ${it.ch.before.id}: it was out of date before this version`,
        );
    }
    for (const u of parsed?.uncertain ?? []) {
      const it = toRead.find((x) => x.id === u.change);
      if (it)
        it.target.flags.push(
          `${u.device}: ${(u.requirements ?? []).join(" or ")} may implement ${ctx.meta.ref} ${it.ch.before?.id}; ${u.why ?? "the model could not tell"}`,
        );
    }
  } else if (toRead.length) out.errors.push("no reader configured for the model method");
  for (const it of toRead) finishScope(it.target);

  // trace links: move links to renumbered clauses, retire links to removed ones, add missing links
  const snapshot = new Map(ctx.links);
  for (const ch of out.changes) {
    if (ch.before && ch.after && ch.before.id !== ch.after.id)
      for (const [req, l] of snapshot)
        if (l.ref === next.ref && l.clause === ch.before.id)
          out.relinks.push({
            requirement: req,
            from: l,
            to: { ref: next.ref, clause: ch.after.id },
            why: `clause ${ch.before.id} is now ${ch.after.id}`,
          });
    if (ch.before && !ch.after)
      for (const [req, l] of snapshot)
        if (l.ref === next.ref && l.clause === ch.before.id)
          out.relinks.push({
            requirement: req,
            from: l,
            to: null,
            why: `clause ${ch.before.id} was removed`,
          });
    for (const p of ch.affected) {
      const l = snapshot.get(p.requirement);
      const target = ch.after ?? ch.before;
      if (
        target &&
        (ch.after || l) &&
        (!l || l.ref !== next.ref || l.clause !== (ch.before as { id: string }).id) &&
        p.via !== "link"
      )
        out.relinks.push({
          requirement: p.requirement,
          from: l ?? null,
          to: ch.after ? { ref: next.ref, clause: ch.after.id } : null,
          why: l
            ? `the recorded link points elsewhere; the requirement implements ${next.ref} ${ch.before?.id}`
            : `no link recorded; the requirement implements ${next.ref} ${ch.before?.id}`,
        });
    }
  }
  out.seconds = (Date.now() - t0) / 1000;
  return out;
}

/** After matching: devices newly in scope with nothing matched are gaps; devices that stayed in
 * scope with nothing matched are flagged (the company may never have implemented the clause). */
function finishScope(a: AssessedChange) {
  const matched = new Set(a.affected.map((p) => p.device));
  for (const d of a.scopeAfter)
    if (!a.scopeBefore.includes(d) && !matched.has(d))
      a.gaps.push({ device: d, why: "newly in scope and no requirement implements the clause" });
  for (const d of a.scopeBefore)
    if (!matched.has(d))
      a.flags.push(`${d}: no requirement found for ${a.before?.id}; check whether one exists`);
}

/** Why a model pick does not count, or null if it does. */
export function verifyPick(
  ctx: Context,
  it: { ch: Change; devices: string[]; cands: Map<string, string[]> } | undefined,
  p: { device?: string; requirement?: string; quote?: string },
): string | null {
  if (!it) return "refers to a change that was not asked about";
  if (!p.device || !it.devices.includes(p.device))
    return `device ${p.device} is not in scope for this change`;
  if (!p.requirement || !(it.cands.get(p.device) ?? []).includes(p.requirement))
    return `${p.requirement} was not a candidate for ${p.device}`;
  const r = reqOf(ctx, p.requirement) as Requirement;
  // the model may repeat the label a line was shown with ("trace link: ...", "rationale: ...")
  const quote = norm(p.quote ?? "").replace(/^(trace link|rationale)\s*:\s*/, "");
  if (quote.length < 8) return "no quote";
  // evidence the model was shown for this candidate: its text, its rationale, its trace link
  const l = ctx.links.get(r.id);
  const lt = l ? ctx.clauseText(l.ref, l.clause) : null;
  const shown = [r.text, r.rationale, l ? `${l.ref} ${l.clause} ${lt ?? ""}` : ""].map(norm);
  if (!shown.some((e) => e.includes(quote)))
    return "the quote is not in the requirement, its rationale or its trace link";
  if (l && !(l.ref === ctx.meta.ref && l.clause === it.ch.before?.id) && linkHolds(ctx, r, l))
    return `${r.id} is linked to ${l.ref} ${l.clause}, which states this obligation too`;
  // a requirement that states another deadline than the clause is either someone else's or out of
  // date; only a trace link to this very clause says which
  const linkedHere = l?.ref === ctx.meta.ref && l.clause === it.ch.before?.id;
  if (it.ch.before && !linkedHere && paramAgreement(r.text, readParams(it.ch.before.text)) < 0)
    return "the requirement's deadline or recurrence disagrees with the clause";
  return null;
}
