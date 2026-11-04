/** The validation pack cannot drift from the tests: every mapped test must exist, and every user
 * requirement must be mapped to at least one test. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@rif/ingest";
import { describe, expect, it } from "vitest";

const rows = (file: string) =>
  readFileSync(join(ROOT, file), "utf8")
    .split("\n")
    .filter((l) => /^\| URS-\d+/.test(l))
    .map((l) =>
      l
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean),
    );

describe("the validation pack", () => {
  const trace = rows("docs/validation/traceability.md");
  it("names only tests that exist", () => {
    for (const [, file, name] of trace)
      expect(readFileSync(join(ROOT, file as string), "utf8"), `${file}: ${name}`).toContain(name as string);
  });
  it("traces every user requirement to a test", () => {
    const mapped = new Set(trace.map((r) => r[0]));
    for (const [id] of rows("docs/validation/urs.md")) expect(mapped, id).toContain(id);
  });
});
