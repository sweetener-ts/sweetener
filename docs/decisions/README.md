# Architecture Decision Records

Create one file per decision:

```text
docs/decisions/0001-package-and-tooling-baseline.md
docs/decisions/0002-source-opt-in.md
```

## Decision index

| ADR                                                           | Status     | Scope                                                |
| ------------------------------------------------------------- | ---------- | ---------------------------------------------------- |
| [ADR-0001](0001-package-and-tooling-baseline.md)              | accepted   | package manager, Node, TypeScript API, lint, tests   |
| [ADR-0002](0002-source-files-and-project-opt-in.md)           | accepted   | source extensions and project activation             |
| [ADR-0003](0003-declarative-pattern-surface.md)               | accepted   | repetition, fields, fallback rules, binding literals |
| [ADR-0004](0004-core-forms-operators-and-generated-syntax.md) | accepted   | core interception, operators, generated syntax       |
| [ADR-0005](0005-composition-and-acceptance-scope.md)          | accepted   | recursive composition, overloads, required fixtures  |
| [ADR-0006](0006-invocation-scope-transform.md)                | accepted   | introduction flip and invocation use-site scopes     |
| [ADR-0007](0007-scope-set-intern-key-cache.md)                | superseded | measured scope-set interning optimization            |
| [ADR-0008](0008-fragment-validation.md)                       | accepted   | complete-file TypeScript validation                  |
| [ADR-0009](0009-directive-opt-in-and-javascript-targets.md)   | accepted   | `"use sweetener"` opt-in and JavaScript targets      |
| [ADR-0010](0010-scope-set-trie.md)                            | accepted   | scope sets interned as a trie                        |

Use this template:

```markdown
# ADR-NNNN: Title

Status: proposed | accepted | superseded  
Date: YYYY-MM-DD  
Owners: names

## Decision

State the selected behavior.

## Context

Name the concrete constraint and affected specifications or tasks.

## Options measured

Describe each option, fixture or benchmark, and result.

## Consequences

List code, compatibility, test, and migration effects.

## Reversal condition

Name evidence that would justify revisiting the decision.
```

An ADR cannot override a normative specification without changing that
specification in the same review.
