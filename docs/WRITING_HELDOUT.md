# Writing a held-out set

For someone who has not read the factory, the gates or the matchers. Use only this page,
`config/world.yaml` and `packages/world/src/sites.ts` (what a site can look like).

## Incidents (`config/heldout/incidents.yaml`)

Each incident is one event in its own copy of the world. Pick events a real regulator website
produces, and say what a careful engineer would do:

- `expect: deploy` when the scraper is at fault and a correct fix exists that reads every page the
  site serves (for example a template change on some pages only).
- `expect: escalate` when the site's content really changed and a person must confirm it (documents
  withdrawn, a clause corrected without a new version, a date corrected).

Aim for at least four of each. Do not pick an event because you expect the agent to pass or fail.

## Change impact (`config/heldout/world.yaml`)

Copy `config/world.yaml` and change only the seed. Do not change the rates or the company: the
held-out world must be the same kind of world, drawn again.

## Recording

Run each setup once and commit the first run before anyone looks at the failures.
