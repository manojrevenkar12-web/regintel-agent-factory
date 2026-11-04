# 4. DBOS durable workflows on PostgreSQL

## Context

A day's crawl of five sites can open an incident whose repair takes minutes and costs money. A crash
mid-repair must neither lose the incident nor pay for the repair twice.

## Decision

Each day is a DBOS workflow; each source's crawl, each incident and each repair step (evidence,
repair, decide) is a step. Workflow ids are deterministic (`run:setup:day:N`), so a restarted run
replays recorded steps instead of crawling or repairing again. PostgreSQL holds both DBOS's system
tables and the platform's record.

## Consequences

`packages/service/test/season.test.ts` reruns three days with the same ids and checks that no page is
fetched and no crawl recorded twice.
