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
- `union` keeps the larger set's scopes below the smaller set's least, steps
  back over the larger set's scopes above it, and adds those and the smaller
  set's scopes in order, each the greatest so far. Adding to a set a scope it
  was once extended by finds the node that gave, so a union interns only the
  sets it starts with that the store did not hold, and costs the scopes it
  steps back over and the smaller set's size. A union with a single scope is
  an addition, and the node records each other union made from it.
  `publishedTo` steps back from the set to its first withdrawn scope in the
  same way.
- A node builds its sorted scope array the first time something reads it:
  `subset`, `has`, `debugRecord`, `serialize`, and the invocation-scope
  queries. Building it reuses the nearest ancestor's array.

The public representation, ordering, serialization, equality, subset, and
union semantics do not change. `scopeSetKey` and `unionScopeArrays` had no
other callers and are removed.

What a `ScopeSetId` numbers does change. Every prefix of an interned set is
itself a node, so inserting a scope below a set's greatest one interns, and
numbers, each set the answer starts with that the store did not hold yet,
though no caller asked for them. A set can therefore get a different ID than
the sorted-array store gave it, and `stats.internedSets` counts those
prefixes. `stats.internHits` counts answers found in a node's table of
additions or removals, including those taken on the store's own steps
forward. Only tests read the statistics.

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

`union` first added the smaller set's scopes to the larger one by one. When
all of them were smaller than the larger set's scopes, each addition stepped
over the whole larger set and interned every set on the way: d scopes into
d + 1 interned d·(d + 1) sets, 4 million in 1.4 s at d = 2,000. `publishedTo`
withdrew each pair the same way. Stepping back once, a union at d = 2,000
interns 2,001 sets in a few milliseconds, and at d = 16,000 interns 16,001.

## Consequences

- The store keeps a node per set and a table of the additions and removals
  made from it. Both grow with the operations a project performs, as the
  string keys did.
- A set's array is built only if something reads it, and at most once.
- An operation interns at most the sets its answer starts with that the store
  did not already hold; a test counts the sets `union` and `publishedTo`
  intern where the inputs share little.
- The fixed-seed model tests check `add`, `remove`, `flip`, `union`,
  `publishedTo`, `has`, `size`, `subset`, `hasUnmatchedIntroduction` and
  `introducedSince` against a model of plain sets over lexical scopes and
  paired and unpaired invocation scopes, and check that one set gets one ID
  however it was built.

## Reversal condition

Revisit if a profile shows sets being read as arrays, rather than extended,
dominating a representative workload.
