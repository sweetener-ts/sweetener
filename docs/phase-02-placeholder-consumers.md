# Phase 2 Grammar-Consumer Placeholders

Structural macro matching uses fixed consumers for two fragment classes, which
isolates it from the TypeScript grammar work scheduled for Phase 4. Expressions
use the production Pratt consumer. Tests load the machine-readable
ledger at `fixtures/phase-02/structural-examples/placeholders.json` and reject
an untracked placeholder.

| Class     | Phase 2 behavior                | Replacement |
| --------- | ------------------------------- | ----------- |
| `binding` | consume one identifier token    | `ENF-005`   |
| `type`    | consume one balanced token tree | `ENF-006`   |

The remaining fixture syntax avoids claims about full binding or type extent.
Phase 4 replaces those consumers before expansion acceptance tests use
production source.
