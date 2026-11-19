# 5. SOP compliance: code gives the verdict, weak evidence goes to an expert

## Context

A customer asks whether their procedures meet the requirements in force. A wrong "met" is the costly
error: the customer stops looking. Keyword matching, the usual first try, calls most weakened or
contradicting steps "met" because they read like the requirement. Reviewing every requirement by hand
is right but costs about six expert minutes each.

## Decision

Requirements are formulated from clauses by code: one per obligation and device, every source clause
traced, the strictest deadline and frequency kept. Each procedure step is read for its action terms,
deadline, frequency, weakening words, deferral and the party that acts. The verdict (met, met in part,
contradicted, not in the procedure) comes from those readings. A finding is accepted unreviewed only when
the evidence is strong and explicit (`check.auto_cover`, `check.missing_auto` in
`config/compliance.yaml`); everything else is routed to an expert with the steps it quotes and its
reasons. A model reader may propose verdicts, but its quotes must be in the steps it names, code
recomputes the numbers, and any disagreement is routed to review. Reviews are append-only and bound to
the hash of the finding; a stale hash is refused.

## Consequences

The measure is what reaches the report unreviewed and the expert minutes spent, scored against the
simulator's truth. On the held-out world nothing unmet reached the report as met, but three met
requirements were accepted as gaps because their steps used verbs the glossary does not know. The
glossary is the weak point; on real SOPs the model reader would have to cover it, and it has not been
measured here.
