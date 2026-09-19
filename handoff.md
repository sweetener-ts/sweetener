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

### 1. A warning fails the build (highest priority)

`packages/compiler/src/project-command.ts:503` returns `exitCode: 1` on any
diagnostic, and `packages/compiler/src/session.ts:243` throws on any, neither
looking at `category`. `packages/cli/src/project-runner.ts:114` _does_ filter on
`Error`, so the two project paths disagree. `SWR4021` has failed builds this way
since before the session; `SWR4025` and the held-name warnings now inherit it.

It fires on ordinary TypeScript. Measured against real packages, 12 of 620
`node_modules` files fail `sweetener check` that passed at `8e06a24`. Three
shapes, each still reproducible at `2403709` (each prints
`warning TS4025 … reader expected …` and then `check: failed`; the missing
semicolons and the line breaks are the point, so this block is not formatted):

```text
declare const module: any;
module.exports = 1            // "declaration body"; also `namespace = 1`, `module(1)`

export const g:
  | number
  | undefined = 1 as any;     // "variable type" — prettier's default union layout

export function f(a: number): number      // "declaration body"
export function f(a: any): any { return a; }
```

Fix the gating, then the three reader gaps behind it:

- `module`/`namespace` as ordinary names: `declarationHead`
  (`packages/enforestation/src/statement-item.ts:250`) accepts a contextual head
  word on the sole test `noLineTerminatorAfter`. `global` has a dedicated
  next-token guard (`globalAugmentation`, `:287`); these two need the same one.
- leading `|`/`&` in an annotation: `continuationOperators`
  (`packages/enforestation/src/type-class-element.ts:392`) breaks out when
  `expectingOperand`, yielding an empty read. `c51ddb3` routes every declarator
  annotation through this consumer, which is what made it reachable. Allow a
  leading `|`/`&` when `children.length === 0`.
- bodiless signatures: `endsAtBlock` (`statement-item.ts:2005`) means "must end
  at a brace", and an ambient or overload declaration has neither brace nor `;`.
  The `moduleItem` ASI rule at `:2046` is the right one and is skipped whenever
  `endsAtBlock`. Same root cause as `declare function f(): void` swallowing the
  statement after it.

### 2. Reader gaps that refuse valid TypeScript

- `y?.<A>(b)` — an optional call with explicit type arguments. Refused at both
  levels. It is currently the fixture for the `SWR4025` test in
  `packages/expansion/test/frontend-session.test.ts:179`, so closing it needs a
  new genuinely-unreadable sample.
- `let a: asserts` — `asserts` is unconditionally in `typeOperandHeads`
  (`type-class-element.ts:492`), so a line can never end after it.
- Arbitrary lookahead bounds refuse valid programs:
  `packages/enforestation/src/primary-expression.ts:160`, `:172`, `:190`
  (32/33 nodes) and `:417` (`offset + 64`). A 33-member union in an arrow's
  return type, a 16-member union in a function expression's, or a 17-segment
  `extends a.b.c…` are all refused.

### 3. Diagnostics

- **`SWR4024` over-claims.** "nothing defines X in the emitted code" is a claim
  about the program. On the unchecked paths it is now said without a checker
  behind it — the same over-reach the held-name redesign removed elsewhere.
- **`remapGeneratedDiagnostics` collapses an expansion onto the invocation's
  start.** Two sentences about different names in one macro's output are both
  reported now (that was fixed), but at the same position and span.
- **`resolvesNamesIn` ignores `// @ts-check` / `// @ts-nocheck`** —
  `checkJsDirective` is not in the public TypeScript 6.0 typings. A JS file with
  `checkJs` off and `@ts-check` gets a warning TypeScript already answered.
- **A held sentence on an unchecked path can be spurious.** In an unchecked
  `.sjs` file a macro spelled `JSON` is warned about. Deliberate, and pinned by a
  test: the alternative is silently emitting a name that throws.
- **`SWR4017` is never raised in a type position.**
  `export type Held = nowhere;` above `export syntax nowhere:type {…}` reports
  only TypeScript's `TS2304`.
- **The editor never shows any of this.**
  `packages/typescript-host/src/mapped-language-service.ts:151` reports only
  TypeScript's diagnostics, so an editor shows `Cannot find name` where the CLI
  explains the macro. The explanation now exists in the form that path needs.

### 4. Expander and printer

- **A decimal integer spliced before `.` prints an invalid literal.** A macro
  `=> { $v.toFixed(2) }` applied to `1` prints `1.toFixed(2)`. Verified the only
  such pair in the whole seam table (164×164×4 contexts).
- **`normalizeProtectedInput` is applied to `enforestExpression` and
  `prepareInput`, but not to `enforestStatements`, `enforestClassElements` or
  `enforestTypeMembers`** (`packages/expansion/src/frontend-session.ts:1440`).
  That asymmetry produced the object-literal arrow bug fixed in `2403709`; no
  repro through the other three yet.
- **`arrowWidth` defers a block-bodied arrow to the infix `=>`**
  (`primary-expression.ts:215`), which makes a correct reading depend on a later
  normalization pass rather than on the reading itself.
- **`typeArgumentsEnclose` shares TypeScript's real ambiguity in one shape:**
  `f(a < b, { x: 1 }, c > d)` reads the brace as an object type. TypeScript
  resolves it by parsing the candidate list and looking at what follows; the walk
  has only loose tokens.
- **`beginsStatement` does not ask what `beginsItem` asks**
  (`statement-item.ts:593` vs `:608`): `statementStarts` holds `async` with no
  guard, so `class C extends\nasync.Base {}` is refused on the statement path and
  read correctly on the item path.
- **`decoratorWidth` is the last hand-written angle counter**
  (`type-class-element.ts:565`). The reader does emit `<<` as one token and
  `angleWidth` returns 2 for it, so a `<<` reaching that loop never balances.
  `angles()` is already defined at `:853` in the same file.
- **`leadingLineBreak` descends into a `group` but not a `protected` node**
  (`packages/syntax/src/syntax.ts:263`), driving ~18 ASI decisions. Pre-existing.
- **`reportUnreadItems`** (`frontend-session.ts:1078`) checks a `reportedAlready`
  snapshot taken before its loop and never re-checks what it pushes inside it, so
  nested recoveries would report twice. No input found that produces them.

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

- `closureEndAt` (`recursive-expander.ts:2251`) allocates two closures and a run
  object per call, and `suspends()` calls it once per index: +48.7ms per 300
  threading runs. Hoisting the helpers is mechanical.
- The `elsewhere` scan calls `sourceOf(node)` seven times where once would do,
  and re-derives `lookupModule`/`moduleWrittenIn` per candidate.
- `resolveCompiledMacro` (`compile-macros.ts`) has the same linear `macros.find`
  shape that `a34e6f6` indexed, plus a `flatMap` allocating per visible binding.
- `requireFrozenSyntax` is 2.6% of `project-scale`; `tokenSpans.push(Object
.freeze(...))` is 31% of `pushToken` self time. Both are the design (this
  codebase freezes pervasively), so they are costs to know rather than bugs.

**No benchmark covers the shape the shared rules are quadratic in.** Every
expansion scenario is small files of already-parsed statements, so the longest
run these rules see is ~10 nodes. The quadratic needs one long _unenforested_ run
— a macro whose replacement is a few thousand tokens. Nothing would catch a
copying rule coming back.

## Test and tooling debt

- **`eslint.config.mjs` does not ignore `.worktrees/`.** With a worktree present,
  `pnpm lint` fails with ~1,882 "multiple candidate TSConfigRootDirs" errors.
  Prettier already ignores it.
- **The enforestation test harness is weaker than production.** `parse()` in
  `packages/enforestation/test/statement-item.test.ts:29` and `setup()` in
  `binding-parameter.test.ts` build consumers without `consumeType`, so
  `const x = a as string[];` looks refused there while the real pipeline reads it
  fine. This produced a false positive during the session.
- **`scripts/run-tests.mjs` can report a stale green.** If vitest dies before
  writing `artifacts/test-results/vitest.raw`, the script parses the _previous_
  run's raw file and writes a green-looking `unit.json` stamped with the current
  commit. The process still exits non-zero, so `pnpm test` fails — but
  `STATUS.md` records a pass.
- **The reader's cost-per-character test was weakened** (`580bfd0`): the bound is
  still 3, but it retries up to 24 rounds and exits on the first pass, so a
  reader genuinely over the bound 80% of the time now passes.
- **Benchmark baselines:** `benchmarks/baselines/node24.json` is stale (commit
  `fbd8512`, no `loadAverage`, **no `expansion/project-scale` row**, so that
  scenario is unchecked under Node 24); both checked-in baselines were recorded
  with `dirty: true`; and `--baseline auto` silently skips scenarios missing from
  the baseline, so a new scenario is unguarded until someone re-records.
- **`STATUS.md` no longer marks a check report stale** (`a943ead` removed the
  marker so the file could stop naming the commit it was generated at). The
  report's own commit is still recorded.

## Features not built

- **Local macro scope.** `processLocalDefinitionContext` exists and
  `docs/specifications/04-expansion-enforestation.md` §11 describes it, but
  nothing calls it; a definition in a block reports honestly rather than being
  emitted. Roadmap Milestone 3.
- **Hoisting from an expression macro.** No way for an expression macro to emit a
  `const` before the statement it sits in, which is what blocks `value |> await %`
  and `yield %` in the pipe macro.

## Decided, not bugs

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
