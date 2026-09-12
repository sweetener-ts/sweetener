# Proposed Architecture

## Design rule

Own macro expansion. Let TypeScript own TypeScript semantics.

## Pipeline

```text
              compile-time imports
                       |
source -> reader -> token trees -> expansion -> printed virtual TS
                                      |                 |
                              expansion trace       source map
                                                        |
                                  TypeScript parse -> bind -> check -> emit
```

## Packages

### `syntax`

Defines immutable green token trees and lightweight red cursors.

Core data:

```ts
type Syntax = TokenSyntax | GroupSyntax | ParsedSyntax;

interface SyntaxBase {
  id: SyntaxId;
  span: Span;
  scopes: ScopeSet;
  origin: Origin;
}

interface TokenSyntax extends SyntaxBase {
  kind: TokenKind;
  raw: string;
  leadingTrivia: Trivia[];
  trailingTrivia: Trivia[];
}

interface GroupSyntax extends SyntaxBase {
  delimiter: "paren" | "bracket" | "brace" | "template" | "jsx";
  children: readonly Syntax[];
}

interface ParsedSyntax extends SyntaxBase {
  category: SyntaxCategory;
  children: readonly Syntax[];
}
```

Green nodes use structural sharing and contain no parent pointer. Cursors provide
parents and offsets for one traversal. The implementation interns scope sets and
uses integer IDs for scopes, symbols, sources, and origins.

### `reader`

Converts text into lossless token trees. It recognizes host lexical modes and
balanced delimiters but assigns no meaning to declarations or expressions. It
reports unmatched delimiters at their source locations.

The reader API accepts a previous tree and edit range so later versions can
reuse unchanged subtrees. The first implementation may perform a full-file read,
but its data model must not block incremental replacement.

### `hygiene`

Provides scope allocation, immutable scope sets, binding identities, resolution,
and controlled capture. The resolver accepts `(spelling, scopes, phase, space)`
and returns a binding identity. Printers choose collision-free readable names
only after expansion.

Bindings and printed names are distinct. A generated suffix does not prove
hygiene in tests.

### `matcher`

Compiles declarative rules to a matcher IR. It works over a checkpointed cursor
and calls registered syntax consumers for typed metavariables. Compilation
checks repetition depth, variable consistency, unreachable alternatives, and
unsupported ambiguity before a rule runs.

The engine memoizes `(patternState, cursorPosition, category, environmentEpoch)`
failures. Ordered rules give deterministic selection. A match returns captures,
the remaining cursor, and a compact failure tree for diagnostics.

### `enforest`

Consumes one syntactic unit in a named category. It owns:

- macro-head lookup;
- prefix and infix dispatch;
- precedence and associativity;
- stopping tokens for the current context;
- protection of already parsed syntax;
- recursive expansion where needed to determine extent.

It does not build a complete TypeScript semantic AST. Consumers may use a small
Pratt parser, a bounded TypeScript parse adapter, or category-specific logic
behind one interface:

```ts
interface SyntaxConsumer {
  consume(cursor: Cursor, context: ExpansionContext): ConsumeResult;
}
```

### `expander`

Maintains lexical environments by phase and syntax category. It expands macro
definitions and calls, applies introduction/use-site scopes, instantiates
templates, detects cycles, and records trace events. Its outputs contain no
macro declarations or compile-time imports.

Expansion uses a work queue rather than recursive calls where possible. Limits
cover expansion steps, output tokens, nested depth, wall time, and retained
origins.

### `macro-module`

Parses, validates, compiles, and caches declarative macro modules. Runtime and
compile-time imports form separate graph edges. Macro exports use stable content
hashes so unchanged dependents reuse expansion results.

### `printer`

Prints valid TypeScript and creates high-resolution mappings. It preserves raw
text for copied regions. Introduced syntax uses a deterministic canonical style.
It also emits an optional machine-readable expansion trace.

### `typescript-host`

Wraps `CompilerHost`, module resolution, builders, and watch mode. It serves
expanded virtual files, composes diagnostics/maps, and delegates checking and
emit to the supported TypeScript version.

### `cli`

Initial commands:

```text
sweet-ts check -p tsconfig.json
sweet-ts build -p tsconfig.json
sweet-ts watch -p tsconfig.json
sweet-ts expand path/file.sts
sweet-ts explain path/file.sts:line:column
```

## Expansion categories

Start with fixed categories:

- `item`: source-file and namespace/module elements;
- `stmt`: statements;
- `expr`: expressions;
- `type`: type nodes;
- `binding`: binding names and patterns;
- `classElement`: class members;
- `typeMember`: members of an interface or object type;
- `jsxChild`: JSX children;
- `token` and `tt`: raw leaf and token tree.

These act like Rhombus spaces and Sweet.js grammar productions. Each binding
records which categories can invoke it. The same spelling may have separate
bindings in separate categories.

## Expansion algorithm sketch

1. Read the file and discover phase-1 imports and macro declarations.
2. Resolve and compile macro dependencies.
3. Enter the `item` consumer at the file start.
4. At a candidate head, resolve a macro in the current category and phase.
5. Add a fresh use-site scope to the input visible to the transformer.
6. Match rules with a checkpointed cursor and category consumers.
7. Instantiate the selected template. Copied captures keep call-site scopes;
   introduced identifiers receive a fresh introduction scope.
8. Re-enter expansion on the replacement in the category requested by the
   surrounding consumer.
9. Register bindings produced by ordinary TypeScript forms or macros as their
   scope becomes known.
10. Print, validate with TypeScript, and cache the result.

The exact use-site-scope rules need a small formal model before implementation.
The prototype should encode them in one kernel with executable examples.

## Error model

Errors belong to one of four stages:

- reader: invalid token or delimiter structure;
- matcher: no rule, ambiguous rule, or invalid repetition;
- expander: unknown macro, phase error, cycle, or resource limit;
- TypeScript: invalid expanded syntax or semantic/type diagnostic.

Each error includes the original span, macro invocation stack, related template
spans, category, and a rendered expectation. Do not collapse matcher failures
into a later TypeScript parse error.

## Performance model

Expected cost for a clean build:

```text
O(source tokens + successful matching + emitted tokens + TypeScript compilation)
```

Avoid these hidden multipliers:

- reparsing every suffix for each pattern alternative;
- copying scope arrays on every token;
- rebuilding complete trees after one replacement;
- formatting before cache lookup;
- invalidating runtime dependents for compile-time-only changes.

Use structural sharing, interned scope sets, cursor checkpoints, failure
memoization, compiled patterns, and content-addressed caches. Benchmarks must
confirm the model before optimization work expands.

## Architectural risks

### Parser duplication

Expression and type extent can pull the project toward a TypeScript parser fork.
Keep consumers replaceable and measure the wrapper/hybrid strategies in R2.

### TypeScript evolution

New lexical and grammar forms can break the reader or extent consumers. Pin and
test a support matrix; isolate version-specific code.

### Tooling split-brain

Editors that read raw `.sts` will not understand custom syntax. Treat virtual
files and bidirectional mappings as core artifacts, then build a language-service
adapter from them.

### Expansion order

Local macros, generated declarations, imports, and categories can create subtle
visibility rules. Write a phase/scope specification and reject cases it does not
cover rather than using ad hoc rescans.
