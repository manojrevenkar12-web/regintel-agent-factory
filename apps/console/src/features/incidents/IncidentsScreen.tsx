import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useResource } from "../../shared/api";
import { href } from "../../shared/route";
import { useSession } from "../../shared/session";
import { EmptyState, Load } from "../../shared/ui/states";
import { count } from "../../shared/words";
import { motion as m } from "../../theme/tokens";

type Row = {
  id: string;
  source: string;
  day: number;
  status: string;
  decision: string | null;
  reason: string | null;
  cost_usd: number;
  seconds: number;
  attempts: number;
};
type Gate = { name: string; ok: boolean; detail: string };
type Attempt = {
  claim: string;
  diff: string;
  gates: { ok: boolean; gates: Gate[]; staticFlags: string[] };
  review: { verdict: string; issues: string[] } | null;
  session: {
    cost_usd: number;
    seconds: number;
    turns: number;
    checks_run: number;
    denials: number;
    model: string;
  };
};
type Detail = Row & {
  findings: { check: string; detail: string }[];
  record: { attempts?: Attempt[]; firstAttemptSelfCheck?: boolean } | null;
  resolved_day: number | null;
  deployment: { version: number; day: number; by: string; code_hash: string } | null;
};

export const OUTCOME: Record<string, { text: string; tone: string }> = {
  deployed: { text: "Fixed by the agent", tone: "bg-verifiedWash text-verified" },
  fixed_by_person: { text: "Fixed by a person", tone: "bg-attentionWash text-attention" },
  escalated: { text: "Waiting on a person", tone: "bg-attentionWash text-attention" },
  open: { text: "Open", tone: "bg-faultWash text-fault" },
  repairing: { text: "Agent working", tone: "bg-idle text-ink" },
};

export function Outcome({ status }: { status: string }) {
  const o = OUTCOME[status] ?? { text: status, tone: "bg-idle text-ink" };
  return <span className={`inline-block rounded-soft px-2 text-small font-bold ${o.tone}`}>{o.text}</span>;
}

export function IncidentsScreen({ id }: { id: string | null }) {
  const { setup } = useSession();
  const list = useResource<Row[]>(`/api/incidents?setup=${encodeURIComponent(setup)}`);
  return (
    <section
      aria-labelledby="incidents-title"
      className="grid gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <div>
        <h1 id="incidents-title" className="font-text text-display">
          Incidents
        </h1>
        <p className="mt-2 max-w-prose text-muted">
          A crawl that fails its contract freezes that site's data and opens an incident. The agent gets a
          sandbox with the failing pages; the gates and a reviewer decide whether its fix ships.
        </p>
        <Load
          r={list}
          what="incidents"
          isEmpty={(d) => !d.length}
          empty={
            <EmptyState title="No incidents in this season.">Every crawl passed its contract.</EmptyState>
          }
        >
          {(rows) => (
            <table className="mt-6 w-full border-collapse text-left">
              <thead className="text-small text-muted">
                <tr>
                  <th className="py-2 font-normal">Site and day</th>
                  <th className="py-2 font-normal">Outcome</th>
                  <th className="py-2 text-right font-normal">Attempts</th>
                  <th className="py-2 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t border-line ${r.id === id ? "bg-sheet" : ""}`}>
                    <td className="py-2">
                      <a
                        className="text-link hover:underline"
                        href={href("incidents", r.id)}
                        aria-current={r.id === id ? "page" : undefined}
                      >
                        {r.source.toUpperCase()}, day {r.day}
                      </a>
                    </td>
                    <td className="py-2">
                      <Outcome status={r.status} />
                    </td>
                    <td className="py-2 text-right">{r.attempts}</td>
                    <td className="py-2 text-right">${r.cost_usd.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Load>
      </div>
      <div>
        {id ? (
          <IncidentDetail id={id} />
        ) : (
          <EmptyState title="Pick an incident">
            Its findings, every attempt the agent made, each gate and the reviewer's verdict appear here.
          </EmptyState>
        )}
      </div>
    </section>
  );
}

function IncidentDetail({ id }: { id: string }) {
  const r = useResource<Detail>(`/api/incidents/${encodeURIComponent(id)}`);
  return (
    <Load r={r} what="the incident" rows={8}>
      {(d) => (
        <article aria-labelledby="incident-title" className="border border-line bg-sheet p-6">
          <h2 id="incident-title" className="text-title font-bold">
            {d.source.toUpperCase()}, day {d.day}
          </h2>
          <p className="mt-1">
            <Outcome status={d.status} /> <span className="text-muted">{d.reason}</span>
          </p>
          {d.deployment && (
            <p className="mt-2 text-small text-muted">
              Scraper v{d.deployment.version} went to production on day {d.deployment.day} (code hash{" "}
              {d.deployment.code_hash.slice(0, 12)}).
            </p>
          )}
          <h3 className="mt-6 font-bold">What the contract found</h3>
          <ul className="mt-2 list-disc pl-6">
            {d.findings.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: findings repeat
              <li key={i}>
                <span className="font-code text-small">{f.check}</span> {f.detail}
              </li>
            ))}
          </ul>
          {(d.record?.attempts ?? []).length === 0 && (
            <p className="mt-6 text-muted">No agent worked on this incident; it went straight to a person.</p>
          )}
          <ol className="mt-6 flex list-none flex-col gap-6 p-0">
            {(d.record?.attempts ?? []).map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: attempts are ordered
              <AttemptView key={i} a={a} n={i + 1} />
            ))}
          </ol>
        </article>
      )}
    </Load>
  );
}

function AttemptView({ a, n }: { a: Attempt; n: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-line pt-4">
      <h3 className="font-bold">
        Attempt {n}: {a.gates.ok ? "every gate passed" : "rejected by the gates"}
      </h3>
      <p className="mt-1 text-small text-muted">
        {a.session.model}, {count(a.session.turns, "turn")}, ran its own check{" "}
        {count(a.session.checks_run, "time")}, {count(a.session.denials, "command")} refused, $
        {a.session.cost_usd.toFixed(2)}
      </p>
      {a.claim && (
        <blockquote className="mt-2 border-l-rule border-line pl-3 font-text">{a.claim}</blockquote>
      )}
      <ul className="mt-3 flex list-none flex-col gap-1 p-0">
        {a.gates.gates.map((g) => (
          <li key={g.name} className="flex gap-2">
            <span aria-hidden="true" className={g.ok ? "text-verified" : "text-fault"}>
              {g.ok ? "✓" : "✗"}
            </span>
            <span>
              <span className="font-bold">{g.name}</span>{" "}
              <span className="sr-only">{g.ok ? "passed" : "failed"}</span>
              <span className="text-muted">{g.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {a.review && (
        <div className="mt-3">
          <p>
            Reviewer: <span className="font-bold">{a.review.verdict.replace(/_/g, " ")}</span>
          </p>
          {a.review.issues.length > 0 && (
            <ul className="list-disc pl-6 text-muted">
              {a.review.issues.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
        className="mt-3 text-link hover:underline"
      >
        {open ? "Hide the change" : "Show the change"}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.pre
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: m.settle, ease: m.ease }}
            className="mt-2 overflow-auto bg-paper p-3 font-code text-small"
          >
            {a.diff
              .split("\n")
              .map((text, n) => ({ n, text }))
              .map((l) => (
                <span
                  key={l.n}
                  className={`block ${l.text.startsWith("+") ? "text-verified" : l.text.startsWith("-") ? "text-fault" : ""}`}
                >
                  {l.text || " "}
                </span>
              ))}
          </motion.pre>
        )}
      </AnimatePresence>
    </li>
  );
}
