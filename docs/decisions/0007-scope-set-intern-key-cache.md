# ADR-0007: Cache scope-set intern keys

Status: superseded by [ADR-0010](0010-scope-set-trie.md)  
Date: 2026-08-03  
Owners: project maintainers

## Context

The CPU profile for `hygiene/persistent-add-chain` attributed dominant samples
to `scopeSetKey` and `ScopeStore.add`. Every append joined the complete prefix
into a new string, then copied the already-new array again. The Node 24 baseline
measured p50 834.93 ms for 5,000 additions.

## Decision

Store the canonical key beside every interned `ScopeSetId`. Appending a
monotonically increasing scope extends that known key. Private callers transfer
their newly allocated immutable array directly to the interner. Non-append
insertion, removal, and union retain canonical sorted-array key calculation.

The public representation, ordering, IDs, serialization, equality, subset, and
union semantics do not change.

## Verification

- algebra and fixed-seed model tests remain the semantic oracle;
- large-batch tests verify immutable storage;
- the refreshed Node 24 p50 is 141.67 ms for the identical workload;
- the full repository and declarative-boundary gates remain green.

## Consequences

The store retains one additional canonical string reference per interned set.
It already retains the same string in the reverse map. No public migration is
required.

## Reversal condition

Replace sorted arrays only if representative binding workloads, rather than a
synthetic large chain, show that copying remains a release bottleneck.
