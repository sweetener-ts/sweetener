# Benchmark baselines

One file per Node major. `pnpm benchmark:check` picks the one matching the
running runtime and refuses to compare across majors.

A baseline is a measurement, so it is only worth what the conditions it was
taken under are worth. Record the conditions here whenever a file is replaced:
the commit, whether the worktree was clean, the one-minute load average, and
which measurement protocol was in force. `pnpm benchmark:check` now reads the
first three out of the file itself and warns when they make a pass weak
evidence, so what is written here is the account rather than the whole record.

A scenario with no row in the baseline **fails** the check: an unmeasured
scenario is not a passing one, and a new scenario used to stay unguarded until
somebody happened to re-record. Pass `--allow-unmeasured` while a baseline is
being brought up to date, and not otherwise. The protocol matters as much as the
hardware — numbers taken before per-scenario process isolation are not
comparable with numbers taken after it, because every scenario but the first
used to inherit the heap its predecessors left behind.

## `node26.json`

- **This file includes an open regression.** `expansion/project-scale` and
  `expansion/threading-end-to-end` cost +24% and +25% per unit of work against
  `ab7c214`, the previous reference, and this file was recorded after them, so
  the check no longer reports them. `handoff.md` ("Performance") records where
  the cost comes from. The previous file could not stay as the reference: it
  ran every scenario in one process, so its numbers are not comparable with the
  per-process runs below.
- Recorded 2026-10-16 at commit `d0d36e6`, on a **clean** worktree.
- Apple M2 Max, 12 logical CPUs, 64 GiB, macOS 25.5.0, Node 26.5.0, exposed GC.
- One-minute load average 5.10 on 12 CPUs, under the runner's warning
  threshold of 6. The machine was not idle: other work it was running could
  not be stopped, so the run was started only once the load fell below 4, and
  a run whose recorded load ended above 6 was discarded.
- Protocol: one process per scenario (the runner's default isolation), all
  twenty-one scenarios.
- Checked against itself straight afterwards, at a load near 6, the same
  commit failed on two rows, each past both the 15 percent and the 2 ms
  tolerance: `expansion/macro-environment` p95 +23 percent (19.6 to 24.1 ms)
  and `matcher/dense-choice` p50 +17 percent (51.7 to 60.6 ms). Other rows
  moved by as much without failing, under the 2 ms floor
  (`hygiene/union-older-into-newer` p50 -15 percent). On this machine a
  failure of that size from a loaded run says more about the machine than the
  change: re-run idle before reading it as a regression.

## `node24.json`

- Recorded 2026-10-16 at commit `d0d36e6`, on a **clean** worktree, Node
  24.18.1 (the version CI pins), same machine, same protocol, all twenty-one
  scenarios.
- One-minute load average 5.98 on 12 CPUs, just under the threshold. Four
  earlier attempts were discarded for ending above 6. Treat it as the
  `node26.json` file above: a loaded-machine measurement, so a pass is real
  but a marginal failure is weak evidence.

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
