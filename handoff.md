# Handoff

Written at `2403709` (36 commits since `22a98a5`, 2644 unit tests); brought up
to date at `a45b9bb`, and again after the review of the integrated branch
(below) and the fixes of what it left open, where `pnpm check` is green end
to end with 3780 unit tests.
Everything below is open except "Reviewed", "Decided, not bugs" and the
closing notes.

This branch carries no editor integration for Zed: it was taken out of the
integrated branch, history included.

The session began by deleting a hand-written `declare module "*.sts"` stub and
turned into a long chain of parser and expander fixes. Five of those were silent
— wrong output with no diagnostic — and one was a runtime miscompile. A review of
the whole diff then found nine regressions the session had itself introduced; all
nine are fixed. A review of those fixes on 2026-10-16 found more, and those are
fixed too (see "Reviewed" below).

Two facts worth keeping in mind while reading the rest:

- A refused item drops the module to a raw token walk, where a macro at statement
  head is silently not expanded. That is why reader gaps matter more than their
  shapes suggest.
- A corpus differential (480 file×macro combinations over this repo's sources)
  put the session's name-position work at ~60 files improved and 0 newly broken,
  and the reader is lossless over 694 real files. The list below is the tail, not
  the trend.

## Before shipping

1. **Cut an alpha.** Nothing but our own suites has exercised any of this.

## Reviewed

The five commits that fixed the nine regressions (`9daa5ec`, `1b66315`,
`b07fb68`, `7c80c50`, `2403709`) were reviewed on 2026-10-16 against the tree
of that day, every finding reproduced before it was fixed:

- **Hygiene.** A macro name a template wrote was handed to TypeScript like one
  the author wrote, so a call-site local of that spelling captured it and the
  file compiled silently. Fixed in `503c11e`, with a member key spelled like a
  macro of another space now reported as spec 04 says.
- **Saying held sentences.** The node, deno and bun hooks said them a tick too
  late to be seen before a top-level throw; Parcel and Jest lost them on a
  cached build; `noCheck`, a `// @TS-NOCHECK` and an unchecked `.sjs` in the
  editor dropped them; TypeScript's "cannot find name" codes with advice
  attached were not answered. Fixed in `7d2e7c6`.
- **Brace headers and enums.** A key or member spelled `class`, `enum` or
  `module` read as a declaration; a parenthesized return type or an optional
  method's `?` hid the parameter list; enum members were split inside type
  arguments and not bound; `{ x }` with a macro became `{ 99 }`. Fixed in
  `503c11e`.
- **The reader's JSX lookahead.** A closing tag in an attribute ended the tag
  early, generic signatures and defaulted type parameters read as elements, a
  `(` in an element's text was quadratic, and attribute strings were scanned
  as JavaScript's. Fixed in `8fc5bb1`, with a bare `<T>` the reader still
  judges corrected by the enforester in `3df047e`.

Those fixes were reviewed in turn, with the two former open bugs' (`6a07306`,
`3c71179`), and what that found is fixed in `d4882cf`, `dd455b8` and `aa1caec`
-- confirmed by running every finding's reproduction again, not yet reviewed
afresh: an element written as an attribute's value without braces, a call
signature under a member with no `;`, JSX text spelled `(`, a `>` comparison
after an asserted type, the reader's statement starts outside statement lists,
and an element a template writes read as a signature.

Those three were reviewed afresh on 2026-10-17, and what that found is fixed in
`2376a4e`; an adversarial review of that commit found a label after a block,
an emoji shifting the formatter's template offsets, and slashes after a module
specifier, a `break`'s label and an element, all fixed in `a45b9bb`:

- **A `<` reading was gated by the slash judgement.** Where the enforester asked
  for an element after a declaration the reader missed, the read never followed
  it, and valid TSX was refused with SWR4028. A `<`'s reading now applies
  wherever it is given, as a slash's does.
- **Statement lists.** A function's or a class's body written as an expression
  was no statement list; a parameter's decorator marked the next class as an
  expression; after `declare function f(): void` the next declaration was
  lost; `export default {` was a block; a name after `as T` was a label.
- **An element after a macro's name** -- `wrap <p>{x}</p>` -- was read as a type
  assertion, and the rule matched the element's tags and text as code, with no
  diagnostic. A `<` written where JSX is read is never an assertion now
  (`ElementReader`); the enforester reports the element.
- **The formatter** laid out the text of an element a template writes as code
  where it read like a signature. It asks TypeScript about templates now.
- **Element chains** misread as signatures were quadratic, as slash chains were.

The reader's judgement was then compared with TypeScript's parser over 7,000
files -- this repository, its dependencies, and other TSX projects -- and
agrees on every slash and every element.

The integrated branch -- PRs 31, 33 and 34 with `fix/expression-result-grouping`
-- was reviewed on 2026-10-17 by area (reader, enforester, expander, hygiene,
printer and formatter, the hosts), each finding reproduced on the branch and on
`main` before it was fixed, and fixed in the 37 commits after `fe47046`:

- **Regressions the integration brought.** The printer dropped the parentheses
  a `>=`, `>>` or `>>>` needed (`e145489`); a reread gave up after nine slashes
  each hiding the next (`9805c35`); an expression operator binding the names
  after it crashed (`e54eea5`); `#core(<declaration>)` with a line beginning
  `(`, `[` or a backquote under it was read as one expression (`2d8f260`); enum
  members keyed by strings, or merged across declarations, went unbound
  (`85bcca5`); the reader misread a slash after import attributes, an export
  list and type arguments (`bb2f7a7`, `d331247`); the Jest transform's cache
  missed the files an expansion read (`ef1321a`); a brace where an operand
  begins was read as a block (`14f6c97`).
- **Crashes.** A run of `<` comparisons scanned to the end of its block and ran
  out of steps (`03da5da`); nested `+` repetitions in a pattern were
  exponential (`d6ecef1`); a command threw, ending a watch, over a file the
  expansion read through a system of its own (`aaf72a9`).
- **Silent miscompiles.** A name a template declared through another macro was
  renamed where declared but not where used (`1357d3f`); a type capture at a
  conditional's `extends` swallowed `? A : B` (`036a55e`); an expansion
  beginning `(`, `[` or a backquote joined the line before it (`7fda2d4`); a
  type macro was expanded in an expression after `,`, `?`, `|` or `=>`
  (`37da348`); `type`, `namespace` and `declare` used as names stopped
  expansion (`278973d`); methods named `if`, `for`, `while` (`ea63d41`); an
  operator's binder spelled like a macro (`2cd2724`); a macro capturing `await`
  in an initializer (`fc76dbe`); an index signature's parameter (`79860d8`); a
  raw run's expression statement (`a6e87e5`); the line break after a `void`
  (`7f4f039`).
- **Diagnostics.** Codes are written `SWR` (`6f4a121`); a slash read both ways
  across reads is reported as SWR4027 rather than settling nowhere
  (`9805c35`); an aliased import, a late `@ts-nocheck` (`a6f6776`); a capture
  before a multi-token operator stopped at its first token (`b782aad`); a
  `<`...`>` candidate read past a `:` (`ef9b886`); `/[/*]/` under a macro was
  never read again (`1da9245`).
- **Operators in ordinary places.** An operator macro in a parameter's or a
  pattern's default, a computed key, a decorator's arguments or an `export
  default` was left unexpanded, as was one spelled over TypeScript's own
  tokens -- `a!!`, `a +++ b`, `id<number> <+> b` -- and a statement operator's
  spelling inside an expression (`a<-1`) was reported as an error (`91221eb`,
  `2f18fcf`, `6c5a202`). These were on `main` as well.
- **The formatter** refused a regular expression holding a bracket in a
  macro's syntax as malformed (`9a73375`), and it and TypeScript's readings
  were quadratic in a file's length (`6edef96`).

## Open bugs

None known. The four listed here after the review, and issue #1, were fixed on
2026-10-17,
and with them what fixing them showed:

- **A template's free name captured by a caller's local** (`5f9d4c3`). A
  name a template writes and does not bind never means a local of the
  function or block its invocation stands in; such a local is renamed. What
  a module declares at its top is left alone: a template writing `add($a)`
  where its own module declares no `add` means the one the module using it
  declares or imports.
- **`x < (y > (z))` and `[x < y, y > (z)]` read as calls** (`36e7fe1`).
  TypeScript reads types on from a `<` and recovers into a call, through
  parentheses and past a comma, so the printed file is parsed where an
  expansion compares or shifts with a `<`, and what follows each `<` it
  misreads is printed `((void 0, …))`. A `<` the author wrote is left alone.
- **Reader gaps in effect and zod** (`37d9406`): an arrow's body ending at a
  comma among type arguments or at a nested arrow's return type, an arrow's
  head taking a function type's `=>` among its return type's arguments, and
  a function type that could not return a generic one. 1,500 sampled
  third-party files now read whole.
- **Issue #1, a template's binder renamed with the global beside it**
  (`019aeee`). A class of binders is renamed only
  where TypeScript scopes them. The template's free `JSON` then means what
  a free template name means: the global, past any local of the caller's,
  or what the using module declares at its top, as `add($a)` does.
  `globalThis.JSON` reaches the global whatever the module declares.
- **A member access after a postfix operator** (`1a38ce9`): one declared at
  a left-hand-side expression's precedence (200) or tighter makes one, and
  what is read off a name is read off it; one that binds as `++` does is
  refused, saying what to write. An operator declared at a name's
  precedence (1000) or above could read no operand and is now refused where
  it is defined.

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

Both baselines in `benchmarks/baselines/` were re-recorded at `d0d36e6`, so
these costs are now **inside the reference**: `pnpm benchmark:check` measures
change from `d0d36e6`, and it will not report them. The old Node 26 baseline
could not have kept them visible anyway — it was taken with every scenario in
one process, which the runner no longer does and whose numbers are not
comparable with per-process ones — and the old Node 24 one had no
`expansion/project-scale` row at all. The figures above are the record of what
the session cost; to measure them again, run the suite at `ab7c214` and at the
commit in question under the same protocol. `pnpm benchmark:check` is **not part
of `pnpm check`**, so nothing gates on it.

A slash or a `<` the reader judges the other way from the grammar costs a read
of its file, and where each such regular expression holds a bracket it hides the
next from the enforester, so a chain of them costs a read apiece. The reader now
follows a statement that ends with a type (`let a: string`, `type T = {}`, an
overload's return type) and a function's body written as an expression, which
were the chains measured quadratic: 80 of `type T = {}` and a regular
expression under it took 386ms and now take 12ms, and 320 elements spelled like
signatures took 6.7s and now take 15ms. What is left for the enforester is what
only the grammar can tell -- an initializer that goes on across a line, before a
typed declarator -- and costs a read where it is written; `readLimit` counts only
reads that settle nothing new.

Cheap wins identified and not taken:

- `requireFrozenSyntax` is 2.6% of `project-scale`; `tokenSpans.push(Object
.freeze(...))` is 31% of `pushToken` self time. Both are the design (this
  codebase freezes pervasively), so they are costs to know rather than bugs.

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
- **`let` and `yield` as names are judged as the keywords.** `let / 2` and, outside
  a generator, `yield / 2` divide only in sloppy-mode script, never in a module
  or under `"use strict"`; the reader reads a regular expression there, and the
  enforester's correction reads the file again where one is written.

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
