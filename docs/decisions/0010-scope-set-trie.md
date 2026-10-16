# ADR-0010: Intern scope sets as a trie

Status: accepted  
Date: 2026-10-15  
Owners: Jimmy Miller

Supersedes [ADR-0007](0007-scope-set-intern-key-cache.md).

## Decision

Intern each scope set as one node of a trie over its sorted scopes. A node is
its parent's set with one scope added that is greater than every scope the
parent holds. Each set has exactly one node, so a `ScopeSetId` still names one
set and equality is still identity.

- Adding a scope greater than all of a set's scopes, as a freshly allocated
  scope is, is one lookup in the node's table of additions. Adding a smaller
  scope, or removing one, steps back to where the scope belongs and steps
  forward again over the larger scopes. Both answers are recorded on the node,
  so the same operation is one lookup the next time.
- `union` adds the smaller set's scopes to the larger set.
- A node builds its sorted scope array the first time something reads it:
  `subset`, `has`, `debugRecord`, `serialize`, and the invocation-scope
  queries. Building it reuses the nearest ancestor's array.

The public representation, ordering, IDs, serialization, equality, subset, and
union semantics do not change. `scopeSetKey` and `unionScopeArrays` had no
other callers and are removed.

## Context

ADR-0007 kept sorted arrays keyed by their joined string and named its
reversal condition: a representative binding workload in which copying
remains a bottleneck. The PR-33 review found one. Nesting 300 blocks with a
binding contract in each gives each block's following scope to every token
after the contract, so the innermost tokens carry 300 scopes. Every one of
those additions copied the token's scope array and joined its key: in a CPU
profile, `scopeSetKey` was 22% of the run and `unionScopeArrays` 11%.

## Options measured

All times are p50 on the same machine under load 10 to 30.

| Workload                                               | sorted arrays (ADR-0007) | trie         |
| ------------------------------------------------------ | ------------------------ | ------------ |
| `hygiene/persistent-add-chain` (5,000 additions)       | 55.2–70.3 ms             | 1.5–2.4 ms   |
| `hygiene/singleton-interning`                          | 15.3–17.0 ms             | 6.9–8.3 ms   |
| 300 nested blocks, a contract in each, through `check` | 1,951–1,998 ms           | 947–1,037 ms |

## Consequences

- The store keeps a node per set and a table of the additions and removals
  made from it. Both grow with the operations a project performs, as the
  string keys did.
- A set's array is built only if something reads it, and at most once.
- The fixed-seed model tests cover `add`, `remove`, `flip`, `union`, `has`,
  `size` and `subset`, and check that one set gets one ID however it was
  built.

## Reversal condition

Revisit if a profile shows sets being read as arrays, rather than extended,
dominating a representative workload.
