# Unified benchmark protocol

Run the production suite with:

```sh
pnpm benchmark
```

The command builds the workspace and writes
`artifacts/benchmarks/suite.json`. Its versioned report records the commit and
dirty state, exact command, OS, CPU, memory, Node and TypeScript versions,
garbage-collector availability, warmups, and every raw measured sample. Each
sample includes wall time, user and system CPU, heap before and after, retained
heap delta, and workload counters. Summaries report mean, p50, p95, p99, and
range, plus the `workload` a comparison may divide by.

Scenarios are registered in `benchmarks/scenarios.mjs`. Select one or more for a
focused investigation:

```sh
pnpm benchmark -- --scenario reader/tsx-lexical-modes --samples 9
pnpm benchmark -- --scenario hygiene/persistent-add-chain --warmups 3
```

The runner rejects unknown scenario IDs, duplicate registered IDs, invalid
counts, and fewer than five measured samples. Warmups never appear in measured
statistics.

## One process per scenario

Each scenario runs in its own child process, spawned with this process's Node
flags so `--expose-gc` reaches it. Scenarios used to share one heap, and an
expensive early scenario then charged the ones behind it: with
`expansion/project-scale` ahead of them, `hygiene/fresh-scopes` measured 12
percent slow and `matcher/dense-choice` 27 percent slow in the suite, against 1
percent fast and 10 percent slow when each was measured alone. Scenarios run in
sorted order, so every row after `expansion/project-scale` — eleven of the
fourteen — was reading the heap the rows before it had left.

Isolation costs roughly half a second of process start and scenario setup per
scenario — about seven seconds across the fourteen — and it makes every row mean
the same thing regardless of what precedes it. `--isolation inline` restores the
old single-process behavior for debugging; its numbers depend on scenario order
and should not be recorded as a baseline.

## What is compared

Two scenarios — `reader/macro-free-typescript` and
`printer/macro-free-typescript` — read this repository's own production sources
as their corpus, so their workload grows with every commit that adds code. A
wall-clock comparison against a stored baseline then measures how much the
repository grew rather than how fast it is: between the recorded baseline and
September 2026 the corpus went from 1.09 MB to 1.43 MB, a 31 percent increase,
and both scenarios reported a "regression" of about that size while their cost
per byte was flat.

So the comparison normalizes. When a baseline row and a candidate row report
the same workload counter, they are compared as cost per unit of it, in
nanoseconds per unit; otherwise the comparison stays on wall clock in
milliseconds. `BenchmarkRegression.basis` records which of the two was used,
along with the counter and both sides' workload sizes, and the runner prints a
line per scenario naming the basis before it prints any failures.

The counter is chosen from the ones a scenario reports, in this preference
order: `bytes`, `tokens`, `operations`, `matches`, `invocations`, `entries`,
`regions`, `queries`, `files`, `updates`. Only sizes are eligible — `hits`,
`internedSets` and `instructions` are outcomes or program sizes, and a cost per
one of those would measure nothing. A counter must be present and positive in
every measured sample to be used.

Scenarios with a fixed synthetic workload are normalized by a constant, which
changes nothing about whether they pass; the normalization matters only where
the workload moves.

Cost per unit is only a fair comparison where cost is close to linear in the
workload, which is what the reader's corpus shows: it grew 31 percent between
the recorded baseline and September 2026 while its cost per byte moved by
−4 percent. A scenario whose cost grows faster than its input — and
`expansion/project-scale` exists precisely because per-project costs do — would
be flattered by normalization if its workload ever grew. Its workload is a
fixed 300 generated files, so today nothing is hidden; changing that constant
means the rows before and after are not comparable and the baseline should be
re-recorded rather than normalized across.

## Regression check

`benchmarks/baselines/node26.json` is the checked-in Node 26 development-machine
baseline, and `benchmarks/baselines/node24.json` the Node 24 one.
`--baseline auto` picks the file matching the running Node major and refuses to
compare across majors, because the same commit differs more between Node
versions than most real regressions do. Run the non-mutating comparison with:

```sh
pnpm benchmark:check
```

The default regression budget still requires **both** a relative change greater
than 15 percent and an absolute change greater than the absolute budget, so one
slow sample is not a failure. The absolute budget is configured in milliseconds
(2 ms by default) and converts into the comparison's basis at the _baseline's_
workload size: two milliseconds of slack for the run the baseline recorded. On
a scenario whose workload has not moved this is exactly the old test; on one
that has, the slack stays anchored to the recorded run instead of growing with
the corpus. `BenchmarkRegression` reports it both ways, as
`allowedAbsoluteChangeMs` and as `allowedAbsoluteChange` in `basis.unit`.

The check inspects p50, p95, and p99, and exits nonzero with structured
regression details. `--relative` and `--absolute-ms` exist for explicitly
documented experiments; comparison never rewrites the baseline.

## Recording a baseline

A baseline is only as good as the machine it was taken on. Record one with an
idle machine — the runner warns when the one-minute load average exceeds half
the logical CPU count, and a report that carries such a warning should not
become a baseline — and on a clean worktree, so `dirty` is false and the numbers
belong to a commit someone can check out:

```sh
pnpm build
node --expose-gc scripts/run-benchmarks.mjs --output benchmarks/baselines/node26.json
```

Each baseline file's provenance is in `benchmarks/baselines/README.md`: when it
was taken, on what, and under which protocol. A baseline taken before per-scenario
process isolation is not comparable with one taken after it.

This machine baseline proves the protocol and supplies an optimization
reference. Release automation must accept a fresh baseline on pinned hardware
before publishing performance claims.
