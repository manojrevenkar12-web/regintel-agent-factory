import { readFileSync } from "node:fs";
import { evidenceCrawl, repair } from "@rif/factory";
import { crawl, httpFetch, loadScraper, materialize, scraperPath } from "@rif/ingest";
import { buildWorld, serveWorld, shownAt } from "@rif/world";

const [source = "smc", dayArg = "30", model = "sonnet"] = process.argv.slice(2);
const day = Number(dayArg);
const w = buildWorld();
const srv = await serveWorld(w);
srv.setDay(day - 5 > 0 ? day - 5 : 0);
let rec = new Map();
const sc = await loadScraper(scraperPath(source));
const good = await crawl(source, sc, httpFetch(srv.url, source, rec), rec, w.date(day - 5), null);
console.log("last good", good.status, good.data.items.length);
srv.setDay(day);
rec = new Map();
const bad = await crawl(source, sc, httpFetch(srv.url, source, rec), rec, w.date(day), good.data);
console.log("today", bad.status, bad.findings.slice(0, 2));
const pages = await evidenceCrawl(srv.url, source);
console.log("evidence pages", Object.keys(pages).length);
const inc = {
  id: `${source}-d${day}`,
  source,
  day,
  today: w.date(day),
  findings: bad.findings,
  lastGood: good.data,
  pages,
};
const r = await repair(
  inc,
  readFileSync(scraperPath(source), "utf8"),
  { name: "pilot", model, gates: true, review: true },
  "work/pilot",
);
for (const a of r.attempts)
  console.log({
    cost: a.session.cost_usd,
    s: a.session.seconds,
    checks: a.session.checks_run,
    err: a.session.error,
    gates: a.gates.gates.map((g) => `${g.name}:${g.ok ? "ok" : "FAIL " + g.detail.slice(0, 120)}`),
    flags: a.gates.staticFlags,
    review: a.review && { v: a.review.verdict, i: a.review.issues },
    claim: a.claim,
  });
console.log(r.decision, r.reason, "$" + r.cost_usd.toFixed(2), r.seconds + "s");
if (r.code) {
  const fixed = await loadScraper(materialize(r.code, `${process.cwd()}/work/pilot/deployed/${source}.ts`));
  for (const d of [day, day + 10]) {
    srv.setDay(d);
    rec = new Map();
    const o = await crawl(source, fixed, httpFetch(srv.url, source, rec), rec, w.date(d), null);
    const truth = shownAt(w, source, d);
    const exact = o.data.docs.filter((x) => {
      const t = truth.find((y) => y.ref === x.ref);
      return (
        t &&
        JSON.stringify(t.clauses) === JSON.stringify(x.clauses) &&
        t.version === x.version &&
        t.published === x.published &&
        t.effective === x.effective
      );
    }).length;
    console.log("truth check day", d, o.status, `${exact}/${truth.length} exact`);
  }
}
await srv.close();
