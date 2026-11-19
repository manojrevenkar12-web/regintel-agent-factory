# 6. An expert's ruling is reused only on the same words

## Context

Customers revise procedures, and most steps survive a revision unchanged. Re-reviewing every finding
wastes the expert's time; reusing a ruling on a step that has changed can turn a gap into a false
"met". A first version reused rulings on similar text and produced exactly that.

## Decision

A correction is stored as a ruling with the customer, the requirement's key, the exact text of the
steps the expert pointed at, and the procedure's hash. On the next run a ruling applies only if every
one of those step texts is still present word for word and the checker quoted nothing else. A ruling
that something is missing names no step, so it applies only while the whole procedure's hash is
unchanged. Anything else is checked afresh.

## Consequences

On the revised held-out procedures, reused rulings cut the reviews from 206 to 76 with no wrong reuse.
Any edit, even a comma, sends the finding back to the checker; that costs some reviews and is the
intended trade.
