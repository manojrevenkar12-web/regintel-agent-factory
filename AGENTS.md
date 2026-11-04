# Working on this repository

## Fast feedback

- `pnpm typecheck && pnpm lint` (seconds)
- `pnpm test` runs every unit and pipeline test. The store, API and durable-season tests need
  PostgreSQL with pgvector in `RIF_TEST_DATABASE_URL` (a role that may create extensions and
  databases); without it they are skipped, not failed.
- `scripts/check.sh` runs all of the above, builds the console and runs its end-to-end tests
  against a short people-only season (needs `RIF_DATABASE_URL` too).
- The measured runs call Claude through the Claude Code CLI and cost money:
  `rif season --setup sonnet-gated --fresh` (about $2), `rif heldout --setup <name>` (about $1),
  `rif impact --setup sonnet-gated` (about $1). `rif report` rebuilds `reports/RESULTS.md` and
  `reports/results.json` from what they wrote, for free.

## Invariants (each has a test)

- **The platform never sees the truth.** Only `packages/world` (the simulator) and the service's
  evaluation files (`evaluate.ts`, `report.ts`, `counterfactual.ts`, `heldout.ts`, `season.ts` as the
  harness, `impact-run.ts` for the requirements export) import `@rif/world`. `ingest`, `factory` and
  `impact` never do. `packages/service/test/pipeline.test.ts` checks the imports and that the
  requirements export carries no truth.
- **Data from a crawl that fails its contract is never used.** Production keeps the last good crawl
  until a fix passes every gate.
- **Nothing ships on the agent's word.** A repair deploys only when scope, typecheck, the contract on
  the agent's pages, the contract on every page the site serves and the gaming checks pass, and the
  reviewer approves. Contracts are locked in the sandbox; changing them fails the scope gate.
- **Agents get least privilege.** Repair sessions run `--restricted` with file tools and one shell
  command (`rif-check`), an empty environment and a spend cap; the reviewer can only read.
- **Models read, code decides.** In change impact the rules classify changes and compute scope and
  gaps; a model only picks candidates, and the verifier drops any pick that is not a candidate, not in
  scope, misquoted, linked to another clause that states the obligation, or contradicts the clause's
  deadline without a link.
- **People sign.** An assessment counts only when signed; a sign-off is bound to the hash of what was
  signed, a stale hash is refused, signed assessments are never overwritten, and sign-offs and the
  audit log are append-only (database triggers) and hash-chained.
- **Settings live in `config/`**, not in code: `world.yaml`, `contracts.yaml`, `factory.yaml`,
  `impact.yaml`, `heldout/`.

## Held-out sets

`config/heldout/incidents.yaml` and `config/heldout/world.yaml` were written before the factory and
the matchers were run on them. Their first runs (`reports/heldout/<setup>/first_run.json`,
`reports/heldout/FIRST_RUN.md`, `reports/heldout/impact/*.json`) are never rewritten; later runs go
to `latest.json`. Never change the factory, the gates or the matchers to pass them. If you study
their failures, move them into a dev set and have someone who has not read the code write a new
held-out set from `docs/WRITING_HELDOUT.md` only.

## Where things are

- `packages/world`: the simulated regulators, their websites and drift, the company, the truth
- `packages/ingest`: scrapers, fetching, the extraction contract
- `packages/factory`: the repair agent's sandbox, the gates, the reviewer, the decision
- `packages/impact`: clause diff, retrieval, matchers, the verifier, model readers
- `packages/service`: PostgreSQL record, DBOS workflows, CLI, API, evaluation
- `apps/console`: the control surface (React, Vite, Tailwind, Framer Motion)
