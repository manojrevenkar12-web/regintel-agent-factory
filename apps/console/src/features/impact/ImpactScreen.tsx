import { useState } from "react";
import { useResource } from "../../shared/api";
import { href } from "../../shared/route";
import { useSession } from "../../shared/session";
import { EmptyState, Load } from "../../shared/ui/states";
import { count } from "../../shared/words";
import { AssessmentDetail } from "./AssessmentDetail";

type Row = {
  id: string;
  method: string;
  ref: string;
  version: number;
  day: number;
  changes: number;
  substantive: number;
  affected: number;
  gaps: number;
  flags: number;
  signed: boolean;
};

const METHODS = [
  { id: "model-sonnet", label: "Model, verified" },
  { id: "rules", label: "Rules" },
  { id: "links", label: "Trace links only" },
] as const;

export function ImpactScreen({ id }: { id: string | null }) {
  const { setup } = useSession();
  const [method, setMethod] = useState<string>(id?.split(":")[1] ?? METHODS[0].id);
  const [all, setAll] = useState(false);
  const list = useResource<Row[]>(
    `/api/assessments?setup=${encodeURIComponent(setup)}&method=${encodeURIComponent(method)}`,
  );
  return (
    <section aria-labelledby="impact-title" className="grid gap-8 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div>
        <h1 id="impact-title" className="font-text text-display">
          Change impact
        </h1>
        <p className="mt-2 max-w-prose text-muted">
          Every new version of a watched document, compared clause by clause. Substantive changes are traced
          to the requirements that implement the clause; nothing counts until an expert signs.
        </p>
        <fieldset className="mt-4 flex flex-wrap gap-4">
          <legend className="sr-only">Matcher</legend>
          {METHODS.map((m) => (
            <label key={m.id} className="flex items-center gap-2">
              <input
                type="radio"
                name="method"
                value={m.id}
                checked={method === m.id}
                onChange={() => setMethod(m.id)}
              />
              {m.label}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Include editorial-only versions
          </label>
        </fieldset>
        <Load
          r={list}
          what="assessments"
          isEmpty={(d) => !d.length}
          empty={
            <EmptyState title="No assessments for this matcher yet.">
              Run <code className="font-code">rif impact --setup {setup}</code> to assess the versions this
              season saw.
            </EmptyState>
          }
        >
          {(rows) => {
            const shown = rows.filter((r) => all || r.substantive > 0);
            return shown.length ? (
              <ul className="mt-6 flex list-none flex-col p-0">
                {shown.map((r) => (
                  <li key={r.id} className="border-t border-line py-2">
                    <a
                      href={href("impact", r.id)}
                      aria-current={r.id === id ? "page" : undefined}
                      className="text-link hover:underline"
                    >
                      {r.ref} version {r.version}
                    </a>
                    <span className="block text-small text-muted">
                      Day {r.day}. {r.substantive} of {count(r.changes, "change")} substantive,{" "}
                      {count(r.affected, "requirement")} affected, {count(r.gaps, "gap")}
                      {r.flags ? `, ${count(r.flags, "question")} for the expert` : ""}.{" "}
                      {r.signed ? "Signed." : "Not signed yet."}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Only editorial changes this season.">
                Tick the box above to see them.
              </EmptyState>
            );
          }}
        </Load>
      </div>
      <div>
        {id ? (
          <AssessmentDetail id={id} />
        ) : (
          <EmptyState title="Pick a document version">
            Its clause changes, the requirements they reach, the evidence for each and the sign-off appear
            here.
          </EmptyState>
        )}
      </div>
    </section>
  );
}
