# Alpha known limitations

These are explicit gaps in the alpha release series, not unspecified behavior.

- The CLI installs a `sweetener` binary and a default project expansion
  provider. The current frontend resolves project-local relative and tsconfig
  path imports, including transitive modules, plus installed packages using the
  versioned `sweetMacros` manifest pointer.
- Diagnostics, hover, definitions, references, completions, and safe rename are
  mapped. Source formatting, semantic highlighting, and editor-protocol adapters
  are not included. Generated-only results use expansion view.
- `.sts` and `.stsx` require the Sweet host. Editors and tools that invoke stock
  TypeScript directly do not understand the syntax.
- TypeScript API support is limited to `6.0.x`; TypeScript 7 has no supported
  programmatic host API. Node support starts at 24.
- Macro execution is intentionally declarative. There is no procedural,
  type-aware, filesystem, network, environment, randomness, or dynamic-import
  macro API.
- The reader has a clean-equivalent update API but does not guarantee minimal
  subtree allocation for every edit. Cache invalidation is exact at the
  file/module dependency level proven by the equivalence suite.
- Performance reports are development-machine evidence. Published budgets need
  a stable pinned release runner before they become cross-machine promises.
- The repository stages and verifies tarballs locally; annotated release tags
  trigger registry publication through the release workflow.

Core matching, hygiene, origins, resource limits, deterministic caching, and
clean/incremental equivalence are not limitations; they are specified and tested
release behavior.
