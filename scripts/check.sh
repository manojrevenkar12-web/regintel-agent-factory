#!/usr/bin/env bash
# Everything CI runs, locally. Needs RIF_TEST_DATABASE_URL and RIF_DATABASE_URL (PostgreSQL with
# pgvector); runs a short people-only season (no model calls) for the console's end-to-end tests.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm typecheck
pnpm lint
pnpm test
(cd apps/console && pnpm build)
pnpm rif season --setup people-only --days 30 --fresh
pnpm rif impact --setup people-only --only links,rules
PORT=${PORT:-8787} pnpm rif serve &
API=$!
trap 'kill $API' EXIT
for _ in $(seq 1 30); do curl -sf "http://localhost:${PORT:-8787}/api/health" >/dev/null && break; sleep 1; done
(cd apps/console && RIF_CONSOLE_URL="http://localhost:${PORT:-8787}" pnpm e2e)
