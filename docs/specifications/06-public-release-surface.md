# Public Release Surface

Status: normative for language version `1` and format version `1`.

## 1. Source ownership and grammar

Macro-enabled TypeScript MUST use `.sts` or `.stsx` and a `sweet` project
configuration. Ordinary `.ts` and `.tsx` remain TypeScript-owned. Definitions
use the structural grammar specified in
[patterns and templates](03-patterns-templates.md): typed captures, grouped
repetition, explicit syntax-class fields, finite refinements, declarative
templates, binding clauses, and explicitly marked fallback rules. Macro authors
MUST NOT access cursors, construct syntax objects, invoke compiler internals, or
run arbitrary expansion-time code.

## 2. Hygiene and phases

The scope-set and binding-identity rules in
[syntax objects and hygiene](02-syntax-objects-hygiene.md) are normative.
Introduced identifiers receive definition and introduction scopes; captures
retain use-site identity under ADR-0006. Binding clauses are the only public way
to declare binders and regions. Macro bindings are phase-indexed. A phase-`n`
macro is available only in the declared compile-time environment; runtime
imports do not create macro dependencies.

## 3. Categories, operators, and generated definitions

The public categories are `item`, `stmt`, `expr`, `type`, `binding`,
`classElement`, `typeMember`, `jsxChild`, `token`, and `tt`. Operators declare category,
fixity/mixfix shape, precedence, and associativity. Longest compound spelling is
selected before precedence comparison. Equal-band nonassociative chains fail.
Core-form interception is lexical and explicit.

`#syntax { ... }` output MAY register declarative definitions after parsing,
validation, hygiene, and resource checks. Generated definitions enter only the
following source-ordered environment and MUST NOT execute host code.

## 4. Macro-module format

Source files import named macro exports with
`import { exported as local } from "specifier" for syntax;`. The `for syntax`
qualifier is mandatory and creates only a compile-time macro edge; an ordinary
TypeScript import creates only a runtime edge. Namespace, default, side-effect,
and type-only macro imports are not part of language version `1`. Imported names
MUST be declared by the resolved manifest and enter the source-ordered phase-1
environment after the import statement. Symbolic operators use parenthesized
names, for example `import { (|>) } from "forms" for syntax;`. Language version
`1` does not rename symbolic operator spellings at import sites.
An import that intentionally intercepts a pinned TypeScript core form appends
`shadows core` after the phase qualifier, for example
`import { if } from "forms" for syntax shadows core;`. The imported definition
MUST also declare `shadows core`; either missing opt-in leaves built-in parsing
in control, and an import-side opt-in without definition authorization produces
`SWR4003`.

Installed packages expose macro manifests through the `sweetMacros` field in
their `package.json`. A string exposes the package root (`.`); a closed object
maps package subpaths such as `"./operators"` to manifest JSON files. Pointers
MUST be package-relative and MUST NOT escape the package root. The selected
manifest's `entry` and every export `source` are resolved relative to that root.
Package macro resolution is independent from runtime `exports`; a package may
publish either or both graphs explicitly.

An ordinary TypeScript import in a macro-definition module declares a
definition-site runtime dependency. When an invoked template introduces a
reference to one of that import's local bindings, the host MUST materialize the
corresponding import in the consumer's generated TypeScript. Relative module
specifiers are rebased from the definition module to the consumer. If the local
name is unavailable at the call site, the generated import and every introduced
reference use the same deterministic alias (for example,
`import { IF as IF_1 } from "./runtime.js"`). Captured call-site identifiers are
never rewritten by this process, and imports from macros that were not invoked
MUST NOT be emitted.

Manifest `formatVersion` is `1`. A manifest is closed and contains `name`,
`languageVersion`, compiler minimum/maximum, `entry`, named exports, and
dependencies. Each export declares source, category, and phase. Each dependency
is classified as `macro` or `runtime` and lists imported exports. Unknown fields,
invalid versions/categories/phases, cycles, or undeclared macro dependencies
MUST produce structured diagnostics. Resolution and cache keys MUST be
deterministic and independent of object-key order.

## 5. Trace and origin-map formats

Origin-map schema version `1` is an ordered list of non-overlapping generated
ranges. Every range names an interned origin and classifies it as source,
copied, introduced, synthesized, composed, or grouping. Gaps are generated-only
and link to expansion view. Origins form an acyclic graph and retain all source
contributors.

Expansion traces serialize canonically with sorted object keys and a trailing
newline. Invocation events contain invocation/parent IDs, binding, category,
phase, invocation origin, ordered rule attempts, selected rule, capture and
introduced-binding summaries, template operations, output origins, cache state,
and core interception. Generated-definition and operator-grouping events retain
their environment and decision evidence. Consumers MUST ignore unknown event
fields within schema version `1`; a breaking meaning or required-field change
requires schema version `2`.

## 6. Security and resources

The public macro language is data, not a JavaScript module. It has no filesystem,
network, environment, process, clock, randomness, dynamic import, evaluator, or
TypeChecker authority. Fixed declarative operations are implemented by the
compiler and audited by the declarative-boundary gate.

Every read, match, template, expansion, generated definition, and recursive
operation charges the configured resource tracker. Input/output tokens, matcher
steps, template steps, expansion steps, nesting, cancellation, and deadlines
MUST fail with stable structured diagnostics. Partial, failed, or cancelled
results MUST NOT be cached: the compiler session caches an expansion only when
it produced no diagnostics, and a cancellation or exhausted limit throws before
anything is stored. `ContentAddressedCompilerCache` in `@sweetener/typescript-host`
offers the same guarantee to a host that keeps its own cache; the compiler does
not use it.

## 7. Public packages

| Package                         | Contract                                                             |
| ------------------------------- | -------------------------------------------------------------------- |
| `@sweetener/compiler`           | the expansion session every adapter is built on                      |
| `@sweetener/cli`                | configuration and check/build/watch/expand/explain commands          |
| `@sweetener/unplugin`           | Vite, Rollup, Rolldown, webpack, Rspack, Rsbuild, esbuild, Farm, Bun |
| `@sweetener/webpack-loader`     | the loader a webpack rule names, and Next.js through Turbopack       |
| `@sweetener/parcel-transformer` | Parcel transformer, named as Parcel requires plugins to be           |
| `@sweetener/jest`               | Jest transformer for `.sts` and `.stsx`                              |
| `@sweetener/prettier-plugin`    | conservative, syntax-safe formatting for `.sts` and `.stsx`          |
| `@sweetener/node`               | `node --import @sweetener/node/register`                             |
| `@sweetener/deno`               | `deno run --import npm:@sweetener/deno/register`                     |

The compiler's layers ship inside `@sweetener/compiler` rather than as packages
of their own: opaque IDs and diagnostics, immutable syntax and origins, the
reader, the pattern IR and matcher, the definition parser, hygiene, templates,
enforestation, expansion, the printer, and the TypeScript host. Four stay
reachable, because a published package reaches them:

| Entry point                           | Contract                                                     |
| ------------------------------------- | ------------------------------------------------------------ |
| `@sweetener/compiler/typescript-host` | manifests, resolution, hosts, maps, caches, tooling reads    |
| `@sweetener/compiler/reader`          | TS/TSX scanning, trees, incremental reads, lossless printing |
| `@sweetener/compiler/syntax`          | immutable syntax, cursors, spans, origins                    |
| `@sweetener/compiler/shared`          | opaque IDs, cancellation, diagnostics, results, limits       |

The layering itself is normative and enforced by the boundary gate, which reads
the workspace rather than the registry: a layer may import only the layers
below it whether or not they are published separately. The remaining layers
have no entry point and no stable API.

Only the entry points above are public. Deeper paths into any package are
unsupported and rejected by the boundary gate. Version `0.x` packages may
change TypeScript signatures, but observable language behavior follows the
language and format versions above.

## 8. Migration from Sweet.js

Legacy `syntax`/`syntaxrec` definitions become declarative `macro` rules.
Postfix ellipses become grouped `$()` repetition. Syntax-class concatenated
fields become dot fields. `withSyntax`, host functions, and arbitrary transformer
code must be replaced with templates, binding clauses, finite refinements,
`#fresh`, `#datum`, `#if`, `#join`, `#fold`, or `#metavar`. A transformation that
cannot be expressed by those operations is unsupported in version `1`; it is
not grounds for importing compiler APIs.

Rename macro-owned `.js`/`.sjs` files to `.sts` or `.stsx`, declare macro/runtime
dependency kinds, and use project `sweet` configuration. Validate migration with
`expand`, `explain`, `check`, then `build`. Compare runtime behavior, TypeScript
diagnostics, binding identities, and declarations, rather than formatting
alone.

The accepted playground families are executable migration examples for
threading, do notation, implicit return, operators, core rewrites, ADTs,
protocols, CSP, multipart methods, and the combined language.
