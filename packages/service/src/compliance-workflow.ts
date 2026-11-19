/** The compliance check as a durable DBOS workflow: check every procedure, then record the run. A
 * crash between the two resumes from the recorded check instead of checking again, and a rerun with the
 * same workflow id replays the result instead of writing a second run. */
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { World } from "@rif/world";
import { check } from "./compliance-run.js";
import { rulings, saveRun } from "./compliance-store.js";
import type { Store } from "./store.js";

let ctx: { store: Store; worlds: Record<string, World> } | null = null;
export const setComplianceContext = (c: { store: Store; worlds: Record<string, World> }) => {
  ctx = c;
};

export const complianceWorkflow = DBOS.registerWorkflow(
  async (input: { run: string; world: string; version: number }) => {
    const c = ctx;
    if (!c) throw new Error("setComplianceContext first");
    const w = c.worlds[input.world];
    if (!w) throw new Error(`no world ${input.world}`);
    const known = await DBOS.runStep(() => rulings(c.store), { name: "rulings" });
    const result = await DBOS.runStep(
      async () => {
        const r = check(w, input.version, "rules", known);
        return { procs: r.procs, out: r.out };
      },
      { name: "check" },
    );
    return DBOS.runStep(
      () =>
        saveRun(
          c.store,
          { id: input.run, world: input.world, version: input.version, design: "rules" },
          result.procs,
          result.out,
        ),
      { name: "save" },
    );
  },
  { name: "compliance-check" },
);
