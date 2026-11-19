import { VERDICTS, type Verdict, verdictTone, verdictWords } from "./types";

/** A procedure's findings as one proportional bar, with the counts in words beside it. */
export function VerdictBar({ counts }: { counts: Partial<Record<Verdict, number>> }) {
  const total = VERDICTS.reduce((s, v) => s + (counts[v] ?? 0), 0);
  if (!total) return null;
  const words = VERDICTS.filter((v) => counts[v]).map((v) => `${counts[v]} ${verdictWords[v].toLowerCase()}`);
  return (
    <span className="mt-1 flex items-center gap-3">
      <span aria-hidden="true" className="flex h-cell w-rail gap-cell overflow-hidden rounded-soft">
        {VERDICTS.map((v) =>
          counts[v] ? <span key={v} className={verdictTone[v].bar} style={{ flexGrow: counts[v] }} /> : null,
        )}
      </span>
      <span className="text-small text-muted">{words.join(", ")}</span>
    </span>
  );
}
