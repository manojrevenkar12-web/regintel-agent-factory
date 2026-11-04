import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { ApiError, api, useResource } from "../../shared/api";
import { roleName, useSession } from "../../shared/session";
import { Load } from "../../shared/ui/states";
import { motion as m } from "../../theme/tokens";

type Pick = { requirement: string; device: string; via: string; quote?: string; why: string };
type Change = {
  id: string;
  kind: string;
  verdict: string;
  rule: string;
  changed: string[];
  before: { id: string; text: string } | null;
  after: { id: string; text: string } | null;
  affected: Pick[];
  gaps: { device: string; why: string }[];
  flags: string[];
};
type Signoff = { seq: number; signer: string; name: string; role: string; meaning: string; at: string };
type Assessment = {
  id: string;
  method: string;
  ref: string;
  version: number;
  body_hash: string;
  body: {
    changes: Change[];
    relinks: { requirement: string; to: { clause: string } | null; why: string }[];
    rejected: { reason: string }[];
  };
  signoffs: Signoff[];
  requirements: Record<string, { id: string; device: string; text: string }>;
};

const PARAM: Record<string, string> = {
  modal: "strength",
  days: "deadline",
  frequency: "recurrence",
  classes: "device classes",
  actor: "who must act",
};

export function AssessmentDetail({ id }: { id: string }) {
  const r = useResource<Assessment>(`/api/assessments/${encodeURIComponent(id)}`);
  return (
    <Load r={r} what="the assessment" rows={8}>
      {(a) => (
        <article aria-labelledby="assessment-title" className="border border-line bg-sheet p-6">
          <h2 id="assessment-title" className="text-title font-bold">
            {a.ref}, version {a.version}
          </h2>
          <p className="text-small text-muted">
            Proposed by the {a.method} matcher.{" "}
            {a.body.rejected.length
              ? `The verifier dropped ${a.body.rejected.length} of the model's picks.`
              : ""}
          </p>
          <ol className="mt-4 flex list-none flex-col gap-6 p-0">
            {a.body.changes.map((c) => (
              <ChangeView key={c.id} c={c} reqs={a.requirements} />
            ))}
          </ol>
          {a.body.relinks.length > 0 && (
            <details className="mt-6">
              <summary className="cursor-pointer font-bold">
                Trace links to update ({a.body.relinks.length})
              </summary>
              <ul className="mt-2 list-disc pl-6">
                {a.body.relinks.map((l) => (
                  <li key={`${l.requirement}-${l.to?.clause}`}>
                    {l.requirement}: {l.to ? `to clause ${l.to.clause}` : "retire"}, because {l.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <SignoffPanel a={a} onSigned={r.retry} />
        </article>
      )}
    </Load>
  );
}

function ChangeView({ c, reqs }: { c: Change; reqs: Assessment["requirements"] }) {
  const sub = c.verdict === "substantive";
  return (
    <li className="border-t border-line pt-4">
      <h3 className="font-bold">
        {c.kind === "moved"
          ? `Clause ${c.before?.id} is now ${c.after?.id}`
          : c.kind === "added"
            ? `New clause ${c.after?.id}`
            : c.kind === "removed"
              ? `Clause ${c.before?.id} removed`
              : `Clause ${c.before?.id} changed`}
        <span
          className={`ml-2 rounded-soft px-2 text-small ${sub ? "bg-attentionWash text-attention" : "bg-idle text-ink"}`}
        >
          {sub ? "Substantive" : "Editorial"}
        </span>
      </h3>
      {c.changed.length > 0 && (
        <p className="text-small text-muted">Changed: {c.changed.map((p) => PARAM[p] ?? p).join(", ")}</p>
      )}
      <div className="mt-2 grid gap-3 md:grid-cols-2">
        {c.before && (
          <blockquote className="m-0 border-l-rule border-line pl-3 font-text">
            <span className="block text-small text-muted">Before</span>
            {c.before.text}
          </blockquote>
        )}
        {c.after && (
          <blockquote className="m-0 border-l-rule border-ink pl-3 font-text">
            <span className="block text-small text-muted">After</span>
            {c.after.text}
          </blockquote>
        )}
      </div>
      {c.affected.length > 0 && (
        <>
          <h4 className="mt-3 text-small font-bold">Requirements that implement it</h4>
          <ul className="mt-1 flex list-none flex-col gap-2 p-0">
            {c.affected.map((p) => (
              <li key={p.requirement} className="bg-paper p-3">
                <span className="font-bold">{p.requirement}</span>{" "}
                <span className="text-small text-muted">
                  ({p.device}, found by {p.via})
                </span>
                {reqs[p.requirement] && <span className="block">{reqs[p.requirement]?.text}</span>}
                {p.quote && <span className="mt-1 block text-small">Evidence: “{p.quote}”</span>}
                <span className="block text-small text-muted">{p.why}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {c.gaps.map((g) => (
        <p key={g.device} className="mt-2 border-l-rule border-fault bg-faultWash p-2">
          Gap for {g.device}: {g.why}.
        </p>
      ))}
      {c.flags.map((f) => (
        <p key={f} className="mt-2 border-l-rule border-attention bg-attentionWash p-2 text-small">
          For the expert: {f}
        </p>
      ))}
    </li>
  );
}

function SignoffPanel({ a, onSigned }: { a: Assessment; onSigned: () => void }) {
  const { who } = useSession();
  const [meaning, setMeaning] = useState<"reviewed" | "approved" | "rejected">("approved");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({
    busy: false,
    error: null,
    done: false,
  });
  const sign = async () => {
    setState({ busy: true, error: null, done: false });
    try {
      await api(`/api/assessments/${encodeURIComponent(a.id)}/signoff`, {
        method: "POST",
        identity: who,
        body: JSON.stringify({ bodyHash: a.body_hash, meaning, decisions: {} }),
      });
      setState({ busy: false, error: null, done: true });
      onSigned();
    } catch (e) {
      setState({ busy: false, error: e instanceof ApiError ? e.message : String(e), done: false });
    }
  };
  return (
    <section aria-labelledby="signoff-title" className="mt-8 border-t-rule border-ink pt-4">
      <h3 id="signoff-title" className="font-bold">
        Sign-off
      </h3>
      {a.signoffs.length > 0 ? (
        <ul className="mt-2 list-none p-0">
          {a.signoffs.map((s) => (
            <li key={s.seq}>
              {s.name} ({roleName(s.role)}) {s.meaning} this assessment on {new Date(s.at).toLocaleString()}.
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted">Nobody has signed this assessment.</p>
      )}
      <fieldset className="mt-3 flex flex-wrap gap-4">
        <legend className="text-small text-muted">
          Signing as {who.name}, {roleName(who.role)}. The signature records your name, role, the time, its
          meaning and the exact content you saw.
        </legend>
        {(["reviewed", "approved", "rejected"] as const).map((x) => (
          <label key={x} className="flex items-center gap-2">
            <input type="radio" name="meaning" checked={meaning === x} onChange={() => setMeaning(x)} />
            {x === "reviewed" ? "Reviewed" : x === "approved" ? "Approve" : "Reject"}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        disabled={state.busy}
        onClick={sign}
        className="mt-3 rounded-soft bg-ink px-4 py-2 font-bold text-paper disabled:opacity-60"
      >
        {state.busy ? "Signing…" : "Sign assessment"}
      </button>
      <AnimatePresence>
        {(state.error || state.done) && (
          <motion.p
            role={state.error ? "alert" : "status"}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: m.quick }}
            className={`mt-2 ${state.error ? "text-fault" : "text-verified"}`}
          >
            {state.error ?? "Signed. The signature is in the audit trail."}
          </motion.p>
        )}
      </AnimatePresence>
    </section>
  );
}
