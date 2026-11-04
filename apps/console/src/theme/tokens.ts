/** Every size, colour role, duration and type step the console uses. Components read these (via
 * Tailwind's theme or directly); no component carries a number of its own.
 *
 * The look is a controlled document: cool paper, blue-black ink, a pine green for what the checks
 * verified, an amber for what waits on a person, a red for what is wrong. Clause text is set in a
 * serif because it is the regulator's words; everything the platform says is in a hyperlegible sans. */

/** Colour roles; values live in tokens.css as CSS variables (light and dark). */
export const color = {
  paper: "var(--paper)",
  sheet: "var(--sheet)",
  ink: "var(--ink)",
  muted: "var(--muted)",
  line: "var(--line)",
  verified: "var(--verified)",
  verifiedWash: "var(--verified-wash)",
  attention: "var(--attention)",
  attentionWash: "var(--attention-wash)",
  fault: "var(--fault)",
  faultWash: "var(--fault-wash)",
  link: "var(--link)",
  focus: "var(--focus)",
  idle: "var(--idle)",
} as const;

export const font = {
  ui: ['"Atkinson Hyperlegible"', "system-ui", "sans-serif"],
  text: ['"Source Serif 4"', "Georgia", "serif"],
  code: ['"JetBrains Mono"', "ui-monospace", "monospace"],
} as const;

/** A modular scale (1.2) from a 16px body. [size, line-height] in rem. */
export const type = {
  small: ["0.833rem", "1.25rem"],
  body: ["1rem", "1.5rem"],
  lead: ["1.2rem", "1.75rem"],
  title: ["1.44rem", "1.9rem"],
  display: ["2.074rem", "2.5rem"],
} as const;

/** Spacing on a 4px grid. */
export const space = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  6: "1.5rem",
  8: "2rem",
  12: "3rem",
  16: "4rem",
} as const;

export const radius = { none: "0", soft: "0.25rem", pill: "999px" } as const;
export const measure = { prose: "68ch", rail: "15rem", panel: "40rem", page: "80rem" } as const;
export const line = { hair: "1px", rule: "2px" } as const;

/** The season strip: one cell per day. */
export const strip = { cell: "0.5rem", gap: "1px", height: "1.5rem" } as const;

/** Motion: one load sequence (the season strips), and responses to what a person does. */
export const motion = {
  quick: 0.15,
  settle: 0.24,
  stripStagger: 0.004, // seconds per day cell
  ease: [0.2, 0, 0, 1] as [number, number, number, number],
} as const;
