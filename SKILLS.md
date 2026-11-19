# Repeatable tasks

- **Check the build.** `pnpm typecheck && pnpm lint && pnpm test`; `scripts/check.sh` for what CI runs.
- **Run the SOP compliance evaluation.** `pnpm rif compliance` scores every design on the season world
  and writes `reports/compliance/season.json`; `pnpm rif report` puts it in `reports/RESULTS.md`.
- **Load a compliance run for the console.** `pnpm rif compliance --load [--version N]` runs the check
  as a DBOS workflow into `RIF_DATABASE_URL`. A run is written once: to reload changed code, use a new
  database (or a new version), not a delete.
- **Add a glossary phrase.** Add it to `config/compliance.yaml` under `canonical`, add a case to
  `packages/compliance/test/compliance.test.ts`, and rerun the season-world evaluation. Do not use the
  held-out misses as the source of new phrases (see AGENTS.md).
- **Run a season or the change-impact matchers.** See the commands in README "Run it" and the costs in
  AGENTS.md.
- **Take console screenshots.** Build the console, `pnpm rif serve`, and capture with Playwright into
  `docs/screenshots/`.
