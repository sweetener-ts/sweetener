# Project Status

Updated: 2026-08-03  
Current phase: phase-07  
Current slice: Alpha release review and publication  
Health: green  
Repository commit: 3830de3

The declarative TypeScript macro compiler, command line, integrations, and alpha release are complete. Nine packages are published on npm under the alpha dist-tag at 0.1.0-alpha.0, with provenance signed from the release workflow.

## Current task

No task is in progress.

## Phase tasks

| Task | Title | Status | Prerequisites | Specification |
|---|---|---|---|---|
| [TLS-001](status/tasks/TLS-001.md) | Stabilize origin-query APIs | done | TSH-005 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#tls-001-stabilize-origin-query-apis) |
| [TLS-002](status/tasks/TLS-002.md) | Implement expand and explain | done | TSH-002, TLS-001 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#tls-002-implement-expand-and-explain) |
| [TLS-003](status/tasks/TLS-003.md) | Build virtual-file language-service host | done | TSH-003, TLS-001 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#tls-003-build-virtual-file-language-service-host) |
| [TLS-004](status/tasks/TLS-004.md) | Map diagnostics, hover, and definitions | done | TLS-003 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#tls-004-map-diagnostics-hover-and-definitions) |
| [TLS-005](status/tasks/TLS-005.md) | Implement references and safe rename | done | TLS-004, HYG-004 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#tls-005-implement-references-and-safe-rename) |
| [PRF-001](status/tasks/PRF-001.md) | Add benchmark runner and baselines | done | RDR-007, TSH-007 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#prf-001-add-benchmark-runner-and-baselines) |
| [PRF-002](status/tasks/PRF-002.md) | Profile and optimize hot paths | done | PRF-001 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#prf-002-profile-and-optimize-hot-paths) |
| [REL-001](status/tasks/REL-001.md) | Run compatibility matrix | done | TSH-008 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#rel-001-run-compatibility-matrix) |
| [REL-002](status/tasks/REL-002.md) | Publish language and package specifications | done | CMP-006, REL-001 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#rel-002-publish-language-and-package-specifications) |
| [REL-003](status/tasks/REL-003.md) | Validate external sample projects | done | TLS-005, PRF-002 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#rel-003-validate-external-sample-projects) |
| [REL-004](status/tasks/REL-004.md) | Produce alpha release | done | REL-002, REL-003 | [phase-07-tooling-release.md](docs/tasks/phase-07-tooling-release.md#rel-004-produce-alpha-release) |

## Capability status

- [x] FOUNDATION-DOCS: Implementation specifications
- [x] FOUNDATION-TASKS: Dependency-ordered task backlog
- [x] FOUNDATION-STATUS: Inspectable project status
- [x] FOUNDATION-WORKSPACE: Buildable package workspace
- [x] FOUNDATION-FIXTURES: Executable fixture harness
- [x] SYNTAX-PRIMITIVES: Immutable syntax representation
- [x] SYNTAX-ORIGINS: Interned origin graph
- [x] SYNTAX-CURSORS: Checkpointed syntax traversal
- [x] READER-SCANNER: Lossless TypeScript scanner adapter
- [x] READER-TEMPLATES: Template lexical modes
- [x] READER-JSX: JSX lexical modes
- [x] READER-TREES: Immutable delimiter trees with recovery
- [x] READER-LOSSLESS-PRINT: Byte-exact syntax printing
- [x] READER-INCREMENTAL-BASELINE: Clean-equivalent update API
- [x] READER-BENCHMARK: Reader corpus and performance baseline
- [x] PATTERN-AST: Declarative pattern and capture IR
- [x] MACRO-DEFINITION-PARSER: Structural declarative definition parser
- [x] PATTERN-SHAPE-VALIDATION: Capture-shape inference and validation
- [x] PATTERN-MATCHER-COMPILER: Deterministic matcher-program compiler
- [x] PATTERN-MATCHER-VM: Checkpointed matcher virtual machine
- [x] PATTERN-FAILURES-MEMOIZATION: Matcher failure ranking and memoization
- [x] PATTERN-USER-SYNTAX-CLASSES: User syntax-class compilation and execution
- [x] PATTERN-REFINEMENTS: Fixed declarative refinement IR and evaluation
- [x] PATTERN-STRUCTURAL-PORTS: Structural playground fixture ports
- [x] HYGIENE-SCOPE-STORE: Interned hygiene scope store
- [x] HYGIENE-BINDING-ENVIRONMENTS: Persistent binding environments
- [x] HYGIENE-INVOCATION-SCOPE-MODEL: Macro introduction and use-site scope model
- [x] HYGIENE-BINDING-RESOLUTION: Binding resolution and ambiguity diagnostics
- [x] TEMPLATE-PARSING: Declarative template parsing and validation
- [x] TEMPLATE-REPETITION-CONDITIONALS: Template repetition and conditionals
- [x] TEMPLATE-DECLARATIVE-OPERATIONS: Finite declarative template hygiene operations
- [x] TEMPLATE-INSTANTIATION: Hygienic template instantiation
- [x] HYGIENE-BINDING-CONTRACTS: Declarative binding contracts
- [x] HYGIENE-NAME-ASSIGNMENT: Deterministic printed name assignment
- [x] TEMPLATE-HYGIENE-CONFORMANCE: End-to-end hygiene conformance fixtures
- [x] EXPANSION-ENVIRONMENTS: Persistent expansion environments
- [x] EXPANSION-DEFINITION-CONTEXTS: Source-ordered definition contexts
- [x] ENFORESTATION-CONSUMER-INFRASTRUCTURE: Checkpointed syntax-consumer infrastructure
- [x] ENFORESTATION-PRIMARY-CALLS: Primary and call expression consumption
- [x] ENFORESTATION-PRATT-EXPRESSIONS: Pratt expression parser with macro operators
- [x] EXPANSION-MACRO-INVOCATION: Transactional macro invocation
- [x] EXPANSION-PROGRESS-RESOURCE-CHECKS: Expansion termination and resource enforcement
- [x] ENFORESTATION-STATEMENTS-ITEMS: Statement and item consumers
- [x] ENFORESTATION-BINDINGS-PARAMETERS: Binding and parameter consumers
- [x] ENFORESTATION-TYPES-CLASS-ELEMENTS: Type and class-element consumers
- [x] ENFORESTATION-STATEMENT-PREFIX-FINAL-EXPRESSION: Statement-prefix and final-expression composition
- [x] EXPANSION-CORE-SHADOWING: Explicit lexical core-form shadowing
- [x] EXPANSION-DO-NOTATION: Declarative do-notation vertical slice
- [x] COMPOSITION-LOCAL-RECURSIVE-SYNTAX: Recursive and local syntax bindings
- [x] COMPOSITION-GENERATED-DEFINITIONS: Checked generated declarative definitions
- [x] COMPOSITION-CUSTOM-OPERATORS: Declarative lexical custom operators
- [x] COMPOSITION-MIXFIX: Declarative mixfix composition
- [x] PLAYGROUND-THREADING-EXECUTABLE: Executable threading acceptance family
- [x] PLAYGROUND-IMPLICIT-RETURN-EXECUTABLE: Executable implicit-return acceptance family
- [x] PLAYGROUND-OPERATORS-EXECUTABLE: Executable custom-operators acceptance family
- [x] PLAYGROUND-REWRITTEN-IF-EXECUTABLE: Executable rewritten-if acceptance family
- [x] PLAYGROUND-CURRYING-EXECUTABLE: Executable currying acceptance family
- [x] PLAYGROUND-CORE-REWRITES-EXECUTABLE: Executable core-rewrites acceptance family
- [x] PLAYGROUND-ADT-EXECUTABLE: Executable ADT and match acceptance family
- [x] PLAYGROUND-PROTOCOLS-EXECUTABLE: Executable protocols acceptance family
- [x] PLAYGROUND-CSP-EXECUTABLE: Executable CSP acceptance family
- [x] PLAYGROUND-MULTI-PART-METHODS-EXECUTABLE: Executable generated multi-part methods family
- [x] PLAYGROUND-NEW-LANGUAGE-EXECUTABLE: Executable combined new-language family
- [x] COMPOSITION-DECLARATIVE-BOUNDARY: CI-enforced declarative acceptance boundary
- [x] TYPESCRIPT-HOST-MODULE-RESOLUTION: Deterministic macro-module manifests and dependency graphs
- [x] TYPESCRIPT-HOST-GENERATED-PRINTING: Deterministic hygienic generated TypeScript and origin maps
- [x] TYPESCRIPT-HOST-COMPILER-HOST: Official TypeScript checking and artifact emission over virtual files
- [x] TYPESCRIPT-HOST-DIAGNOSTIC-REMAP: Origin-aware TypeScript diagnostic remapping
- [x] TYPESCRIPT-HOST-SOURCE-MAPS: Composed JavaScript and declaration source maps
- [x] TYPESCRIPT-HOST-CACHES: Content-addressed caches and dependency invalidation
- [x] TYPESCRIPT-HOST-CLI: Typed check, build, and watch project commands
- [x] TYPESCRIPT-HOST-INCREMENTAL-EQUIVALENCE: Clean and incremental multi-project equivalence
- [x] TOOLING-ORIGIN-QUERIES: Bidirectional origin and invocation queries
- [x] TOOLING-EXPAND-EXPLAIN: Expanded source and structured macro explanations
- [x] TOOLING-LANGUAGE-SERVICE-HOST: Mutable official TypeScript language service over virtual files
- [x] TOOLING-MAPPED-READS: Origin-aware diagnostics, hover, and definitions
- [x] TOOLING-SAFE-RENAME: Binding-aware references and semantics-preserving rename
- [x] PERFORMANCE-BENCHMARK-PROTOCOL: Reproducible benchmark reports and regression baselines
- [x] PERFORMANCE-HOT-PATHS: Profile-backed compiler hot-path optimizations
- [x] RELEASE-COMPATIBILITY-MATRIX: Executable Node and TypeScript compatibility matrix
- [x] RELEASE-PUBLIC-SPECIFICATIONS: Normative language, format, package, security, and migration specifications
- [x] RELEASE-EXTERNAL-SAMPLES: Independent project, declarative macro, runtime, and editor validation

## Validation

| Check | Result | Commit |
|---|---|---|
| unit | 1215 passed | 3830de3 |

## Decisions requiring review

None.

## Blockers

None.

## Next tasks

1. [REL-004](status/tasks/REL-004.md) Produce alpha release: Published to npm under the alpha dist-tag at v0.1.0-alpha.0, with provenance signed from the release workflow. Verified by installing from the registry into projects created from scratch.

## Navigation

- [Review queue](status/REVIEW.md)
- [Work log](status/WORKLOG.md)
- [Start implementation](docs/tasks/START-HERE.md)
- [Task index](docs/tasks/README.md)
- [Specifications](docs/specifications/README.md)

This file is generated from `status/state.json`, `status/review.json`, and machine-readable reports under `artifacts/`.

