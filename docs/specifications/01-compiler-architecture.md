# Compiler Architecture Specification

## 1. Repository layout

Use a package workspace with these initial packages:

```text
packages/
  shared/              IDs, Result, diagnostics, limits, hashing
  syntax/              immutable syntax data, origins, cursors
  reader/              TypeScript-aware scanner and delimiter grouping
  hygiene/             scopes, bindings, environments, resolution
  pattern/             pattern AST, compiler, matcher, captures
  template/            template AST, validation, instantiation
  macro-language/      parser for macro definitions and modules
  expansion/           phases, definition contexts, expansion engine
  enforestation/       syntax consumers and operator parsing
  printer/             TypeScript text, origin map, expansion trace
  typescript-host/     CompilerHost, diagnostics, maps, watch integration
  test-support/        fixture loader, assertions, generators
  cli/                 check, build, watch, expand, explain
fixtures/
  legacy/              preserved Sweet.js examples
  acceptance/          TypeScript-targeted requirements
  conformance/         language-rule fixtures
benchmarks/
  corpora/
  scenarios/
docs/
```

Each package MUST expose its public API through `src/index.ts`. Code outside a
package MUST NOT import another package's internal path.

## 2. Dependency graph

```text
shared
  ^
  |-- syntax <- reader
  |      ^
  |      |-- hygiene
  |      |-- pattern <- macro-language
  |      |-- template <- macro-language
  |      |-- enforestation
  |      |-- printer
  |
  `-- expansion <- pattern, template, hygiene, enforestation
          |
          v
      typescript-host <- printer
          |
          v
         cli
```

`pattern`, `template`, and `hygiene` MUST NOT depend on TypeScript compiler AST
types. `typescript-host` owns the dependency on the official `typescript`
package. `reader` MAY use public scanner APIs through a version adapter, but its
public syntax types remain independent.

Cycles between packages are forbidden. `expansion` supplies callbacks to
`enforestation`; `enforestation` does not import the expansion implementation.

## 3. Pipeline states

```ts
type SourceInput = {
  sourceId: SourceId;
  fileName: string;
  text: string;
  version: string;
};

type ReadFile = {
  source: SourceInput;
  root: RootSyntax;
  diagnostics: readonly Diagnostic[];
};

type PreparedModule = {
  file: ReadFile;
  runtimeImports: readonly ImportEdge[];
  macroImports: readonly MacroImportEdge[];
  definitions: readonly MacroDefinitionSyntax[];
};

type ExpandedFile = {
  root: RootSyntax;
  macroDependencies: readonly MacroDependency[];
  diagnostics: readonly Diagnostic[];
  trace: ExpansionTrace;
};

type PrintedFile = {
  text: string;
  originMap: OriginMap;
  trace: ExpansionTrace;
};
```

The compiler MUST keep stages distinct. A stage can return diagnostics with a
partial result when later work can improve the user's error report. Fatal reader
corruption stops expansion for that file.

## 4. Core package APIs

### Reader

```ts
interface Reader {
  read(input: SourceInput, options: ReaderOptions): ReadFile;
  update(
    previous: ReadFile,
    input: SourceInput,
    change: TextChangeRange,
    options: ReaderOptions,
  ): ReadFile;
}
```

The first milestone MAY implement `update` through a full read. The result MUST
match a clean read.

A delimiter that opens deeper than the nesting-depth limit is not grouped: it,
what it holds and what closes it are read as the tokens they are, and `SWR1004`
is reported where the first of them opens. The file is still read whole, and no
tree read from it is deeper than the limit, so nothing that reads one recurses
deeper than that.

### Pattern compiler and matcher

```ts
interface PatternCompiler {
  compile(definition: PatternDefinition): Result<PatternProgram, Diagnostic[]>;
}

interface Matcher {
  match(
    program: PatternProgram,
    cursor: SyntaxCursor,
    context: MatchContext,
  ): MatchResult;
}

type MatchResult =
  | { kind: "matched"; captures: CaptureRecord; rest: SyntaxCursor }
  | { kind: "failed"; failure: MatchFailure };
```

### Template engine

```ts
interface TemplateEngine {
  validate(
    template: TemplateDefinition,
    patternShape: CaptureShape,
  ): Result<TemplateProgram, Diagnostic[]>;

  instantiate(
    program: TemplateProgram,
    captures: CaptureRecord,
    context: TemplateContext,
  ): Result<SyntaxSequence, Diagnostic[]>;
}
```

### Expansion engine

```ts
interface Expander {
  expandFile(module: PreparedModule, context: ProjectContext): ExpandedFile;
  expandOne(
    cursor: SyntaxCursor,
    category: SyntaxCategory,
    context: ExpansionContext,
  ): ExpandOneResult;
}
```

### Syntax consumer

```ts
interface SyntaxConsumer {
  readonly category: SyntaxCategory;
  consume(cursor: SyntaxCursor, context: ConsumeContext): ConsumeResult;
}

type ConsumeResult =
  | { kind: "consumed"; syntax: ProtectedSyntax; rest: SyntaxCursor }
  | { kind: "no-match"; failure: ConsumeFailure }
  | { kind: "error"; diagnostics: readonly Diagnostic[] };
```

### Printer

```ts
interface SyntaxPrinter {
  print(file: ExpandedFile, options: PrintOptions): PrintedFile;
}
```

## 5. Ownership and mutability

- Source text belongs to `SourceInput` and remains immutable.
- Green syntax nodes remain immutable and contain no parent pointer.
- `SyntaxCursor` owns traversal state and MUST NOT mutate syntax.
- Scope sets remain interned immutable values.
- Environments use persistent parent links or persistent maps.
- Match captures remain immutable after a successful match.
- Trace collectors may use local mutation during one expansion, then freeze their
  output.
- TypeScript AST values do not cross into syntax, pattern, template, or hygiene
  package APIs.

## 6. Error and cancellation model

All public compiler operations accept a `CancellationToken` and `ResourceBudget`.
Library packages return structured errors; they MUST NOT print or terminate the
process. The CLI owns rendering and process exit codes.

```ts
interface ResourceBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxExpansionSteps: number;
  maxTemplateSteps: number;
  maxMatcherSteps: number;
  maxNestingDepth: number;
  deadlineMs: number | undefined;
}
```

Each loop that depends on source size, pattern choices, or expansion recursion
MUST charge the relevant counter.

## 7. Cache boundaries

### Reader cache key

`hash(source text, reader version, lexical options)`

### Macro-module cache key

`hash(module source, macro-language version, direct macro dependency hashes,
compiler feature flags)`

### File-expansion cache key

`hash(read tree, invoked macro export hashes, expansion options, language
version)`

The file cache MUST record invoked macro bindings, not every visible macro. A
change to an unused imported macro SHOULD preserve the expansion result when the
module export hash permits member-level invalidation.

Cached values include diagnostics, origin maps, and traces required for tooling.

## 8. Diagnostics ownership

| Code range | Owner                                    |
| ---------- | ---------------------------------------- |
| `SWR1xxx`  | reader and syntax                        |
| `SWR2xxx`  | pattern and macro definition validation  |
| `SWR3xxx`  | hygiene and binding contracts            |
| `SWR4xxx`  | expansion and enforestation              |
| `SWR5xxx`  | modules and phases                       |
| `SWR6xxx`  | TypeScript host and map composition      |
| `SWR7xxx`  | resource limits and internal consistency |

Each diagnostic has a stable code, stage, severity, primary origin, related
origins, message arguments, and optional expansion stack. Tests assert codes and
structured fields before rendered text.

## 9. Configuration

```ts
interface SweetCompilerOptions {
  languageVersion: string;
  typescriptVersionPolicy: "exact" | "compatible-minor";
  macroExtensions: readonly string[];
  allowCoreShadowing: boolean;
  trace: "off" | "errors" | "full";
  limits: Partial<ResourceBudget>;
}
```

`tsconfig` integration reads an optional `sweet` object. Unknown keys produce a
diagnostic. Configuration hashing includes options that can change expansion.

## 10. Initial technology decisions

- TypeScript with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- ESM packages and project references.
- Vitest 4.1.10, selected in ADR-0001.
- A benchmark runner that emits JSON samples and environment metadata.
- No runtime schema dependency in compiler hot paths unless measurement supports
  it.

## 11. Architecture conformance tests

- import-boundary lint rejects internal package imports and cycles;
- public API type tests detect accidental exports;
- clean and incremental reader APIs return equivalent trees;
- cancellation interrupts reader, matcher, expansion, and project operations;
- cache serialization round-trips versioned values;
- each diagnostic code has one registered owner and documentation entry.
