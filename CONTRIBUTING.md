# Contributing

Sweetener requires Node.js 24 or newer and pnpm 11.18.0.

```bash
pnpm install
pnpm build
pnpm test
```

Run the [browser playground](https://sweetener-ts.github.io/sweetener/) locally:

```bash
pnpm playground
```

## The gate

`pnpm check` is what CI runs, and it is the contract for a change:

```bash
pnpm check
```

It formats, lints, type-checks, runs the unit suite, enforces the package
boundaries and the declarative acceptance boundary, validates the acceptance
ledger and the release specification, scaffolds a project and builds it, runs
the external sample projects, builds every example and the
[playground](https://sweetener-ts.github.io/sweetener/), stages
and verifies the alpha release, and regenerates the status snapshot.

Check two things before you trust a red result:

- The benchmark scenarios are too small to measure under full-suite load on
  most machines. If `pnpm benchmark:check` reports a regression during a full
  run, reproduce it on its own several times before you believe it.
- The reader's per-character scaling test has the same problem. It compares two
  file sizes rather than a wall clock, and parallel load still pushes it over
  its threshold.

## Layout

`packages/` holds the compiler as layers (syntax, reader, pattern, hygiene,
template, enforestation, expansion, printer, typescript-host), the command
line, and one package per build-tool integration. `check:boundaries` decides
which layer may import which. It reads the workspace rather than the registry,
so the rule holds whether or not a layer ships under its own name. Most do not:
eleven of them ship inside `@sweetener/compiler`, and
`scripts/release-packages.mjs` holds that division.

`fixtures/` holds the executable corpus, `examples/` a project per host, and
`docs/specifications/` the normative language and release surface.

## Worktrees

Put git worktrees under `.worktrees/`, which is already ignored.
