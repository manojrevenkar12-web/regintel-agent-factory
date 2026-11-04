/** The measured results, from reports/results.json (written by `rif report`). */
import { useResource } from "../../shared/api";
import { EmptyState, Load } from "../../shared/ui/states";

type Score = {
  precision: number;
  recall: number;
  gaps: { tp: number; fn: number };
  relinks: { right: number; proposed: number };
  flags: number;
  rejected: number;
  cost_usd: number;
  changes: { classified_right: number; truth: number };
};
type Results = {
  generated_at: string;
  season: {
    setup: string;
    incidents: number;
    deployed_by_agent: number;
    fixed_by_person: number;
    days_to_restore_mean: number;
    person_hours: number;
    agent_cost_usd: number;
    doc_days: { wrong: number; stale: number };
  }[];
  heldout_incidents: {
    setup: string;
    right: number;
    total: number;
    wrongly_deployed: number;
    cost_usd: number;
    by_kind: Record<string, { right: number; total: number }>;
  }[];
  impact: { season_world: Record<string, Score>; heldout_world_first_run: Record<string, Score> };
};

const usd = (x: number) => `$${x.toFixed(2)}`;

function Table({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="pb-2 text-left font-bold">{caption}</caption>
        <thead className="text-small text-muted">
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`border-b border-line py-2 pr-4 font-normal ${i ? "text-right" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])} className="border-b border-line">
              {r.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                <td key={i} className={`py-2 pr-4 ${i ? "text-right tabular-nums" : "font-bold"}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const impactRows = (m: Record<string, Score>) =>
  Object.entries(m).map(([k, s]) => [
    k,
    s.precision.toFixed(2),
    s.recall.toFixed(2),
    `${s.gaps.tp} / ${s.gaps.tp + s.gaps.fn}`,
    `${s.relinks.right} / ${s.relinks.proposed}`,
    s.flags,
    s.rejected,
    usd(s.cost_usd),
  ]);
const impactHead = [
  "Matcher",
  "Precision",
  "Recall",
  "Gaps found",
  "Link fixes right",
  "Left for the expert",
  "Dropped by the verifier",
  "Cost",
];

export function ResultsScreen() {
  const r = useResource<Results>("/api/results");
  return (
    <section aria-labelledby="results-title">
      <h1 id="results-title" className="font-text text-display">
        What was measured
      </h1>
      <Load
        r={r}
        what="the results"
        rows={6}
        empty={
          <EmptyState title="No results yet.">
            Run the season, the held-out incidents and the impact runs, then rif report.
          </EmptyState>
        }
        isEmpty={(d) => !d.season.length}
      >
        {(d) => (
          <div className="max-w-page">
            <p className="mt-2 text-small text-muted">
              Generated {new Date(d.generated_at).toLocaleString()} from the run files; every number is scored
              against the simulator's truth, which the platform never reads.
            </p>
            <Table
              caption="Season: 120 days, five sites, the same drifts for every setup"
              head={[
                "Setup",
                "Incidents",
                "Fixed by the agent",
                "Fixed by a person",
                "Days to restore",
                "Person-hours",
                "Agent cost",
                "Wrong doc-days",
                "Stale doc-days",
              ]}
              rows={d.season.map((s) => [
                s.setup,
                s.incidents,
                s.deployed_by_agent,
                s.fixed_by_person,
                s.days_to_restore_mean.toFixed(1),
                s.person_hours,
                usd(s.agent_cost_usd),
                s.doc_days.wrong,
                s.doc_days.stale,
              ])}
            />
            <Table
              caption="Held-out incidents, first run: layout splits to fix, real content changes to hand back"
              head={[
                "Setup",
                "Right",
                "Layout split",
                "Withdrawn documents",
                "Clause corrected in place",
                "Wrongly deployed",
                "Cost",
              ]}
              rows={d.heldout_incidents.map((h) => {
                const k = (x: string) => `${h.by_kind[x]?.right ?? 0} / ${h.by_kind[x]?.total ?? 0}`;
                return [
                  h.setup,
                  `${h.right} / ${h.total}`,
                  k("template_split"),
                  k("withdraw"),
                  k("silent_edit"),
                  h.wrongly_deployed,
                  usd(h.cost_usd),
                ];
              })}
            />
            <Table
              caption="Change impact on the season world (where the rules were tuned)"
              head={impactHead}
              rows={impactRows(d.impact.season_world)}
            />
            <Table
              caption="Change impact on the held-out world (first run)"
              head={impactHead}
              rows={impactRows(d.impact.heldout_world_first_run)}
            />
          </div>
        )}
      </Load>
    </section>
  );
}
