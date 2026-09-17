# Sweetener

Sweetener is a TypeScript-to-TypeScript macro expander. It adds hygienic,
declarative, syntax-extending macros to TypeScript while leaving type checking,
declaration generation, JavaScript emission, and editor semantics to the official
TypeScript compiler.

The project is in its research and design phase. No implementation choices in
these documents are permanent until the first vertical prototype tests them.

## Working documents

- [Research plan](docs/research-plan.md)
- [Sweet.js before and after its rewrite](docs/research/sweetjs.md)
- [Honu and Rhombus](docs/research/honu-rhombus.md)
- [TypeScript as the host compiler](docs/research/typescript-host.md)
- [Product requirements](docs/design/product-requirements.md)
- [Proposed architecture](docs/design/architecture.md)
- [Declarative macro language](docs/design/macro-language.md)
- [Testing and performance plan](docs/design/testing-performance.md)
- [Build-tool integrations](docs/integrations.md)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Phase proposals](docs/proposals/README.md)
- [Playground expressiveness review](docs/proposals/00-expressiveness-contract.md)
- [Normative implementation specifications](docs/specifications/README.md)
- [Dependency-ordered implementation tasks](docs/tasks/README.md)
- [Start implementation here](docs/tasks/START-HERE.md)
- [Requirements traceability](docs/tasks/traceability.md)
- [Status dashboard](STATUS.md)
- [Status and visibility workflow](docs/workflow/status-and-visibility.md)

## Current recommendation

Build a pre-TypeScript expansion pipeline:

```text
source text
  -> lossless TypeScript-aware reader
  -> delimiter token trees
  -> hygienic, context-directed macro expansion
  -> ordinary TypeScript plus source map
  -> official TypeScript compiler
```

The reader should preserve tokens, trivia, delimiters, source spans, and lexical
context. It should not reproduce the full TypeScript parser. Expansion should
request parsing only when a pattern uses a syntax class such as `expr`, `type`,
`stmt`, or `binding`. This follows the strongest shared lesson from Honu,
Sweet.js, and Rhombus: keep the first representation shallow, then interleave
macro expansion with the parsing needed by the current context.

## Decisions that need review

1. Use `.sts` as the opt-in source extension in the prototype, while allowing a
   build plugin to opt ordinary `.ts` files in later.
2. Require the declarative layer to express the complete playground corpus. An
   internal transformer interface may implement syntax consumers, but macro
   authors must not need it for the accepted examples.
3. Make macro expansion syntactic in version 1. A type-aware macro API would
   create an expansion/type-checking cycle and should require a separate design.
4. Emit canonical TypeScript, source maps, and an expansion trace. Treat all
   three as public compiler outputs.

## Playground input

The phase-planning pass reviewed the examples at
`/Users/jimmyhmiller/Documents/Code/PlayGround/sweetjs`. They define the
mandatory expressiveness contract in
[Phase 0](docs/proposals/00-expressiveness-contract.md). The project still needs
approved copies and expected TypeScript expansions under its own fixture tree.
