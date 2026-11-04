/** A season: the platform crawls every regulator every day for 120 days while the sites drift, and
 * the agent factory repairs what breaks. Each day is a DBOS durable workflow and each repair a child
 * workflow, so a crashed run resumes where it stopped and a finished day is never redone.
 *
 * This file is the harness: it moves the world's clock and plays the person an escalated incident
 * goes to. The platform parts it drives (ingest, factory, store) never see the world's truth.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { type Setup, evidenceCrawl, factoryCfg, repair } from "@rif/factory";
import { ROOT, SOURCES, crawl, httpFetch, loadScraper, materialize, scraperPath } from "@rif/ingest";
import { type World, type WorldServer, layoutOf, referenceScraper } from "@rif/world";
import type { Store } from "./store.js";

export type SeasonCtx = {
  store: Store;
  world: World;
  server: WorldServer;
  setup: Setup;
  runDir: string;
  humanDelayDays: number;
  log: (s: string) => void;
};

let ctx: SeasonCtx | null = null;
export const setSeasonContext = (c: SeasonCtx) => {
  ctx = c;
};
const C = () => {
  if (!ctx) throw new Error("season context not set");
  return ctx;
};

async function scraperFor(source: string) {
  const c = C();
  const dep = await c.store.deployment(c.setup.name, source);
  const code = dep?.code ?? readFileSync(scraperPath(source), "utf8");
  return {
    version: dep?.version ?? 0,
    code,
    scraper: await loadScraper(
      materialize(code, join(c.runDir, "deployed", source, `v${dep?.version ?? 0}.ts`)),
    ),
  };
}

type CrawlSummary = {
  status: string;
  listed: number;
  fresh: number;
  findings: { check: string; detail: string }[];
};

async function crawlStep(source: string, day: number): Promise<CrawlSummary> {
  const c = C();
  c.server.setDay(day);
  const { version, scraper } = await scraperFor(source);
  const prev = await c.store.lastGood(c.setup.name, source);
  const rec = new Map();
  const o = await crawl(
    source,
    scraper,
    httpFetch(c.server.url, source, rec),
    rec,
    c.world.date(day),
    prev?.data ?? null,
  );
  await c.store.recordCrawl(c.setup.name, day, version, o);
  let fresh = 0;
  if (o.status === "ok") fresh = (await c.store.accept(c.setup.name, source, day, o.data)).length;
  return {
    status: o.status,
    listed: o.data.items.length,
    fresh,
    findings: o.findings
      .filter((f) => f.level === "error")
      .map((f) => ({ check: f.check, detail: f.detail })),
  };
}

/** The person an escalated incident goes to: after a delay, they deploy a correct scraper. */
async function personStep(source: string, day: number, incident: string): Promise<void> {
  const c = C();
  const src = c.world.sources.find((s) => s.id === source);
  if (!src) return;
  const code = referenceScraper(source, src.ref_prefix, layoutOf(src, day));
  await c.store.deploy(c.setup.name, source, day, "person", code, incident);
  await c.store.closeIncident(incident, { status: "fixed_by_person", resolved_day: day });
}

const repairWorkflow = DBOS.registerWorkflow(
  async (source: string, day: number, incident: string) => {
    const c = C();
    const pages = await DBOS.runStep(() => (c.server.setDay(day), evidenceCrawl(c.server.url, source)), {
      name: "evidence",
    });
    const findings = await DBOS.runStep(
      async () => {
        const r = await c.store.pool.query("select findings from incidents where id = $1", [incident]);
        return r.rows[0]?.findings ?? [];
      },
      { name: "findings" },
    );
    const record = await DBOS.runStep(
      async () => {
        const { code } = await scraperFor(source);
        const prev = await c.store.lastGood(c.setup.name, source);
        if (!c.setup.model || c.setup.model === "none")
          return {
            decision: "escalated",
            reason: "no agent in this setup",
            code: null,
            cost_usd: 0,
            seconds: 0,
            attempts: [],
          } as unknown as Awaited<ReturnType<typeof repair>>;
        return repair(
          {
            id: incident.replaceAll(":", "-"),
            source,
            day,
            today: c.world.date(day),
            findings,
            lastGood: prev?.data ?? null,
            pages,
          },
          code,
          c.setup,
          c.runDir,
        );
      },
      { name: "repair" },
    );
    // keep the record readable: findings and gate results, not the full extraction of every page
    for (const a of record.attempts ?? []) {
      if (a.gates?.check) a.gates.check.data = { items: [], docs: [] };
      if (a.gates?.hidden) a.gates.hidden.data = { items: [], docs: [] };
    }
    return DBOS.runStep(
      async () => {
        if (record.decision === "deployed" && record.code) {
          await c.store.deploy(c.setup.name, source, day, `agent:${c.setup.name}`, record.code, incident);
          await c.store.closeIncident(incident, {
            status: "deployed",
            decision: "deployed",
            reason: record.reason,
            cost_usd: record.cost_usd,
            seconds: record.seconds,
            record,
            resolved_day: day,
          });
        } else {
          await c.store.closeIncident(incident, {
            status: "escalated",
            decision: "escalated",
            reason: record.reason,
            cost_usd: record.cost_usd,
            seconds: record.seconds,
            record,
          });
          await c.store.audit("system", "incident.escalated", incident, { reason: record.reason });
        }
        return { decision: record.decision, cost: record.cost_usd };
      },
      { name: "decide" },
    );
  },
  { name: "repair" },
);

export const dayWorkflow = DBOS.registerWorkflow(
  async (day: number) => {
    const c = C();
    const out: Record<string, CrawlSummary & { incident?: string; decision?: string }> = {};
    for (const source of SOURCES) {
      const open = await DBOS.runStep(() => c.store.openIncidentFor(c.setup.name, source), {
        name: `open-${source}`,
      });
      if (open?.status === "escalated" && day >= open.day + c.humanDelayDays)
        await DBOS.runStep(() => personStep(source, day, open.id), { name: `person-${source}` });
      let s = await DBOS.runStep(() => crawlStep(source, day), { name: `crawl-${source}` });
      if (s.status === "failed") {
        const still = await DBOS.runStep(() => c.store.openIncidentFor(c.setup.name, source), {
          name: `still-${source}`,
        });
        if (!still) {
          const id = `${c.setup.name}:${source}:${day}`;
          await DBOS.runStep(() => c.store.openIncident(id, c.setup.name, source, day, s.findings), {
            name: `incident-${source}`,
          });
          const h = await DBOS.startWorkflow(repairWorkflow, {
            workflowID: `${process.env.RIF_RUN ?? "r1"}:${c.setup.name}:repair:${source}:${day}`,
          })(source, day, id);
          const r = await h.getResult();
          if (r.decision === "deployed")
            s = await DBOS.runStep(() => crawlStep(source, day), { name: `recrawl-${source}` });
          out[source] = { ...s, incident: id, decision: r.decision };
          continue;
        }
      }
      out[source] = s;
    }
    return out;
  },
  { name: "day" },
);

export async function runSeason(c: SeasonCtx, days: number, afterDay?: (day: number) => Promise<void>) {
  setSeasonContext(c);
  const run = process.env.RIF_RUN ?? "r1";
  for (let day = 0; day < days; day++) {
    const h = await DBOS.startWorkflow(dayWorkflow, { workflowID: `${run}:${c.setup.name}:day:${day}` })(day);
    const r = await h.getResult();
    const notes = Object.entries(r)
      .filter(([, v]) => v.status !== "ok" || v.incident || v.fresh)
      .map(
        ([k, v]) =>
          `${k} ${v.status}${v.fresh ? ` +${v.fresh}` : ""}${v.incident ? ` incident ${v.decision}` : ""}`,
      );
    if (notes.length) c.log(`day ${day}: ${notes.join(", ")}`);
    if (afterDay) await afterDay(day);
  }
}

export const humanDelay = () => factoryCfg().escalation.human_delay_days;
export { ROOT };
