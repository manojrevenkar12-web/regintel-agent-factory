import { useResource } from "../../shared/api";
import { useSession } from "../../shared/session";
import { EmptyState, Load } from "../../shared/ui/states";
import { type Day, type Mark, SeasonStrip } from "./SeasonStrip";

type Overview = {
  setup: string;
  sources: {
    source: string;
    authority: string;
    last: { day: number; status: string; listed: number } | null;
    deployment: { version: number; day: number; by: string } | null;
    open: { id: string; status: string; day: number } | null;
    documents: number;
    days: Day[];
  }[];
  incidents: { status: string; n: number; cost: number }[];
};

const SEASON_DAYS = 120;

const who = (by: string) =>
  by.startsWith("agent:") ? "the agent" : by === "person" ? "a person" : "the initial release";

export function SourcesScreen() {
  const { setup } = useSession();
  const ov = useResource<Overview>(`/api/overview?setup=${encodeURIComponent(setup)}`);
  const inc = useResource<Mark[]>(`/api/incidents?setup=${encodeURIComponent(setup)}`);
  return (
    <section aria-labelledby="sources-title">
      <h1 id="sources-title" className="font-text text-display">
        Five regulator sites, one season
      </h1>
      <p className="mt-2 max-w-prose text-lead text-muted">
        Each strip is a site's season, one cell a day. Red cells are days production data for that site was
        frozen because a crawl failed its contract. A mark above a cell is an incident.
      </p>
      <Load
        r={ov}
        what="the sites"
        rows={5}
        isEmpty={(d) => d.sources.every((s) => !s.days.length)}
        empty={
          <EmptyState title="No season has run for this setup yet.">
            Run <code className="font-code">rif season --setup {setup}</code> and reload.
          </EmptyState>
        }
      >
        {(d) => (
          <>
            <ol className="mt-8 flex list-none flex-col gap-8 p-0">
              {d.sources.map((s) => (
                <li
                  key={s.source}
                  className="grid gap-3 border-t border-line pt-4 lg:grid-cols-[theme(width.rail)_1fr]"
                >
                  <div>
                    <h2 className="text-lead font-bold">{s.authority}</h2>
                    <p className="text-small text-muted">
                      {s.documents} documents in production
                      {s.deployment
                        ? `, scraper v${s.deployment.version} from day ${s.deployment.day} by ${who(s.deployment.by)}`
                        : ", the committed scraper"}
                    </p>
                    {s.open && (
                      <p className="mt-1 inline-block rounded-soft bg-attentionWash px-2 text-small font-bold text-attention">
                        Waiting on a person since day {s.open.day}
                      </p>
                    )}
                  </div>
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard */}
                  <section className="overflow-x-auto pb-2" aria-label={`${s.authority} season`} tabIndex={0}>
                    <SeasonStrip
                      label={s.authority}
                      days={s.days}
                      length={SEASON_DAYS}
                      marks={(inc.data ?? []).filter((x) => x.id.split(":")[1] === s.source)}
                    />
                  </section>
                </li>
              ))}
            </ol>
            <Totals rows={d.incidents} />
          </>
        )}
      </Load>
    </section>
  );
}

function Totals({ rows }: { rows: Overview["incidents"] }) {
  const n = (st: string) => rows.find((r) => r.status === st)?.n ?? 0;
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  return (
    <dl className="mt-12 grid max-w-panel grid-cols-2 gap-4 border-t-rule border-ink pt-4 sm:grid-cols-4">
      {[
        ["Incidents", String(rows.reduce((s, r) => s + r.n, 0))],
        ["Fixed by the agent", String(n("deployed"))],
        ["Sent to a person", String(n("fixed_by_person") + n("escalated"))],
        ["Agent spend", `$${cost.toFixed(2)}`],
      ].map(([k, v]) => (
        <div key={k}>
          <dt className="text-small text-muted">{k}</dt>
          <dd className="m-0 font-text text-title">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
