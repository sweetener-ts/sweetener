# Work Log

## 2026-08-03

### TSH-001: macro module resolution complete

Added a closed, versioned declarative macro manifest and a pure deterministic
resolver. Relative imports, wildcard aliases, and package export maps resolve
without host execution. Imported names are validated against typed export
metadata, compiler/language compatibility is checked before traversal, and
compile-time and runtime dependency graphs remain separate. Stable shared
diagnostics cover invalid manifests, missing or ambiguous modules, absent
exports, version mismatch, and macro-only cycles.

Validation: 578 tests pass across 84 files with formatting, lint, TypeScript,
package/declarative boundaries, and acceptance contracts green. The queue
advances to expanded TypeScript printing.

### TSH-002 checkpoint: deterministic generated files

Added the first expanded-file printer. It applies hygienic name assignments,
retains deterministic generated ranges linked to syntax origins, supports
grouping protected expression roots, and serializes expansion traces with
recursive canonical key ordering. Focused host tests cover stable text, maps,
and traces.

Validation: 582 tests pass across 85 files; all substantive gates are green.
TSH-002 continues with token-granular maps and precedence-driven grouping.

### TSH-002: expanded TypeScript printing complete

Replaced coarse top-level maps with token- and delimiter-level generated
segments. Protected expression nodes now use their recorded precedence and a
surrounding boundary requirement to add parentheses only when necessary.
Hygienic rewrites, trivia, canonical trace serialization, and repeated output
remain deterministic.

Validation: 585 tests pass across 86 files with the complete repository gate
green apart from the expected pre-regeneration status snapshot. The queue
advances to `TSH-003`.

### TSH-003: official CompilerHost integration complete

Added a canonical virtual-file overlay over TypeScript's standard
`CompilerHost`. Expanded files now enter the normal parser, binder, checker,
and emitter. Tests prove strict semantic checking and captured JavaScript,
declaration, source-map, declaration-map, and incremental build-info output.
Generated metadata remains addressable by canonical file identity. The overlay
models virtual directory existence so TypeScript resolves imports between
generated files, consumes the one canonical printer artifact, and supports
captured as well as write-through emission.

Validation: 590 tests pass across 87 files; every substantive repository gate
is green. The queue advances to diagnostic remapping.

### TSH-004: TypeScript diagnostic remapping complete

Added generated-span intersection over printer origin regions. Remapped
diagnostics preserve TypeScript identity and generated positions, select
invocation-oriented source primaries, attach other composed/template sources,
and accept immutable macro expansion frames. Copied and synthesized regions
resolve through their origin ancestry; locationless diagnostics remain intact.

Validation: 590 tests pass across 87 files with all substantive gates green.
The queue advances to source and declaration map composition.

### TSH-005: source and declaration map composition complete

Added a deterministic VLQ decoder/encoder and composition pass joining emitted
TypeScript mappings through printed-file origin regions. Source tables derive
from stable source IDs, repeated captures retain their original location, and
trivia or generated gaps remain deliberately unmapped. Malformed input maps
fail before output publication; the same composer handles JS and declaration
maps.

Validation: 594 tests pass across 88 files with all substantive gates green.
The queue advances to caches and dependency invalidation.

### TSH-006: content-addressed caches and invalidation complete

Added stage-specific content keys incorporating source/configuration/compiler
identity and normalized direct/transitive macro closures. The cache publishes
only complete uncancelled values, maintains reverse dependency indexes, and
reports deterministic operational statistics for later watch/debug surfaces.

Validation: 598 tests pass across 89 files with all substantive gates green.
The queue advances to build, check, and watch CLI commands.

### TSH-007: build, check, and watch commands complete

Added closed sweet configuration parsing, `.sts`/`.stsx` discovery, configured
check/build execution, command-line dispatch, project-reference ordering, and
incremental watch invalidation across source and macro dependencies. Broken
programs do not emit; successful builds capture JS/declarations; cache/debug
state and rebuild events are inspectable.

Validation: 610 tests pass across 93 files with all substantive gates green.
The queue advances to clean-versus-incremental equivalence.

### TSH-008: clean and incremental equivalence complete

Added a reusable snapshot protocol carrying old TypeScript programs across a
multi-project edit sequence and comparing each incremental result with a clean
build. The comparison includes expanded sources, origin maps, traces,
diagnostics, JS, declarations, map artifacts, and evaluated runtime exports.
Exact invalidation assertions cover call-site, macro, unused-export,
runtime-only, whitespace, configuration, and compiler-version changes.

Validation: 611 tests pass across 94 files with all substantive gates green.
Phase 6 is complete and the queue advances to Phase 7 origin-query APIs.

### TLS-001: origin-query APIs complete

Added an immutable origin index with bidirectional generated/original queries.
It returns repeated generated occurrences, primary and composed sources,
copied/introduced/grouping classification, and macro expansion stacks. Boundary
semantics are half-open; gaps return no result; invalid maps fail at index
construction.

Validation: 613 tests pass across 95 files with all substantive gates green.
The queue advances to `expand` and `explain` tooling.

### TLS-002: expand and explain tooling complete

Added executable expansion inspection commands. `expand` returns exact virtual
TypeScript; `explain` maps one-based source locations through the origin index
and reports nested invocation order, rules, captures, bindings, hygiene
operations, generated names, cache state, and core interceptions. Windows-style
paths and CRLF offsets are covered.

Validation: 618 tests pass across 96 files with all substantive gates green.
The queue advances to the virtual-file language-service host.

### TLS-003: virtual-file language-service host complete

Added an official TypeScript language-service host over mutable expanded
snapshots. Virtual imports resolve, script/project versions are monotonic for
text and metadata edits, identical updates remain stable, and printed origin
metadata stays associated with each snapshot for mapped tooling reads.

Validation: 620 tests pass across 97 files with all substantive gates green.
The queue advances to diagnostics, hover, and definition mapping.

### CMP-005 checkpoint: core-rewrites family executable

Completed both core-shadowed forms in the core-rewrites family. Declarative
literal declarations lower to binding-identity matcher keys, so only the global
`NaN` binding selects the specialized `typeof` rule and local shadows take the
protected core fallback. Exported functions gain declaratively counted arity
checks, recursive/function-parameter binding contracts, exact malformed-body
diagnostics, and capture-proof `globalThis.Number`/`globalThis.Error`
references. Extra runtime arguments are rejected.

All six fixture evidence dimensions are enabled. Validation: 528 tests pass
across 76 files with formatting, lint, TypeScript, package boundaries, and
acceptance contracts green. The queue advances to ADT/match.

### CMP-005 checkpoint: binding-literal compiler support

Started the core-rewrites family by lowering declarative literal declarations
into binding-identity matcher keys. Compiled modules now expose immutable alias,
reference-path, origin, and binding metadata; the `NaN` rule therefore no
longer depends on textual spelling. Corrected the arity fixture to use the
finite `#count(...)` template operation. The whole-workspace corpus tests now
declare explicit 30-second Vitest budgets using the supported options form,
eliminating the old ignored positional timeout under parallel load.

Validation: 523 tests pass across 75 files with every substantive repository
gate green. The core-rewrites execution, hygiene, diagnostics, and runtime
evidence remain in progress.

### CMP-005 checkpoint: rewritten-if family executable

Ported rewritten `if` through statement-category macro expansion. The tests
prove exact complete-block lowering, an empty binding-introduction trace,
definition-scoped `IF` resolution despite a same-spelled call-site value, the
exact missing-else-return diagnostic, valid TypeScript, and runtime result `3`.
All six fixture evidence dimensions and their machine-readable contracts are
enabled.

Validation: 518 tests pass across 74 files with formatting, lint, TypeScript,
package boundaries, and acceptance contracts green. The next compiler slice is
modifier-aware item dispatch for currying's `export function` declaration.

## 2026-08-02

### CMP-005 checkpoint: implicit-return family executable

Ported implicit-return through one declarative `FunctionBody` syntax class and
the public compiler/recursive expander. Added protected `#core(...)` emission
so a core-shadowing macro can lower back to TypeScript without self-reentry,
allowed protected expressions to re-enter Pratt composition, and added
trivia-safe `#trim(...)` splicing so captured line breaks cannot trigger
`return` ASI. Typed parameters receive lexical binding contracts across the
whole body.

Exact expansion, binding and trace artifacts, malformed diagnostics, strict
TypeScript evidence, and runtime result `7` are enabled. Validation: 513 tests
pass across 73 files with all substantive repository gates green. The next
family is `currying`.

### CMP-005 checkpoint: threading family executable

Ported the threading acceptance family through the public compiler and
recursive expander. The accepted trailing comma exposed a missing surface rule;
the fixture now handles it with an explicit declarative final-step pattern.
Exact expansion, recursive parent/child traces, zero introduced bindings,
call-site capture preservation, the malformed diagnostic golden, strict
TypeScript inference, and runtime output all pass. The fixture manifest now
enables expansion, binding, trace, diagnostic, type, and runtime evidence with
machine-readable artifacts.

Validation: 503 tests pass across 72 files with formatting, lint, TypeScript
build, package boundaries, and acceptance contracts green. The next family is
`implicit-return`.

### CMP-004: declarative mixfix composition complete

Added public-path composition tests for newline-spanning fixed segments,
nested TypeScript calls in argument positions, competing literal segment
alternatives, and farthest-boundary ranked failures. Every case compiles and
invokes an ordinary declarative macro; no separate mixfix registry, callback,
or runtime mechanism was introduced.

Focused validation: 3 tests pass. The queue advances to `CMP-005`, which ports
the full accepted playground suite and enables its expansion, hygiene,
diagnostic, type, and runtime evidence.

### CMP-003: declarative custom operators complete

The production macro compiler now validates and lowers operator fixity,
associativity, and numeric precedence into table entries tied to compiled macro
bindings. Generated operator definitions retain that metadata during checked
re-entry. A lexical resolver bridges persistent expansion environments to Pratt
dispatch, matches punctuation spanning one or more reader tokens, respects
nearest-scope visibility, and requires authorization before replacing a core
operator. Selected operators execute their ordinary compiled matcher and
template; immutable grouping traces expose binding powers and operand origins.
Structured import/local conflicts preserve the prior environment and point to
the existing declaration.

Validation: the playground operator declaration compiles to the expected three
entries; `|>` groups and expands before lower-precedence `==`; invisible
operators do not dispatch; malformed and nonassociative forms retain ranked
diagnostics; emitted code passes TypeScript inference and runtime execution;
496 tests pass across 70 files with all substantive repository gates green.
The queue advances to `CMP-004` mixfix composition.

### CMP-002: checked generated definitions complete

Added an explicit `#syntax { ... }` handoff that re-enters the ordinary parser,
macro compiler, validation path, and source-ordered definition context.
Generated-definition traces retain marker, body, definition, binding, and
environment provenance. A template-instantiation test splices a captured name
into a generated macro and registers the resulting checked binding.

Validation:

- malformed and unmarked output leaves the input environment unchanged;
- rejected definitions do not leak while accepted neighbors remain ordered;
- generated captured names compile and register through public APIs;
- 485 tests pass across 69 files with substantive repository gates green;
- the queue advances to `CMP-003` custom operators.

### CMP-001: recursive and local syntax bindings complete

Added an explicit local-definition-context lifetime contract and lexical
compiled-macro resolver. Recursive definitions allocate before validation;
local definitions live in a child expansion frame and return the exact parent
snapshot at scope exit. Guarded syntax-class recursion now has an executable
multi-step test in addition to definition-time left-recursion rejection.

Validation:

- recursive self-visibility and nonrecursive ordering pass;
- local shadowing remains visible inside the region and cannot escape;
- compiled resolution follows the nearest lexical frame;
- guarded parser recursion consumes `next next end` without cycling;
- 478 tests pass across 68 files with all repository gates green;
- the queue advances to `CMP-002` generated macro definitions.

### EXP-006: declarative do-notation vertical slice complete

Added one production macro compiler and recursive expansion driver, then used
them to compile and execute public `Bind`, `BindAll`, and `doSteps`
definitions. Binding extraction preserves every destructured identifier;
recursive environments, parent-first traces, and hygienic printer plans retain
lexical identity across generated syntax.

Validation:

- `Bind` and correlated `BindAll` support optional semicolons;
- sequential, destructuring, final-expression, and malformed cases pass;
- generated TypeScript parses and infers `Box<number>` under TypeScript 6;
- runtime execution produces `{ value: 5 }`;
- all six do-notation acceptance dimensions are enabled;
- 478 tests pass across 68 files with all repository gates green;
- the queue advances to `CMP-001` recursive and local syntax bindings.

### ENF-007: statement-prefix/final-expression composition complete

Added a transactional composite consumer for zero or more complete statements
followed by either an implicit final expression or an explicit final return. It
preserves lossless source and exposes both prefix and completion fields.

Validation:

- implicit-return acceptance, zero-prefix, and explicit-return bodies pass;
- nested early returns remain ordinary prefix statements;
- ASI separates statements while operator continuation remains one expression;
- bodies without a final value fail without moving the caller cursor;
- cancellation cannot publish a partial composition;
- 453 tests pass across 63 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `EXP-005` core shadowing.

### ENF-006: type and class-element consumers complete

Added protected type and class-element consumers with macro hooks. Type extents
cover operators, conditionals, nested generics, functions, queries, tuples,
mapped types, and indexed access. Class elements cover fields, methods,
accessors, constructors, static blocks, decorators, signatures, and ASI.

Validation:

- 28 focused grammar cases reconstruct exact TypeScript-valid extents;
- malformed adjacent atoms, generics, conditionals, and decorators roll back;
- nested generic closers and caller-owned separators stop deterministically;
- OPEN-EXP-001 found full-file parsing 1.27–2.03× faster than wrappers;
- the validation strategy and retained heap are recorded under `docs/benchmarks`;
- 439 tests pass across 62 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-007` statement/final-expression composition.

### ENF-005: binding and parameter consumers complete

Added immutable binding skeletons that retain every introduced name's spelling,
origin, scopes, and deterministic path through nested destructuring. Parameter
lists layer modifiers, rest, optionality, annotations, defaults, and typed
`this` over the same skeleton representation.

Validation:

- identifier, object, array, computed-key, hole, default, and rest cases pass;
- property keys never become declarations unless used as shorthand bindings;
- malformed rest/default/optional combinations roll back cleanly;
- skeleton names register directly in persistent hygiene environments;
- representative bindings and parameters parse under TypeScript 6.0.2;
- 411 tests pass across 61 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-006` types and class elements.

### ENF-004: statement and item consumers complete

Added protected statement and item consumers over the reader's delimiter trees.
They recognize expression and empty statements, blocks, control flow,
declarations, module items, explicit terminators, ASI, and restricted line-break
productions. Category macro resolvers run before built-in forms.

The expansion-side item driver consumes one item at a time with the current
environment epoch, classifies it as runtime syntax or a compile-time definition,
commits that step, and only then consumes the next item.

Validation:

- 25 focused grammar cases include TypeScript differential checks;
- malformed heads and terminators roll the external cursor back;
- item macro and statement macro categories remain distinct;
- sequential definition visibility changes the following consumer epoch;
- failed later items retain an inspectable committed prefix;
- 397 tests pass across 60 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-005` bindings and parameters.

### EXP-004: expansion progress and resource enforcement complete

Added allocation-independent invocation fingerprints and a dynamic expansion
guard. It rejects a fingerprint repeated before its prior invocation completes,
allows structurally changing recursion, and relies on cumulative resource limits
to bound growing rewrites. Cache publication now happens only after a producer
returns a complete value.

Validation:

- direct recursive macro re-entry fails at the invocation boundary;
- structurally changed recursion proceeds until the global step limit;
- depth, cancellation, cycle, and output-growth failures balance nesting;
- matcher, template, expansion, and output work share one tracker;
- failed or cancelled cache producers publish no partial entry;
- 370 tests pass across 58 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-004` statement and item consumers.

### EXP-003: transactional macro invocation complete

Added a single invocation transaction that orders ordinary and fallback rules,
matches against isolated cursors, validates surrounding grammar boundaries,
applies binding contracts, evaluates and instantiates hygienic templates, then
recursively expands the replacement in the requested syntax category.

Validation:

- failed and boundary-rejected rules do not mutate caller cursors or scopes;
- fallback ordering and ranked no-match diagnostics are deterministic;
- binding contracts, `#fresh`, and `#capture` run through the full pipeline;
- traces retain attempts, captures, scopes, operations, and output origins;
- shared matcher resource accounting does not reset between attempts;
- 363 tests pass across 57 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `EXP-004` termination and resource enforcement.

### ENF-003: Pratt expression parsing complete

Added immutable core operator metadata and a bounded Pratt engine over protected
primary expressions. It handles prefix, postfix, infix, conditional, assignment,
arrow, and optional comma contexts, and exposes a multi-token macro-operator hook
that can expand declarative punctuation operators without importing expansion
state.

Validation:

- precedence, left/right associativity, conditional branches, and updates pass;
- malformed operands and TypeScript parenthesis restrictions fail structurally;
- `??` mixing, exponentiation, and postfix line breaks match TypeScript rules;
- pinned TypeScript accepts representative reconstructed expressions;
- the structural corpus now uses the production expression consumer;
- 358 tests pass across 56 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `EXP-003` macro invocation.

### ENF-002: primary and call expressions complete

Added an iterative expression consumer for literal/grouped primaries and postfix
chains. It preserves reader syntax exactly, constructs one protected expression
with composed origins, respects caller stop sets, and rejects malformed member,
index, optional-chain, and tagged-template combinations.

Validation:

- identifiers, literals, arrays, objects, parentheses, and templates pass;
- members, private names, calls, indexes, non-null assertions, and optional
  chains compose losslessly;
- malformed postfix cases return ranked failures with cursor rollback;
- representative extents parse under pinned TypeScript 6.0.2;
- 320 tests pass across 55 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-003` Pratt expression parsing.

### ENF-001: syntax-consumer infrastructure complete

Added persistent category registration, declarative stop sets, immutable consume
contexts, exact consumed ranges, and deterministic consumer failures. Dispatch
forks cursors so failed or exceptional attempts cannot corrupt caller state and
validates that successful cursors advance in the original sequence.

Validation:

- rollback, forward progress, foreign cursors, and protected categories pass;
- token/end stops short-circuit without invoking consumers;
- cancellation, deadline, and expansion-step limits run at dispatch;
- farthest and most-specific failures merge with stable expectations;
- 283 tests pass across 54 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-002` primary and call expressions.

### EXP-002: definition contexts complete

Added a source-ordered processor for prepared macro definitions and runtime
items. Recursive definitions validate in a tentative self-visible environment;
ordinary and generated definitions register only after successful validation.
Syntax bindings and operator entries commit atomically, while failed definitions
retain diagnostics without leaking visibility.

Validation:

- recursive, ordinary, generated, failed, runtime, and operator transitions pass;
- compile-time syntax is removed and runtime syntax remains source ordered;
- runtime/type binding skeleton identities are retained for hygiene registration;
- immutable transition records expose environments before and after every item;
- 276 tests pass across 53 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `ENF-001` syntax-consumer infrastructure.

### EXP-001: expansion environments complete

Added persistent expansion snapshots keyed by spelling, phase, and syntax
category. Every extension allocates a new epoch for matcher memoization while
lexical children also allocate definition-context identities. Operator families
support prefix, infix, and postfix entries with exact-fixity lexical shadowing.

Validation:

- old snapshots remain unchanged after binding and operator extensions;
- all expansion categories have dedicated hygiene syntax spaces;
- phase, category, ownership, precedence, and duplicate checks pass;
- local operator fixities shadow only matching parent fixities;
- 272 tests pass across 52 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `EXP-002` definition contexts.

### TPL-005: hygiene conformance fixtures complete

Added a schema-valid Phase 3 conformance fixture and an integration harness that
connects template operations, binding contracts, persistent environments,
resolution diagnostics, phase and space separation, and printed-name planning.
The suite enumerates every required semantic scenario so fixture drift fails
explicitly.

Validation:

- all eight specification examples execute with identity or scope assertions;
- `do`, match arms, constructors, protocol parameters, and generated macro names
  have dedicated checks;
- explicit capture produces a trace record before instantiation;
- alpha-renaming and identity-allocation changes preserve assigned-name shape;
- 264 tests pass across 51 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- Phase 3 exits and the queue advances to `EXP-001` expansion environments.

### HYG-006: deterministic name assignment complete

Added a pure printer-side naming plan keyed by binding identity. Expanded-file
occurrence order chooses collision winners, an explicit visibility graph limits
renaming to bindings that can collide, and generated hints are converted to
legal identifiers without relying on process-global counters. Planned rewrites
expand shorthand properties while an iterative printer retains syntax trivia
and structure.

Validation:

- allocation-ID order cannot affect assigned names;
- harmless same-spelled bindings remain unchanged;
- reserved hints, unavailable names, repeated plans, and invalid metadata pass;
- shorthand value renaming retains the property key;
- 259 tests pass across 50 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `TPL-005` hygiene conformance fixtures.

### HYG-005: declarative binding contracts complete

Added immutable binding-contract IR, definition-time compilation against capture
shapes, and runtime scope application over capture records. Composite syntax
classes expose their declared binding fields without procedural callbacks.
Lexical, recursive, sequential, and following regions thread persistent
environments and immutable captures in declaration order.

Validation:

- the `do` acceptance fixture compiles typed binder and region paths;
- malformed syntax, invalid paths, misaligned repetitions, and invalid spaces
  produce owned hygiene diagnostics;
- tests cover field binders, composite binders, recursive following visibility,
  sequential scope growth, and multiple contracts;
- 253 tests pass across 49 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `HYG-006` deterministic name assignment.

### TPL-004: hygienic template instantiation complete

Added the materialization boundary from evaluated templates to immutable syntax.
It allocates syntax IDs, binding identities, origin edges, delimiter tokens, and
scope transforms in one stage. Literal syntax gains introduction scope; copied
captures gain use-site scope; explicit operations apply their documented scope
policy.

Validation:

- tests assert scope membership and origin graph kinds before printing;
- fresh identifiers, stable text, and repetition indices receive correct token
  kinds and origins;
- missing delimiter prototypes produce balanced groups;
- template and JSX delimiter prototypes remain available through evaluation;
- output limits and cancellation expose no partial syntax result;
- 246 tests pass across 48 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `HYG-005` binding contracts.

### TPL-003: declarative hygiene operations complete

Added a finite operation IR and source forms for `fresh`, `callsite`,
`definition`, `capture`, `text`, and repetition indices. Evaluation leaves scope
materialization to one instantiation stage while retaining the selected syntax,
operation intent, safe detail, origin, and repetition coordinates. Bounded folds
use only the fixed accumulator, element, and index locals.

Validation:

- operation argument classes are checked at definition time;
- stable text reconstructs captured tokens and groups without exposing IDs;
- every operation produces an immutable source-ordered trace record;
- folds cover empty initialization, sequential accumulation, elements, and
  zero-based indices under the template-step budget;
- 241 tests pass across 47 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `TPL-004` hygienic instantiation.

### TPL-002: repetition and conditionals complete

Added bounded template evaluation over capture records. Repetitions select
aligned dimensions, compare every driving length, preserve source driver order,
and emit separators only between iterations. Fixed declarative conditionals
branch on optional presence or matcher-provided alternative tags.

Validation:

- flat, separated, nested, optional, and alternative-tag cases pass;
- runtime length disagreement produces a structured cardinality error;
- cancellation and the dedicated template-step budget stop evaluation;
- the resource model now accounts for template steps explicitly;
- 235 tests pass across 47 files;
- formatting, lint, and typecheck pass;
- the queue advances to `TPL-003` declarative hygiene operations.

### TPL-001: template parsing and validation complete

Added immutable template nodes for literal syntax, captures, field paths, groups,
sequences, and repetitions. Definition-time compilation resolves rule captures
and public syntax-class fields to stable IDs, projects field shapes through
outer repetitions, and rejects invalid depth or cardinality use before matching.

Validation:

- literal, group, capture, nested field, separated repetition, and nested
  repetition cases pass;
- unknown captures and fields, shallow references, missing drivers,
  incompatible drivers, and malformed repetition produce `SWR2011` through
  `SWR2016`;
- parsed macro rules compile against inferred pattern shapes and syntax-class
  registries;
- 228 tests pass across 46 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the queue advances to `TPL-002` repetition and conditionals.

### HYG-004: binding resolution complete

Added scope-subset binding resolution over persistent environments. The resolver
removes strict subsets, preserves equal or incomparable maximal candidates as
ambiguities, and orders those candidates by structural data rather than binding
allocation order. `SWR3001` reports every competing declaration as a related
origin.

Validation:

- resolved, unbound, more-specific, equal-set, and incomparable-set cases pass;
- phase, syntax-space, and lexical visibility filters remain effective;
- 100 fixed-seed insertion shuffles produce identical semantic results;
- 221 tests pass across 45 files;
- formatting, lint, and typecheck pass;
- the queue advances to `TPL-001` template parsing and validation.

### HYG-003: invocation scope rule resolved

Added the introduction-flip model with per-invocation use-site scopes. Copied
input retains the use-site scope; introduced syntax gains the introduction
scope and keeps definition scopes.

Executable cases cover call-site captures, definition-site references, local
macro declarations, generated declarations, and nested invocations. ADR-0006
records the accepted rule, and the hygiene specification now states it as a
normative seven-step transform.

Validation:

- 214 tests pass across 44 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- implement binding resolution in `HYG-004`.

### HYG-002: bindings and persistent environments complete

Added immutable bindings with phases, TypeScript and macro syntax spaces,
declaration groups, binding kinds, and temporal visibility. Environment updates
produce persistent snapshots with unique epochs and lexical parent links.

Candidate lookup filters by spelling, phase, space, source position, and frame.
Each store rejects environments created by another compilation session.

Validation:

- tests cover persistence, child snapshots, visibility ranges, phases, spaces,
  declaration groups, lexical ordering, and invalid inputs;
- 209 tests pass across 43 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- resolve introduction and use-site scope behavior in `HYG-003`.

### HYG-001: scope store complete

Added fresh scope allocation, canonical empty and singleton sets, sorted set
interning, and persistent add, remove, and union operations. Debug APIs expose
frozen numeric-order records while ordinary callers use opaque set IDs.

Property tests compare generated mutations and subset checks against JavaScript
sets. Algebra tests cover identity, idempotence, commutativity, and
associativity.

Validation:

- 203 tests pass across 42 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass;
- the M2 Max baseline records 12.27 million fresh scopes/s, 3.22 million
  singleton operations/s, and 8,338 persistent chain adds/s.

Next:

- implement persistent binding environments in `HYG-002`.

### PAT-008: structural ports and Phase 2 exit complete

Added executable fixtures for `Bind`, `BindAll`, protocol methods, ADT
constructors, and mixfix method segments. Tests pass each fixture through the
reader, parser, class compiler, and matcher, then check rest cursors and public
field values.

A JSON ledger maps the three placeholder consumers to their Phase 4 replacement
tasks. The companion document limits each placeholder to its tested one-token
or one-token-tree behavior.

Validation:

- repeated names, expressions, parameter types, and constructor fields retain
  cardinality and order;
- Phase 2 exit checks cover malformed definitions, nested captures, resource
  limits, and deterministic serialization;
- 197 tests pass across 42 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- implement the Phase 3 hygiene scope store in `HYG-001`.

### PAT-007: declarative refinements complete

Added fixed refinement IR for token kinds, spelling and case, boundaries,
alternatives, repetition lengths, and delimiters. Constructors validate and
freeze each predicate. Evaluators walk nested captures and use fixed match
metadata maps for contextual predicates.

Syntax-class compilation resolves target names and class execution checks each
refinement before accepting a rule. The macro adapter lowers the ADT
lowercase-binder spelling into this IR.

Validation:

- tests cover predicate families, repeated values, Unicode case, malformed
  predicates, class-rule filtering, and concrete-syntax lowering;
- 195 tests pass across 41 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- port structural examples in `PAT-008`.

### PAT-006: user syntax classes complete

Added a compiled class registry with stable public field IDs, ordered rule
programs, and adapters for parser definitions. Token, token-tree, and identifier
classes have fixed built-in consumers. The registry accepts external grammar
consumers for expression, statement, item, type, and binding categories.

Class-rule compilation checks fields and capture dimensions. Dependency
analysis removes unresolved classes and unguarded recursive cycles. Runtime
matching remaps rule-local captures into public field records.

Validation:

- all acceptance syntax classes compile without diagnostics;
- the do-notation `BindClause` class matches and returns `name` and `source`;
- tests cover built-ins, nested fields, unresolved references, missing fields,
  and guarded recursion;
- 189 tests pass across 40 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- implement fixed declarative refinements in `PAT-007`.

### PAT-005: matcher failures and memoization complete

Added immutable failure expectations and farthest-position ranking. The VM
merges expectations at one source offset, sorts them by stable keys, and retains
their definition origins and maximum specificity.

The VM memoizes terminal failures by program counter, cursor identity,
environment epoch, and repetition shape. Converged choice paths reuse the
recorded failure without changing successful capture results.

Validation:

- tests cover farthest selection, merged expectations, specificity, memo hits,
  and invalid environment epochs;
- 183 tests pass across 39 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- compile and execute user syntax classes in `PAT-006`.

### PAT-004: matcher virtual machine complete

Added a worklist VM that executes immutable matcher programs against syntax
cursors. Forked states preserve cursor, group, repetition, and capture data for
ordered backtracking.

Repeat frames collect leaf and nested capture values into immutable sequences.
The VM restores the cursor before a failed separator and chooses the longest
successful repetition. It enforces matcher-step, deadline, nesting, and
cancellation limits.

Validation:

- the threading base rule passes from reader syntax through VM execution;
- focused tests cover choice rollback, complete groups, separated repetition,
  empty and nested captures, and resource stops;
- 180 tests pass across 39 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- add ranked failures and memoization in `PAT-005`.

### PAT-003: matcher-program compiler complete

Added immutable matcher instructions and a deterministic compiler. The compiler
uses an explicit task stack and continuation PCs, including local group exits,
ordered choice splits, and separated-repeat loops.

Capture slots sort by stable capture ID. Programs retain rule, repetition, and
origin identities and serialize to stable JSON.

Validation:

- every declarative acceptance rule parses, validates, and compiles twice to
  byte-identical output;
- tests check control-flow bounds, capture slots, group flows, repetition
  bounds, invalid-input rejection, and a 5,000-node pattern;
- 173 tests pass across 38 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- execute programs with checkpoints and rollback in `PAT-004`.

### PAT-002: capture-shape inference complete

Added explicit-stack inference for capture shapes and progress. Captures inside
repeat and optional nodes acquire nested dimensions with stable cardinality
groups. Sequence and choice merging diagnose duplicates and incompatible
capture sets or shapes.

Added syntax-class field checks and SWR2004-SWR2007 diagnostics. Parser capture
IDs are now stable by name within a rule, allowing alternatives to refer to one
logical capture and duplicate occurrences to be detected.

Validation:

- all declarative acceptance patterns infer without diagnostics;
- focused tests cover nested dimensions, choices, duplicates, zero-width
  loops, class fields, and a 5,000-node pattern;
- 168 tests pass across 37 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- compile matcher programs in `PAT-003`.

### MCL-001: structural macro-definition parser complete

Added immutable records and a recovering parser for syntax definitions, syntax
classes, and operators. Rule patterns lower to PAT-001 nodes; templates,
binding clauses, refinements, and operator properties remain lossless syntax
for later phases.

The parser handles TypeScript scanner behavior directly: `$value` is one
identifier token, while `$(` starts a repetition. It assigns deterministic IDs
and reports malformed headers, patterns, and categories through SWR2001-SWR2003.

Validation:

- all declarative acceptance files produce definitions;
- focused tests cover fields, recursion, core shadows, word and symbolic
  operators, captures, groups, choices, separated repetition, optionals, and
  recovery;
- 162 tests pass across 36 files;
- formatting, lint, typecheck, boundaries, and acceptance checks pass.

Next:

- infer and validate capture shapes in `PAT-002`.

### Project status control center

Added canonical status and review data, a generated dashboard, task evidence,
artifact conventions, and dependency-free Node commands.

Validation:

- status data validation passes;
- generated `STATUS.md` matches canonical state;
- local documentation links and Markdown structure pass.

Next:

- review ADR-0001;
- start `FND-001` after the tooling decision.

### FND-001: workspace foundation

Accepted ADR-0001 and created the package workspace with thirteen strict
TypeScript projects.

Validation:

- build and typecheck pass;
- lint and formatting pass;
- 16 tests pass across 14 files;
- package-boundary and cycle fixtures pass;
- status validation passes.

Discovery:

- TypeScript 7.0.2 ships without a programmatic API. The workspace uses the
  TypeScript 6 compatibility package and records a TypeScript 7.1 review point.
- This machine runs Node 26.5.0. Supported builds target Node 24.18.0 LTS, so
  local commands report an engine warning.

Next:

- start `FND-002`.

### FND-002: shared infrastructure started

Goal:

- define branded compiler IDs and deterministic allocators;
- define `Result` combinators;
- define cancellation tokens;
- define resource budgets and counters.

Next:

- implement the shared APIs and focused tests.

### FND-002: shared infrastructure complete

Delivered branded IDs, deterministic allocators, result combinators,
cancellation, and resource-budget enforcement in `@sweetener/shared`.

Validation:

- typecheck, lint, and formatting pass;
- 27 tests pass across 18 files;
- cancellation, invalid budgets, counters, nesting, and deadlines have focused
  coverage.

Next:

- begin `FND-003` structured diagnostics.

### FND-003: structured diagnostics complete

Added the shared diagnostic registry, code-range ownership, stage checks,
documentation requirements, source chains, expansion frames, and deterministic
rendering.

Validation:

- 33 tests pass across 19 files;
- focused tests reject malformed codes, ownership conflicts, duplicate entries,
  missing documentation, and invalid source spans;
- typecheck and lint pass.

Next:

- build the executable fixture harness in `FND-004`.

### FND-004: fixture harness started

Scope:

- validate manifests before compiler execution;
- discover cases in stable order and load optional expectations;
- normalize unstable paths, line endings, timing fields, and local IDs;
- keep golden updates outside test commands.

### FND-004: fixture harness complete

Added manifest validation, stable discovery, optional artifact loading,
expectation checks, snapshot normalization, and protected golden commands.

Validation:

- 42 tests pass across 22 files;
- the harness rejects malformed manifests, duplicate IDs, missing entry files,
  and missing expectation artifacts;
- candidates remain under `artifacts/golden-candidates` until a maintainer runs
  the acceptance command with the matching fixture and artifact approval string.

Next:

- import and classify the playground examples in `FND-005`.

### FND-005: corpus and first acceptance contracts

Imported 13 Sweet.js sources into the legacy corpus and recorded hashes. Twelve
acceptance manifests classify the examples by syntax family.

Added a machine-validated intent contract that names the declarative definition,
TypeScript expansion, type and runtime expectations, hygiene case, malformed
case, capabilities, and open decisions. Threading and do notation now provide
all of those artifacts. Their expected TypeScript passes the pinned compiler.

Validation:

- 53 tests pass across 24 files;
- intent validation rejects path traversal, missing files, ID mismatches, and
  capability-ledger drift;
- ten playground families still need complete contracts.

### FND-005: implicit return, protocols, and mixfix methods

Added complete proposed contracts for three more syntax families. Implicit
return fixes the statement-prefix and final-expression boundary. Protocols use
exported syntax-class fields and correlated repetitions. Multi-part methods
generate a local syntax binding that recognizes the captured mixfix segments.

Validation:

- the harness loads all five completed contracts;
- strict TypeScript accepts each primary expansion, type assertion, and hygiene
  expansion;
- seven playground families still need complete contracts.

### FND-005: CSP, operators, and rewritten if

Added complete contracts for binding-producing CSP operators, a composed
punctuation operator expression, and declarative interception of a two-branch
if statement. The cases require contextual `yield`, operator precedence,
lexical core shadowing, and definition-site helper resolution.

Validation:

- the harness loads all eight completed contracts;
- strict TypeScript accepts their primary and hygiene expansions;
- four playground families still need complete contracts.

### FND-005: acceptance corpus complete

Added the ADT, currying, core-rewrite, and combined-language contracts. All
twelve families now include a declarative definition, expected TypeScript,
types, runtime values, hygiene behavior, malformed behavior, capabilities, and
open decisions.

Added a generated capability ledger and a repository check that rejects stale
ledger content or a missing contract.

Validation:

- the harness loads all twelve contracts;
- strict TypeScript accepts all primary, type, and hygiene artifacts;
- 53 tests pass across 24 files;
- the acceptance-ledger check passes.

Next:

- consolidate the open syntax questions into decision records in `FND-006`.

### FND-006: product decisions ready for review

Prepared four ADRs covering source opt-in, pattern notation, core interception,
operators, generated syntax, composition, and acceptance scope. The review queue
links each recommendation to its fixture evidence.

Work can continue on the syntax representation because these product choices do
not affect its immutable data model. `SYN-001` is now in progress.

### SYN-001: immutable syntax primitives complete

Added validated spans, immutable trivia and syntax nodes, missing-close recovery
tokens, protected grammatical units, and deterministic structural hashing. The
constructors reject mutable children at the tree boundary.

Validation:

- 74 tests pass across 25 files;
- structural equality and hashes retain raw data, trivia, scopes, and origins;
- matcher literal comparison ignores source-only context;
- the queue advanced to `SYN-002` origins while `SYN-003` is ready.

### SYN-002: origin graph complete

Added a session-scoped origin store for source, copied, introduced, synthesized,
and composed origins. Structural interning reuses equal records. New records can
reference only existing records, so callers cannot construct cycles through the
public API.

Validation:

- 81 tests pass across 26 files;
- source traversal handles a 20,000-node chain without recursion;
- primary-source policies select invocation, definition, or leftmost ancestry;
- the queue advanced to `SYN-003` cursors.

### SYN-003: checkpointed syntax cursors complete

Added immutable sequence snapshots and ranges, bounded traversal, constant-time
marks and resets, independently mutable forks, stable location identities, and
nested group entry and exit. Marks cannot cross cursor instances, including
forks, which prevents accidental restoration into unrelated mutable state.

Validation:

- 91 tests pass across 27 files;
- ten cursor tests cover empty, bounded, restored, forked, nested, immutable,
  and independent traversal behavior;
- typecheck and lint pass;
- the queue advanced to `RDR-001`, the TypeScript scanner adapter.

### RDR-001: TypeScript scanner adapter complete

Added an immutable lossless token contract and confined TypeScript 6 scanner
calls, enums, version checks, and classification to one version adapter. The
public scanner preserves raw spelling, UTF-16 offsets, trivia, line breaks,
compiler kind names, lexical flags, EOF trivia, and scanner diagnostics.

Validation:

- 100 tests pass across 28 files;
- exact reconstruction covers comments, Unicode, final trivia, and custom
  punctuation from the playground;
- unsupported compiler lines fail explicitly;
- formatting, lint, typecheck, boundaries, acceptance ledger, and status checks
  pass;
- the queue advanced to `RDR-002` template modes; `RDR-003` JSX modes is ready.

### RDR-002: template lexical modes complete

Added iterative contextual rescanning for template substitutions. The adapter
tracks ordinary brace depth and nested templates independently, producing
heads, middles, and tails without conflating a nested object close with a
substitution close.

Validation:

- 105 tests pass across 28 files;
- exact reconstruction covers multiple substitutions, nested objects, nested
  templates, escapes, and unterminated input;
- typecheck and lint pass;
- the queue advanced to `RDR-003` JSX lexical modes.

### RDR-003: JSX lexical modes complete

Added iterative transitions between JSX tags, text, and embedded expressions,
including nested JSX and templates within expressions. Tag names use JSX
identifier scanning, while element-name pairing remains outside the lexical
layer. A progress invariant prevents a zero-width scanner transition from
hanging malformed input.

Validation:

- 110 tests pass across 28 files;
- exact reconstruction covers attributes, fragments, nested and self-closing
  elements, expression nesting, mismatched tags, and TSX comparisons;
- typecheck and lint pass;
- the queue advanced to `RDR-004` delimiter trees and recovery.

### RDR-004: delimiter trees and recovery complete

Added `RootSyntax` to represent files without invented delimiters and updated
structural hashing, equality, and architecture specifications. The reader now
converts scanner tokens to syntax with source origins and uses one explicit
stack for ordinary groups, substitution templates, JSX elements, fragments,
and recovery. Missing tokens receive synthesized origins; unexpected closers
remain in the partial tree.

Validation:

- 121 tests pass across 29 files;
- exact reconstruction holds for normal and recovered trees;
- 2,000 unterminated groups recover without recursion;
- empty, template, JSX, mismatch, unexpected-close, and origin cases pass;
- the queue advanced to `RDR-005`; the incremental baseline is ready.

### RDR-005: lossless printer complete

Added an iterative production printer for roots, groups, protected syntax,
tokens, trivia, and synthesized missing tokens. It emits only source-backed
text and preserves compound template tokens and JSX container ordering.

Validation:

- byte equality and read-print-read structural equality cover valid and
  recovered TypeScript, template, and JSX inputs;
- all imported playground sources round-trip exactly;
- 5,000 nested groups print without recursion;
- focused reader tests, typecheck, and lint pass;
- the queue advanced to `RDR-006` incremental API baseline.

### RDR-006: incremental reader baseline complete

Added immutable source, reader-options, read-file, change-range, and incremental
metadata contracts. `Reader.update` validates the declared edit and performs a
clean read, making the zero-reuse baseline explicit rather than implying
incrementality that is not implemented yet.

Validation:

- 137 tests pass across 31 files;
- replacements, insertions, deletions, chained TSX edits, and clean-read
  equivalence pass;
- inaccurate edits and cross-source updates fail with precise range errors;
- the queue advanced to `RDR-007` corpus and performance baselines.

### RDR-007: reader corpus and baseline complete

Added scanner-time cancellation and token limits, grouping-time nesting and
deadline checks, lexical-goal regex rescanning, and standalone `#` punctuation
support. Added production TypeScript, TSX, playground, fixed-seed property, and
cursor-reachability corpus gates. The benchmark runner records seven timing
samples plus heap and sampled-allocation data.

Validation:

- production TypeScript reads with zero diagnostics;
- all playground sources remain byte-exact, with one allowlisted unmatched
  parenthesis in the imported ADT source;
- 250 fixed seeds retain bytes, structure, and diagnostic codes;
- resource and deep iterative traversal tests pass;
- macro-free throughput reaches 3.16 MiB/s on the local M2 Max, below the 25
  MiB/s hypothesis recorded in `docs/benchmarks/reader-baseline.md`;
- Phase 1 exits and the queue advances to `PAT-001`.

### PAT-001: pattern and capture IR complete

Added immutable pattern nodes for literals, captures, sequences, groups,
choices, repetition, optional forms, class calls, and fixed lookahead. Capture
paths retain author names and resolved IDs. Shape and runtime records preserve
nested dimensions and cardinality groups through deterministic persistent maps.

Validation:

- 158 tests pass across 36 files;
- constructors reject invalid names, paths, bounds, duplicates, mutable child
  data, and mismatched sequence depths;
- full project gate passes;
- the queue advances to `MCL-001` structural definition parsing.

### EXP-005: explicit lexical core shadowing complete

Added pinned core-form identities, immutable local and imported authorization
metadata, two-sided import opt-in, phase/category-aware lexical dispatch, and
stable diagnostics for invalid configuration and ambiguity. Authorized
interception is validated against the exact macro invocation and retained in
both successful and failed expansion traces.

Validation:

- 468 tests pass across 65 files;
- focused tests cover local interception, built-in fallback, import opt-in,
  malformed configuration, lexical shadowing, ambiguity, and category isolation;
- invocation tests cover trace retention and reject mismatched dispatch records;
- formatting, lint, TypeScript build, package boundaries, and acceptance checks
  pass;
- the queue advances to `EXP-006`, the complete `do`-notation vertical slice.

### EXP-006: declarative compiler seam established

Added `compileParsedMacros`, the public orchestration seam that lowers parsed
definitions through syntax-class compilation, capture-shape inference, matcher
bytecode, hygienic templates, binding contracts, and macro binding creation.
The complete declarative `doSteps` fixture now compiles through that API with
its exported `BindClause` fields, two recursive rules, and sequential binding
contract intact.

The fixture exposed an important template ambiguity: member access such as
`$monad.flatMap` must remain TypeScript syntax, while `$step.source` must project
a declared syntax-class field. Template compilation now identifies built-in and
external classes explicitly, preserving member access without weakening unknown
field diagnostics for user-defined syntax classes.

## 2026-08-03

### CMP-005: implicit-return and operators executable

Completed two more playground acceptance families. Implicit-return now uses a
declarative `FunctionBody` syntax class, typed lexical binding contracts,
protected core-function emission, and trivia-safe `#trim` lowering. Custom
operators now carry exact expansion, binding, trace, diagnostics, TypeScript,
runtime, and adversarial hygiene evidence; equality lowering references
`globalThis.Object.is` so a call-site `Object` binding cannot capture it.

Validation:

- 514 tests pass across 73 files;
- formatting, lint, TypeScript build, package boundaries, and acceptance-ledger
  checks pass;
- the queue advances to the `currying` playground family.

### CMP-005: currying executable

Completed the currying family with modifier-aware dispatch for exported core
declarations, a declarative `CurryParameters` syntax class for both accepted
comma forms, protected overload-item emission, and explicit recursive and
lexical binding contracts. Added exact expansion, trace, malformed diagnostic,
strict TypeScript, direct/partial runtime, and adversarial hygienic-name tests.
Raised time budgets on the two deliberately whole-workspace corpus gates so
parallel full-suite load does not turn valid multi-second checks into flakes.

Validation:

- 522 tests pass across 75 files;
- formatting, lint, TypeScript build, package boundaries, and acceptance-ledger
  checks pass;
- the queue advances to the `core-rewrites` playground family.

### CMP-005: core-rewrites executable

Completed both lexical core rewrites. Declarative literal declarations now
lower to binding-literal matcher instructions, so the `NaN` specialization is
selected by identity and a shadowing binding reaches the protected fallback.
Added `#count` as a finite, budgeted, traced template operation producing
numeric syntax. Function rewriting emits a protected declaration with
capture-proof `globalThis.Number` and `globalThis.Error` references.

Validation:

- 528 tests pass across 76 files;
- formatting, lint, TypeScript build, package boundaries, and acceptance-ledger
  checks pass;
- the queue advances to the `adt`/`match` playground family.

### CMP-005: ADT/match executable

Completed declarative generic data declarations and constructor matching.
Constructor fields are represented as structured syntax-class captures, which
preserves the correlation between each field name and type through nested
repetition. Generated unions and constructors use protected item emission and
explicit type/value binding contracts. Match arms lower to direct branch-local
destructuring, retaining TypeScript discriminant narrowing and hygienic binder
identity. Text conversion now strips only peripheral captured trivia so a
formatted constructor such as `| Some(...)` still produces the stable tag
`"Some"`.

Validation:

- 533 tests pass across 77 files;
- the focused family proves malformed diagnostics, nested repetition,
  adversarial name assignment, semantic TypeScript checking, and runtime result
  `4`;
- formatting, lint, TypeScript build, package boundaries, and
  acceptance-ledger checks pass;
- the queue advances to the `protocols` playground family.

### CMP-005: protocols executable

Completed typed protocol declarations and class implementation registration.
Protocol expansion now emits a self-contained weak-map dispatch value with
capture-proof globals and correlated generated methods. The recursive expander
now recognizes a declared infix item operator anywhere on the top-level item
spine and invokes it from the left operand boundary, allowing `User implements
Equal<User>` to remain a genuinely declarative operator form.

Validation:

- 541 tests pass across 78 files;
- formatting, lint, TypeScript build, package boundaries, and acceptance-ledger
  checks pass;
- the queue advances to the `csp` playground family.

### CMP-005: CSP executable

Completed declarative send and receive statement operators. Compound
punctuation operators now dispatch from statement-position left operands using
longest-match selection. Both forms declare a generator-context requirement;
receive additionally introduces its binding into following statements, and
the expression consumer enforces yield placement.

Validation:

- 549 tests pass across 79 files;
- the focused family proves source-order expansion, sequential binding,
  generator-context rejection, malformed-channel diagnostics, adversarial
  name assignment, semantic TypeScript checking, and runtime result `3`;
- formatting, lint, TypeScript build, package boundaries, and
  acceptance-ledger checks pass;
- the queue advances to the `multi-part-methods` playground family.

### CMP-005: multi-part methods executable

Completed generated newline-spanning mixfix methods. Recursive expansion now
processes `#syntax` output through the generated-definition compiler, registers
accepted bindings into the active source-ordered environment, exposes the
resulting module and registration trace, and removes compile-time definitions
from emitted TypeScript. Added the finite declarative
`#metavar(hint, $driver)` operation: nested repetition indices produce stable
generated capture names shared by a generated rule and its template, avoiding
duplicate captures without procedural expansion code.

Validation:

- 557 tests pass across 80 files;
- focused tests cover registration, newline-spanning invocation, nested exact
  arity, missing-segment diagnostics, adversarial parameter hygiene, strict
  TypeScript, and runtime result `true`;
- formatting, lint, TypeScript build, package boundaries, and
  acceptance-ledger checks pass;
- the queue advances to the `new-language` playground family.

### CMP-005: combined new-language executable and suite complete

Completed the final combined playground family. A production macro-extent
resolver uses declarative matcher programs to protect nested item and statement
forms without executing them during outer matching. Recursive expansion then
composes modules with records, extension methods, and receiver dispatch.

Validation:

- 562 tests pass across 81 files;
- exact nested diagnostics, adversarial receiver hygiene, strict TypeScript,
  and runtime result `3` pass;
- all playground case manifests now enable expansion, bindings, trace,
  diagnostics, types, and runtime evidence;
- `CMP-005` is complete and the queue advances to `CMP-006`.

### CMP-006: declarative boundary audit complete

Added a repository-wide declarative acceptance audit. It rejects compiler and
host imports, compiler or syntax-construction helpers, raw syntax-object
records, and dynamic host capabilities. The audit is reusable as a source API,
has nine focused positive and adversarial tests, scans every acceptance
definition, and runs in the ordinary CI gate.

Validation:

- 574 tests pass across 82 files;
- formatting, lint, TypeScript, package boundaries, declarative boundaries,
  and acceptance contracts pass;
- Phase 5 is complete and the queue advances to `TSH-001`.

### TLS-004: mapped language-service reads complete

Added an origin-aware facade over the official TypeScript language service.
Diagnostics retain macro expansion context, quick info preserves display parts,
documentation, and tags, and definitions map across canonical virtual paths.
Results without an original source projection explicitly link to the expansion
view instead of pretending to be editable source.

Validation:

- focused diagnostics, hover, definition, and generated-only tests pass;
- generated TypeScript spans project back to full original spans;
- three compiler-heavy full-suite tests exposed parallel-load timeout budgets,
  and now declare explicit 30-second limits;
- the queue advances to binding-aware references and safe rename in `TLS-005`.

### TLS-005: references and safe rename complete

Reference results now project through canonical origin indexes. Rename is
deliberately stricter: direct source syntax is editable, introduced and
generated-only syntax is refused, and copied captures require a stable
hygienic `BindingId` at every affected location. This prevents TypeScript's
symbol view from accidentally merging bindings that macros keep distinct.

Validation:

- six focused mapped-language-service tests cover reads, references, ordinary
  rename, introduced syntax, and captured binding proof;
- the complete gate passes 627 tests across 98 files;
- formatting, lint, type checking, package boundaries, declarative boundaries,
  and acceptance contracts pass;
- the queue advances to benchmark infrastructure in `PRF-001`.

### PRF-001: benchmark protocol and baseline complete

Added one typed benchmark contract and one production runner. Reports retain raw
wall-clock, CPU, and heap samples plus p50, p95, p99, mean, and range. Scenario
selection is deterministic, warmups are excluded from measurements, environment
metadata includes Node and TypeScript, and comparisons combine relative and
absolute budgets without mutating the accepted baseline.

Validation:

- six production reader and hygiene scenarios have a five-sample Node 24.18.1
  baseline under `benchmarks/baselines/node24.json`;
- a comparison run demonstrated structured nonzero regression reporting;
- three focused benchmark-protocol tests pass;
- the complete repository gate passes 630 tests across 99 files;
- the queue advances to measurement-led profiling in `PRF-002`.

### PRF-002: measured hot-path optimization complete

Expanded the production suite to thirteen scenarios covering every required
compiler stage. CPU profiles identified serialized scope-set key rebuilding and
quadratic origin-index construction. Cached append keys and identity-set
construction preserve semantics while reducing the respective measured costs
by an order of magnitude. Reverse source queries now use interval indexes.

Validation:

- the refreshed Node 24 baseline covers reader, matcher, expansion, printers,
  mapping, caches, hygiene, and the language-service host;
- raw CPU profiles and before/after reports are retained under `artifacts/`;
- all semantic and repository gates pass;
- the queue advances to compatibility validation.

### REL-001: compatibility matrix complete

Declared support is now executable. A public probe accepts Node 24.x and the
TypeScript 6.0.x API line and emits stable release diagnostics otherwise. CI
runs the oldest/newest Node and compatibility-package cross product.

Validation:

- an isolated Node 24.0.0 plus `@typescript/typescript6@6.0.0` workspace passes
  all 633 tests, types, boundaries, and acceptance contracts;
- Node 24.18.1 plus the pinned endpoint passes the probe and ordinary gates;
- the compatibility report records that both npm endpoints expose API 6.0.3
  with no observed adapter differences;
- the queue advances to publishable specifications in `REL-002`.

### REL-002: public specifications complete

Added a normative release specification for grammar, hygiene, phases, operators,
generated definitions, macro modules, traces, origins, security, resources,
package roots, and Sweet.js migration. Pattern fallback and fragment validation
are now resolved decisions rather than open specification markers.

Validation:

- the specification index exposes the complete release surface;
- a mandatory gate rejects unresolved markers, missing sections/packages, and
  duplicate ADR numbers;
- the queue advances to two non-workspace sample projects in `REL-003`.

### REL-003: external sample projects complete

Added two independently installed projects outside the pnpm workspace. The
project graph proves check/build/watch behavior. The macro/editor project uses
only public package roots to compile and expand a declarative macro, execute its
output, inspect its trace, and validate every mapped editor read and safe rename.

Validation:

- both samples install with `--ignore-workspace`;
- runtime result is `[21, 21]`;
- the full gate now includes both workflows and passes 633 tests;
- the remaining packed-tarball gap advances explicitly to `REL-004`.

### REL-004: installable alpha candidate staged

Staged thirteen synchronized `0.1.0-alpha.0` packages without private or
workspace-only manifest fields. A clean Node 24 project installs every tarball,
verifies versions and dependency ranges, and reruns both external workflows.
Release metadata records hashes and every language/format version. Release
notes, version policy, compatibility, benchmarks, and known limitations are
published locally.

Mapped TypeScript completions were added before staging and are exercised by the
external editor sample. The full local gate passes 635 tests across 100 files,
external samples, specification checks, and release-integrity checks.

Registry upload, annotated Git tagging, and maintainer acceptance of the three
remaining proposed product ADRs are external release actions and remain open.

## 2026-08-03: Default compiler integration begins

- Completion audit found that public project commands still required an
  application-injected expansion provider and that the CLI package had no
  executable entry point.
- Added release-blocking task TSH-009 so this end-user path cannot be hidden by
  lower-level package or sample success.
- Specified and implemented structural parsing for named `for syntax` imports,
  including aliases, runtime-edge separation, origins, and `SWR2004`
  diagnostics.
- Added exact manifest-export binding, a production category-complete expansion
  session, full-file typed regions, lexical operator dispatch, and a default
  project provider.
- Added the `sweetener` executable and an external no-provider project which
  proves expression, statement, item, type, and operator expansion, TypeScript
  build/declarations, runtime, expansion explanations, and both call-site and
  macro-definition watch edits.

# 2026-08-03: TSH-009 default compiler completion

- Completed the public default project compiler and executable path for `.sts`
  and `.stsx` without injected expansion or inspection providers.
- Added installed `sweetMacros` discovery with root containment, manifest
  validation, multi-source exports, compatibility checks, and transitive watch
  dependency tracking.
- Closed lexical isolation for ordinary macros and symbolic operators, while
  preserving defining-module imports inside macro replacements.
- The complete repository gate passes with 644 unit tests across 102 files;
  the clean external default project proves build, declarations, runtime,
  expand/explain, mappings, and both call-site and definition watch edits.

# 2026-08-03: Production acceptance and runtime-import audit

- Added a production-frontend matrix that loads all twelve declarative
  playground families, rejects macro diagnostics, parses the generated
  TypeScript, executes it, and compares each documented runtime result.
- Added direct production proofs for generated definitions, recursive macros,
  binding literals, generator context, source-ordered macros/operators, core
  interception opt-in, TSX/JSX, package discovery, and malformed manifests.
- Fixed recursive lookup so a missing optional recursive binding cannot suppress
  imported or generated macros, and made recursive ownership use module-local
  binding identity rather than numeric-ID coincidence.
- Materialized definition-site runtime imports only for invoked macros, rebased
  relative specifiers, and deterministically aliased collisions while rewriting
  introduced references but not captured call-site identifiers.
- Added production-provider matrices for all twelve malformed fixtures and all
  twelve hygiene fixtures. Malformed cases produce their exact stable macro
  diagnostics; hygiene cases produce valid TypeScript and the same runtime
  results as their reviewed expected programs.
- Closed nested expression-operator dispatch inside array elements and removed
  duplicate operator diagnostics at the production-session boundary.
- The rebuilt repository suite passes 655 tests across 102 files. Formatting,
  lint, type checking, boundaries, acceptance contracts, specifications,
  external samples, and release staging pass; the status snapshot was refreshed.
- Packed verification installed all thirteen alpha tarballs and passed every
  external workflow. The supported Node 24.18.1 compatibility probe passed.
- Refreshed the Node 24 benchmark baseline because the macro-free reader corpus
  grew from 5,342,216 to 6,168,952 measured bytes (15.48%); elapsed time grew
  proportionally while throughput remained effectively stable. A subsequent
  comparison run passed every explicit regression budget.

# 2026-08-03: Alpha ADR decisions; release authority withheld

- Accepted ADR-0002, ADR-0004, and ADR-0005 without revision based on the
  production acceptance, external-project, tooling, and packed-release evidence.
- npm publication and Git-tag creation are not authorized and were not
  performed.
- REL-004 remains blocked. All staged packages and release artifacts must remain
  local unless separate, unambiguous authorization is given.
