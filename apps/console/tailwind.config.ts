import type { Config } from "tailwindcss";
import { color, font, line, measure, radius, space, strip, type } from "./src/theme/tokens";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    colors: { ...color, transparent: "transparent", current: "currentColor" },
    fontFamily: { ui: [...font.ui], text: [...font.text], code: [...font.code] },
    fontSize: Object.fromEntries(
      Object.entries(type).map(([k, [size, lineHeight]]) => [k, [size, { lineHeight }]]),
    ),
    spacing: { ...space, cell: strip.cell, strip: strip.height, px: line.hair },
    borderRadius: radius,
    borderWidth: { DEFAULT: line.hair, 0: "0", rule: line.rule },
    extend: {
      maxWidth: measure,
      width: { rail: measure.rail, panel: measure.panel },
      gap: { cell: strip.gap },
    },
  },
  plugins: [],
} satisfies Config;
