# 2. Agents repair scrapers; gates and a reviewer decide

## Context

A coding agent fixing a scraper will usually say its fix works. In the season every first attempt
was in fact right; on the held-out incidents most were not, and the agent believed them all.

## Decision

The agent works in a sandbox with the failing pages, the last good data and one check command. Its
fix ships only if the scope, typecheck, contract-on-its-pages, contract-on-every-page and gaming
gates pass and a read-only reviewer approves. The contract runs on pages the agent never saw. The
agent may hand an incident back when the site's content really changed.

## Consequences

Repairs cost a little more and an over-cautious reviewer sometimes sends a correct fix to a person
(it happened once in the season). In exchange no fix that would have produced wrong data reached
production in any run.
