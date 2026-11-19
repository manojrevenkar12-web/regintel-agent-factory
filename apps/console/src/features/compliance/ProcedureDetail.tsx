import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { ApiError, api, useResource } from "../../shared/api";
import { roleName, useSession } from "../../shared/session";
import { Load } from "../../shared/ui/states";
import { count } from "../../shared/words";
import { motion as m } from "../../theme/tokens";
import {
  type Detail,
  type Finding,
  VERDICTS,
  type Verdict,
  current,
  needsReview,
  verdictTone,
  verdictWords,
} from "./types";

/** The procedure as the customer wrote it, beside the findings: picking a finding marks its steps. */
export function ProcedureDetail({ run, id }: { run: string; id: string }) {
  const r = useResource<Detail>(
    `/api/compliance/runs/${encodeURIComponent(run)}/procedures/${encodeURIComponent(id)}`,
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Load r={r} what="the procedure" rows={10}>
      {(d) => {
        const focus = d.findings.find((f) => f.id === open);
        const marked = new Set(focus ? (focus.reviews.at(-1)?.steps ?? focus.body.steps) : []);
        const waiting = d.findings.filter(needsReview).length;
        return (
          <article aria-labelledby="proc-title">
            <h2 id="proc-title" className="font-text text-title">
              {d.procedure.title}
            </h2>
            <p className="mt-1 text-small text-muted">
              {d.procedure.id}, customer {d.procedure.customer}. {count(d.findings.length, "requirement")}{" "}
              checked, {waiting ? `${waiting} waiting for an expert` : "none waiting for an expert"}.
            </p>
            <div className="mt-6 grid gap-6 2xl:grid-cols-2">
              <section aria-label="The procedure" className="border-l-rule border-line pl-4">
                <ol className="m-0 list-none p-0">
                  {d.procedure.steps.map((s) => (
                    <li
                      key={s.id}
                      className={`py-1 font-text transition-colors ${marked.has(s.id) ? `${verdictTone[current(focus as Finding)].wash} -mx-2 px-2` : ""}`}
                    >
                      <span className="mr-2 font-ui text-small text-muted">{s.id}</span>
                      {s.text}
                    </li>
                  ))}
                </ol>
              </section>
              <section aria-label="Findings">
                <ul className="m-0 list-none p-0">
                  {d.findings.map((f) => (
                    <FindingItem
                      key={f.id}
                      f={f}
                      run={run}
                      steps={d.procedure.steps}
                      open={open === f.id}
                      toggle={() => setOpen(open === f.id ? null : f.id)}
                      onReviewed={r.retry}
                    />
                  ))}
                </ul>
              </section>
            </div>
          </article>
        );
      }}
    </Load>
  );
}

function FindingItem({
  f,
  run,
  steps,
  open,
  toggle,
  onReviewed,
}: {
  f: Finding;
  run: string;
  steps: { id: string; text: string }[];
  open: boolean;
  toggle: () => void;
  onReviewed: () => void;
}) {
  const reduce = useReducedMotion();
  const v = current(f);
  const tone = verdictTone[v];
  const route = f.reviews.length
    ? "reviewed"
    : f.body.route === "review"
      ? "waits for an expert"
      : f.body.route === "ruling"
        ? "as ruled before"
        : "accepted unreviewed";
  return (
    <li className="border-t border-line py-3">
      <button type="button" aria-expanded={open} onClick={toggle} className="w-full text-left">
        <span className={`text-small font-bold ${tone.text}`}>{verdictWords[v]}</span>
        <span className="text-small text-muted">, {route}</span>
        <span className="mt-1 block">{f.requirement.text}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: m.settle, ease: m.ease }}
            className="overflow-hidden"
          >
            <div className="mt-3 border-l-rule border-line pl-3 text-small">
              <p className="font-bold">Why</p>
              <ul className="m-0 list-disc pl-4">
                {f.body.reasons.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="mt-2 font-bold">The clauses behind it</p>
              <ul className="m-0 list-none p-0">
                {f.requirement.sources.map((s) => (
                  <li key={`${s.ref}#${s.clause}`} className="mt-1">
                    <span className="text-muted">
                      {s.ref} {s.clause}:
                    </span>{" "}
                    <span className="font-text">{s.text}</span>
                  </li>
                ))}
              </ul>
              {f.reviews.map((r) => (
                <p key={r.seq} className="mt-2">
                  {r.reviewer} ({roleName(r.role)}) {r.decision} it as {verdictWords[r.verdict].toLowerCase()}
                  {r.note ? `: ${r.note}` : "."}
                </p>
              ))}
              <ReviewForm f={f} run={run} steps={steps} onReviewed={onReviewed} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function ReviewForm({
  f,
  run,
  steps,
  onReviewed,
}: { f: Finding; run: string; steps: { id: string; text: string }[]; onReviewed: () => void }) {
  const { who } = useSession();
  const [verdict, setVerdict] = useState<Verdict>(f.body.verdict);
  const [chosen, setChosen] = useState<string[]>(f.body.steps);
  const [note, setNote] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null; done: boolean }>({
    busy: false,
    error: null,
    done: false,
  });
  const corrected = verdict !== f.body.verdict || chosen.join() !== f.body.steps.join();
  const send = async () => {
    setState({ busy: true, error: null, done: false });
    try {
      await api(
        `/api/compliance/runs/${encodeURIComponent(run)}/findings/${encodeURIComponent(f.id)}/review`,
        {
          method: "POST",
          identity: who,
          body: JSON.stringify({
            bodyHash: f.body_hash,
            decision: corrected ? "corrected" : "confirmed",
            verdict,
            steps: chosen,
            note,
          }),
        },
      );
      setState({ busy: false, error: null, done: true });
      onReviewed();
    } catch (e) {
      setState({ busy: false, error: e instanceof ApiError ? e.message : String(e), done: false });
    }
  };
  return (
    <fieldset className="mt-3 border-t border-line pt-3">
      <legend className="sr-only">Review this finding</legend>
      <p className="text-muted">
        Reviewing as {who.name}, {roleName(who.role)}. Your decision is bound to exactly this finding and
        reused only on the same words.
      </p>
      <div className="mt-2 flex flex-wrap gap-4">
        {VERDICTS.map((x) => (
          <label key={x} className="flex items-center gap-2">
            <input type="radio" name={`v-${f.id}`} checked={verdict === x} onChange={() => setVerdict(x)} />
            {verdictWords[x]}
          </label>
        ))}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-link">
          Steps that carry it ({chosen.length ? chosen.join(", ") : "none"})
        </summary>
        <div className="mt-1 flex flex-wrap gap-3">
          {steps.map((s) => (
            <label key={s.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={chosen.includes(s.id)}
                onChange={(e) =>
                  setChosen(e.target.checked ? [...chosen, s.id] : chosen.filter((x) => x !== s.id))
                }
              />
              {s.id}
            </label>
          ))}
        </div>
      </details>
      <label className="mt-2 block">
        {corrected ? "Why you corrected it (required)" : "Note (optional)"}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="mt-1 block w-full rounded-soft border border-line bg-sheet p-2"
        />
      </label>
      <button
        type="button"
        disabled={state.busy || (corrected && !note.trim())}
        onClick={send}
        className="mt-2 rounded-soft bg-ink px-4 py-2 font-bold text-paper disabled:opacity-60"
      >
        {state.busy ? "Saving…" : corrected ? "Save correction" : "Confirm finding"}
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
            {state.error ?? "Saved. The decision is in the audit trail and will be reused on these words."}
          </motion.p>
        )}
      </AnimatePresence>
    </fieldset>
  );
}
