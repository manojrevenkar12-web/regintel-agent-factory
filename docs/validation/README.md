# Validation pack

How this platform would be validated for use in a GxP quality system, and the evidence it already
produces. It follows a risk-based approach in the spirit of GAMP 5 (second edition) and the FDA's
Computer Software Assurance guidance: test hardest where a wrong result could reach a compliance
decision, and use the system's own records as evidence.

## Intended use

Watch regulators' published guidance; keep the extracted documents current and correct; when a
document changes, propose which of the manufacturer's requirements are affected and which devices
gain obligations without a requirement; record an expert's decision on each proposal.

The platform proposes. It never changes the manufacturer's requirements or trace links itself, and a
proposal has no effect until a qualified person signs it.

## Risk assessment

| Hazard | Effect | Control | Evidence |
|---|---|---|---|
| A site change makes the scraper return wrong data silently | Compliance decisions on wrong text | Extraction contract on every crawl; failed crawls are never used | `docs/validation/traceability.md` URS-01, URS-02; season wrong doc-days in `reports/RESULTS.md` |
| An agent ships a fix that works on the pages it saw only | Wrong or missing documents | Contract on every page the site serves; gaming checks; reviewer | URS-03; held-out incidents, `reports/heldout/FIRST_RUN.md` |
| A real content change is "fixed" in code | A regulator's correction is hidden | Agent may hand back; locked contracts; person confirms | URS-04 |
| A changed clause is missed or called editorial | Requirement not updated | Rules on obligation parameters; unclear cases flagged | URS-06; classification accuracy in `reports/RESULTS.md` |
| A requirement is linked to a change without evidence | Wasted work or a wrong update | Verifier on every model pick; quotes required | URS-07 |
| An assessment is changed after it was signed | Signature covers content nobody saw | Hash-bound sign-off; append-only, hash-chained records | URS-09, URS-10 |

## Electronic records and signatures

Sign-offs carry the signer's id and printed name, role, meaning (reviewed, approved, rejected), time
and the hash of the exact assessment body, as 21 CFR Part 11 and EU GMP Annex 11 expect of an
electronic signature linked to its record. Identity comes from the sign-in proxy in front of the API;
re-authentication at signing is the proxy's job and is not implemented here.

## What a validation run consists of

1. Installation: `pnpm install`, `pnpm typecheck`, migrations applied (`Store.migrate`).
2. Operational tests: `pnpm test` with `RIF_TEST_DATABASE_URL`, and the console's end-to-end tests.
3. Performance on the intended use: the season, the held-out incidents and the held-out world
   (`reports/RESULTS.md`), with first runs kept unchanged.
4. Traceability: every user requirement in `urs.md` maps to tests in `traceability.md`; a test
   (`packages/service/test/validation.test.ts`) fails if a mapped test no longer exists.
