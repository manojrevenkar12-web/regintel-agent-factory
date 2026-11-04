# 1. A simulated regulatory world with a truth the platform cannot see

## Context

The interesting failures of regulatory intelligence are silent: a scraper that keeps returning
plausible data after a site changes, a requirement that should have been flagged and was not. Real
regulator sites cannot be replayed with known answers, change rarely on demand, and this build
environment cannot reach them.

## Decision

Five fictional authorities publish guidance, revise it (editorial and substantive clause changes,
recorded by clause identity), and serve it over HTTP from sites whose layouts drift in eight ways
real sites do. A device maker's requirements trace to those clauses, with 20% of links missing and 3%
wrong, and free-text rationales of varying quality. The world keeps the truth; the platform gets only
pages and the requirements export.

## Consequences

Every number in `reports/` is scored against a truth nobody tuned to. The world is simpler than
EUR-Lex or FDA guidance pages; the README says which results would carry over and which would not.
