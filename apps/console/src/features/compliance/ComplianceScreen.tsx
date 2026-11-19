import { useEffect, useState } from "react";
import { useResource } from "../../shared/api";
import { href } from "../../shared/route";
import { EmptyState, Load } from "../../shared/ui/states";
import { count } from "../../shared/words";
import { ProcedureDetail } from "./ProcedureDetail";
import { VerdictBar } from "./VerdictBar";
import type { ProcedureRow, Run } from "./types";

/** Route ids are "<run>~<procedure>". */
const split = (id: string | null) => {
  const [run, proc] = (id ?? "").split("~");
  return { run: run || null, proc: proc || null };
};

export function ComplianceScreen({ id }: { id: string | null }) {
  const runs = useResource<Run[]>("/api/compliance/runs");
  const picked = split(id);
  const [run, setRun] = useState<string | null>(picked.run);
  useEffect(() => {
    if (!run && runs.data?.length) setRun((runs.data[0] as Run).id);
  }, [run, runs.data]);
  const procs = useResource<ProcedureRow[]>(
    run ? `/api/compliance/runs/${encodeURIComponent(run)}/procedures` : null,
  );
  const [onlyOpen, setOnlyOpen] = useState(false);
  return (
    <section
      aria-labelledby="compliance-title"
      className="grid gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div>
        <h1 id="compliance-title" className="font-text text-display">
          SOP compliance
        </h1>
        <p className="mt-2 max-w-prose text-muted">
          Every customer procedure checked against the requirements formulated from the clauses in force. A
          finding is accepted unreviewed only when the evidence is strong and explicit; the rest waits for an
          expert, whose decision is reused next time on the very same words.
        </p>
        <Load
          r={runs}
          what="compliance runs"
          isEmpty={(d) => !d.length}
          empty={
            <EmptyState title="No compliance run recorded yet.">
              Run <code className="font-code">rif compliance --load</code> to check the customers' procedures.
            </EmptyState>
          }
          rows={2}
        >
          {(rs) => (
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2">
                Run
                <select
                  value={run ?? ""}
                  onChange={(e) => {
                    setRun(e.target.value);
                    window.location.hash = href("compliance", e.target.value);
                  }}
                  className="rounded-soft border border-line bg-sheet px-2 py-1"
                >
                  {rs.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id}: {count(r.summary.findings, "finding")}, {r.summary.routes.review ?? 0} for
                      review
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
                Only procedures with open reviews
              </label>
            </div>
          )}
        </Load>
        {run && (
          <Load
            r={procs}
            what="procedures"
            rows={8}
            isEmpty={(d) => !d.length}
            empty={
              <EmptyState title="This run checked no procedures.">Check that the run finished.</EmptyState>
            }
          >
            {(rows) => {
              const shown = rows.filter((r) => !onlyOpen || r.open > 0);
              const customers = [...new Set(shown.map((r) => r.customer))];
              return shown.length ? (
                <div className="mt-6">
                  {customers.map((c) => (
                    <section key={c} aria-label={`Customer ${c}`} className="mb-6">
                      <h2 className="text-small font-bold text-muted">Customer {c}</h2>
                      <ul className="m-0 flex list-none flex-col p-0">
                        {shown
                          .filter((r) => r.customer === c)
                          .map((r) => (
                            <li key={r.id} className="border-t border-line py-2">
                              <a
                                href={href("compliance", `${run}~${r.id}`)}
                                aria-current={r.id === picked.proc ? "page" : undefined}
                                className="text-link underline decoration-1 underline-offset-2"
                              >
                                {r.title}
                              </a>
                              <span className="block text-small text-muted">
                                {r.id}.{" "}
                                {r.open
                                  ? `${count(r.open, "finding")} waiting for an expert.`
                                  : "Nothing waiting."}
                              </span>
                              <VerdictBar counts={r.verdicts ?? {}} />
                            </li>
                          ))}
                      </ul>
                    </section>
                  ))}
                </div>
              ) : (
                <EmptyState title="No open reviews in this run.">
                  Untick the box to see every procedure.
                </EmptyState>
              );
            }}
          </Load>
        )}
      </div>
      <div>
        {run && picked.proc ? (
          <ProcedureDetail run={run} id={picked.proc} />
        ) : (
          <EmptyState title="Pick a procedure">
            Its steps, each requirement with the clauses behind it, the step that carries it and the expert's
            review appear here.
          </EmptyState>
        )}
      </div>
    </section>
  );
}
