# 3. Change impact: rules decide, models read, a verifier checks, people sign

## Context

Mapping a changed clause to the requirements that implement it is the hard part: many documents
impose the same obligation, so many requirements read alike, and trace links are incomplete.

## Decision

The clause diff, the editorial/substantive call, scope and gaps are computed by code. Candidates come
from links and hybrid retrieval (BM25 plus hashed embeddings kept in pgvector). A model may pick among
candidates and must quote its evidence; a verifier drops picks that are not candidates, out of scope,
misquoted, linked to another clause stating the same obligation, or that contradict the clause's
deadline without a link. Every matcher, from links-only to the raw model, is measured on the same
versions. An assessment counts only when an expert signs it, and the signature binds to its hash.

## Consequences

The model is conservative: it leaves ambiguous cases to the expert rather than guessing, which shows
as high precision and lower recall. The rules matcher, tuned on the season world, trades precision for
recall. Both are reported on a held-out world.
