/** One source's season as a strip of day cells: quiet when the crawl was good, red while production
 * data was frozen, hatched on maintenance days, with a mark on each incident's day (green when the
 * agent fixed it the same day, amber when it went to a person). The strips draw in once, day by day. */
import { motion, useReducedMotion } from "framer-motion";
import { href } from "../../shared/route";
import { motion as m } from "../../theme/tokens";

export type Day = { day: number; status: string };
export type Mark = { id: string; day: number; status: string };

const CELL: Record<string, string> = {
  ok: "bg-line",
  failed: "bg-fault",
  maintenance: "bg-idle",
  skipped: "bg-idle",
};

export function SeasonStrip({
  label,
  days,
  marks,
  length,
}: { label: string; days: Day[]; marks: Mark[]; length: number }) {
  const reduce = useReducedMotion();
  const byDay = new Map(days.map((d) => [d.day, d.status]));
  const markAt = new Map(marks.map((x) => [x.day, x]));
  const failed = days.filter((d) => d.status === "failed").length;
  return (
    <figure className="m-0">
      <figcaption className="sr-only">
        {label}: {days.length} days crawled, {failed} with production data frozen, {marks.length} incidents.
      </figcaption>
      <div className="flex gap-cell" aria-hidden="true">
        {Array.from({ length }, (_, day) => {
          const s = byDay.get(day);
          const mk = markAt.get(day);
          return (
            <motion.div
              // biome-ignore lint/suspicious/noArrayIndexKey: a day is its index
              key={day}
              className="relative flex h-strip w-cell flex-col justify-end"
              initial={reduce ? false : { opacity: 0, scaleY: 0.2 }}
              animate={{ opacity: 1, scaleY: 1 }}
              transition={{ delay: day * m.stripStagger, duration: m.settle, ease: m.ease }}
            >
              {mk && (
                <span
                  className={`absolute inset-x-0 top-0 h-1 ${mk.status === "deployed" ? "bg-verified" : "bg-attention"}`}
                />
              )}
              <span
                className={`block h-3 w-full ${s ? (CELL[s] ?? "bg-idle") : "bg-transparent"} ${s === "maintenance" ? "opacity-60" : ""}`}
              />
            </motion.div>
          );
        })}
      </div>
      <p aria-hidden="true" className="mt-1 flex justify-between text-small text-muted">
        <span>Day 0</span>
        <span>Day {length - 1}</span>
      </p>
      {marks.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-2 text-small">
          {marks.map((x) => (
            <li key={x.id}>
              <a className="text-link underline-offset-2 hover:underline" href={href("incidents", x.id)}>
                Day {x.day}:{" "}
                {x.status === "deployed"
                  ? "fixed by the agent"
                  : x.status === "fixed_by_person"
                    ? "fixed by a person"
                    : x.status.replace(/_/g, " ")}
              </a>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
