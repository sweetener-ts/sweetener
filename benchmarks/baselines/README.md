# Benchmark baselines

One file per Node major. `pnpm benchmark:check` picks the one matching the
running runtime and refuses to compare across majors.

A baseline is a measurement, so it is only worth what the conditions it was
taken under are worth. Record the conditions here whenever a file is replaced:
the commit, whether the worktree was clean, the one-minute load average, and
which measurement protocol was in force. The protocol matters as much as the
hardware — numbers taken before per-scenario process isolation are not
comparable with numbers taken after it, because every scenario but the first
used to inherit the heap its predecessors left behind.

## `node26.json`

- Recorded 2026-09-06 at commit `8a08744`, on a **dirty** worktree.
- Apple M2 Max, 12 logical CPUs, 64 GiB, macOS 25.5.0, Node 26.5.0, exposed GC.
- One-minute load average 6.82 on 12 CPUs, which is above the runner's own
  warning threshold. The runner would have printed its "treat this run as
  provisional" warning while recording it.
- Protocol: **all fourteen scenarios in one process**. `cache/…` ran first and
  `reader/…` last, so every row after the first carries some of the heap its
  predecessors left. `expansion/project-scale` in particular inflated the rows
  behind it — `hygiene/fresh-scopes` by about 12 percent and
  `matcher/dense-choice` by about 27 percent when measured against the same
  scenario run alone.

Both of those make the file a lenient reference rather than a false-alarming
one: a row recorded too slow lets a real regression of the same size through.
Treat a pass on the rows after the first as weaker evidence than a failure.

## `node24.json`

- Recorded 2026-08-03 at commit `fbd8512`, on a **dirty** worktree, Node
  24.18.1, same machine. Predates the `loadAverage` field, so the conditions it
  was taken under are unrecorded, and predates `expansion/project-scale`, which
  therefore has no row to compare against.
- Protocol: all scenarios in one process, as above.

The repository supports Node 24, but development runs on Node 26, so this file
has not been re-recorded alongside `node26.json`. Re-record it from a Node 24
runtime before relying on it.

## Recording

On an idle machine and a clean worktree:

```sh
pnpm build
node --expose-gc scripts/run-benchmarks.mjs --output benchmarks/baselines/node26.json
```

The run must not print the load-average warning. A baseline recorded to make a
failing check pass is worse than no baseline: it launders a regression into the
reference. Re-record when the hardware, the runtime, or the measurement
protocol changes, and say so above.
