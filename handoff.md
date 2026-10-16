# Handoff

State at `2403709`: 36 commits since `22a98a5`, 2644 unit tests, `pnpm check` green
end to end. Everything below is open.

The session began by deleting a hand-written `declare module "*.sts"` stub and
turned into a long chain of parser and expander fixes. Five of those were silent
— wrong output with no diagnostic — and one was a runtime miscompile. A review of
the whole diff then found nine regressions the session had itself introduced; all
nine are fixed, and the fixes are the part nobody has reviewed yet.

Two facts worth keeping in mind while reading the rest:

- A refused item drops the module to a raw token walk, where a macro at statement
  head is silently not expanded. That is why reader gaps matter more than their
  shapes suggest.
- A corpus differential (480 file×macro combinations over this repo's sources)
  put the session's name-position work at ~60 files improved and 0 newly broken,
  and the reader is lossless over 694 real files. The list below is the tail, not
  the trend.

## Before shipping

1. **Review the last five commits.** `b07fb68`, `7c80c50`, `2403709` and their
   two predecessors are the fixes for the nine review regressions, and they are
   substantial: a new `unresolved-names.ts` in the compiler, a scanner-based tag
   lookahead in the reader, `braceHeader` and enum-body changes in the expander.
   The rest of the session was reviewed; this part was not.
2. **Cut an alpha.** Nothing but our own suites has exercised any of this.

## Open bugs

- **A chain of slashes the reader misjudges is expanded once per slash.** A
  regular expression holding a bracket, written where the reader judged a
  division -- at the start of a statement after a function declaration, say --
  hides the next such one from the enforester until it is read as one. A source
  of N of them is read and expanded N times: 150 take about four seconds. It
  settles however many there are (`slashReadLimit` counts only reads that settle
  nothing new); only the cost grows. Judging the `}` of a function or class
  declaration as a statement's end in the reader would remove the commonest
  case.
- **The token-level class member walk joins `x = a as T` and a `[k]` under
  it.** `createClassMemberWalk` takes a bracket on the next line as indexing
  the initializer, where TypeScript ends the field at the asserted type. The
  class element reader reads the initializer with the expression reader and
  ends it correctly; only a walk over a class body that reader could not take
  whole asks the token-level question. Answering it needs to know where the
  asserted type ends, which a token walk can only guess.

## Performance

`expansion/project-scale` is +24% and `expansion/threading-end-to-end` +25% per
unit of work against `ab7c214`, the pre-session reference. This is understood,
not mysterious:

- ~+429ms of it is one feature — Racket-style macro shadowing walking every
  region for its binders (`collect`, `bindingsFrom`, `regionBindings`,
  `shadowsMacro`).
- ~+640ms is the printer's seam work from `13ee270`, three days before the
  session, which is what fixed `total =map( [1, 2, 3] ,…)`.
- The rest is more protected nodes being built, which is what the correctness
  work required.

`pnpm benchmark:check` fails on three scenarios and is **not part of `pnpm
check`**, so nothing gates on it. The baseline was deliberately not re-recorded —
re-recording now would bury those two regressions in the reference.

Cheap wins identified and not taken:

- `requireFrozenSyntax` is 2.6% of `project-scale`; `tokenSpans.push(Object
.freeze(...))` is 31% of `pushToken` self time. Both are the design (this
  codebase freezes pervasively), so they are costs to know rather than bugs.

## Test and tooling debt

- **Benchmark baselines:** `benchmarks/baselines/node24.json` is stale (commit
  `fbd8512`, no `loadAverage`, **no `expansion/project-scale` row**, so that
  scenario is unchecked under Node 24); both checked-in baselines were recorded
  with `dirty: true`; and `--baseline auto` silently skips scenarios missing from
  the baseline, so a new scenario is unguarded until someone re-records.

## Features not built

- **Local macro scope.** `processLocalDefinitionContext` exists and
  `docs/specifications/04-expansion-enforestation.md` §11 describes it, but
  nothing calls it; a definition in a block reports honestly rather than being
  emitted. Roadmap Milestone 3.
- **Hoisting from an expression macro.** No way for an expression macro to emit a
  `const` before the statement it sits in, which is what blocks `value |> await %`
  and `yield %` in the pipe macro.

## Decided, not bugs

- **A held sentence on an unchecked path can be spurious.** In an unchecked
  `.sjs` file a macro spelled `JSON` is warned about. Deliberate, and pinned by a
  test: the alternative is silently emitting a name that throws.
- **Definition order stays as documented** — a macro is visible to the items
  after it, unlike Racket, which partially expands a module body first.
- **A member macro is invoked as a bare name, never in method-signature shape** —
  the shapes are ambiguous unless the name is resolved first, which would make an
  interface's meaning depend on what happens to be imported.
- **`import`/`export` are refused at statement level.** The statement reader
  reads what TypeScript _accepts_ in a function body; those are never accepted
  there, and TypeScript reports them itself.

## How this session worked, for whoever picks it up

Every fix followed the same recipe, and it is the reason the bugs kept yielding:
write the test first and confirm it fails, cross-check the expectation against
TypeScript itself rather than against intuition (`ts.createSourceFile` for parse
questions, a real `ts.createProgram` for resolution ones), and prefer one shared
rule over a patch per call site. Two habits paid for themselves repeatedly:

- **Use a control.** When measuring, include a scenario the change cannot affect;
  if the control moves, the method is wrong, not the code. Three measurement
  methods were discarded that way.
- **Ask what a component can know.** The worst regression of the session was the
  expander asserting that a name was undefined — something only TypeScript can
  answer, since the expander never sees `lib.d.ts`.
