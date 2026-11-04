# Traceability: user requirements to tests

Checked by `packages/service/test/validation.test.ts`: every test named here must exist in its file.

| URS | Test file | Test |
|---|---|---|
| URS-01 | packages/ingest/test/ingest.test.ts | catches an empty or shrunken listing and documents missing from the sitemap |
| URS-01 | packages/ingest/test/ingest.test.ts | treats a changed document under the same version as the scraper's fault |
| URS-01 | packages/service/test/pipeline.test.ts | every drift breaks the scraper written for the layout before it, loudly |
| URS-02 | packages/service/test/store.test.ts | records crawls and new document versions once |
| URS-03 | packages/factory/test/factory.test.ts | deploys a correct fix once every gate passes and the reviewer approves |
| URS-03 | packages/factory/test/factory.test.ts | never deploys a fix that hard-codes data, however well it scores |
| URS-03 | packages/factory/test/factory.test.ts | escalates when the reviewer says a person should look |
| URS-04 | packages/factory/test/factory.test.ts | stops at once when the agent finds no scraper fault and changes nothing |
| URS-05 | packages/factory/test/factory.test.ts | keeps the agent's sandbox free of the world and its truth |
| URS-05 | packages/factory/test/factory.test.ts | restricts the repair role to file tools and one check command, and the reviewer to reading |
| URS-06 | packages/impact/test/impact.test.ts | calls a renumbering editorial, not a removal and an addition |
| URS-06 | packages/impact/test/impact.test.ts | calls a changed deadline, strength or scope substantive and names the parameter |
| URS-06 | packages/impact/test/impact.test.ts | leaves a rewording with the same parameters to a person, even when renumbered |
| URS-07 | packages/impact/test/impact.test.ts | rejects picks that are not candidates, out of scope, misquoted or linked elsewhere |
| URS-07 | packages/impact/test/impact.test.ts | rejects a pick whose deadline disagrees with the clause |
| URS-08 | packages/impact/test/impact.test.ts | turns a widened scope into a gap, and an unparseable answer into an error |
| URS-09 | packages/service/test/store.test.ts | binds a sign-off to the assessment it signed, by hash, and keeps it |
| URS-09 | packages/service/test/api.test.ts | signs as the signed-in person, refuses strangers and stale hashes |
| URS-10 | packages/service/test/store.test.ts | chains the audit log and detects a changed entry |
| URS-11 | packages/service/test/season.test.ts | crawls each source once a day and replays, not repeats, a rerun |
| URS-12 | packages/service/test/pipeline.test.ts | nothing that decides imports the world |
| URS-12 | packages/service/test/pipeline.test.ts | the requirements export carries no truth |
| URS-13 | apps/console/e2e/console.spec.ts | renders and passes axe |
| URS-13 | apps/console/e2e/console.spec.ts | every screen shows a loading skeleton, then an error with retry |
