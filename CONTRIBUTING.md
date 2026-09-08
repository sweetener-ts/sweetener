# Contributing

Sweetener requires Node.js 24 or newer and pnpm 11.18.0.

```bash
pnpm install
pnpm build
pnpm test
```

Run the browser playground locally:

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
the external sample projects, builds every example and the playground, stages
and verifies the alpha release, and regenerates the status snapshot.

Two parts of it are worth knowing about before you trust a red result:

- The benchmark scenarios are too small to measure under full-suite load on
  most machines. A regression reported by `pnpm benchmark:check` during a full
  run should be reproduced in isolation, repeatedly, before it is believed.
- The reader's per-character scaling test is the same. It compares two file
  sizes rather than a wall clock, but heavy parallel load can still push it
  over its threshold.

## Layout

`packages/` holds the compiler as layers — syntax, reader, pattern, hygiene,
template, enforestation, expansion, printer, typescript-host — plus the command
line and one package per build-tool integration. `check:boundaries` enforces
which layer may import which, and it reads the workspace, so the rule holds
whether or not a layer is published separately. Most of them are not: eleven
ship inside `@sweetener/compiler`. `scripts/release-packages.mjs` holds that
division.

`fixtures/` holds the executable corpus, `examples/` a project per host, and
`docs/specifications/` the normative language and release surface.

## Worktrees

Put git worktrees under `.worktrees/`, which is already ignored.
