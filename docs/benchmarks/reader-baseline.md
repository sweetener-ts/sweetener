# Reader Baseline: 2026-08-02

Command: `pnpm benchmark:reader`

Definition: `benchmarks/reader.mjs`

Runner: `scripts/benchmark-reader.mjs`

Raw report: `artifacts/benchmarks/reader.json`

## Environment

- Apple M2 Max, 12 logical CPUs, 64 GiB memory
- macOS 25.5.0, arm64
- Node 26.5.0 with exposed GC
- TypeScript compatibility API 6.0.3
- commit `fbd8512` with a dirty worktree

The repository supports Node 24. Treat these Node 26 measurements as a local
prototype baseline. A pinned Node 24 runner must produce the regression
baseline in `PRF-001`.

## Results

| Workload              | Files | Bytes/sample | Tokens/sample | Diagnostics/sample | Median ms | p95 ms | MiB/s | Tokens/s |
| --------------------- | ----: | -----------: | ------------: | -----------------: | --------: | -----: | ----: | -------: |
| Macro-free TypeScript |    37 |      822,648 |       155,184 |                  0 |    248.13 | 251.83 |  3.16 |  625,402 |
| Playground syntax     |    13 |      380,940 |        93,960 |                 20 |    160.75 | 165.33 |  2.26 |  584,513 |
| TSX lexical modes     |     1 |       84,500 |        29,500 |                  0 |     56.04 |  57.24 |  1.44 |  526,418 |

The playground workload repeats its 13 files 20 times. One imported file,
`adt.sweet.js`, contains an unmatched parenthesis, so the reader emits one
`SWR1003` diagnostic per repetition. All source files print back to their input
bytes.

The macro-free TypeScript workload is this repository's own production sources,
so its size moves with every commit that adds code: the 37 files and 822,648
bytes above became 1.43 MB by September 2026. The millisecond columns are
therefore only readable next to the byte count of the same run, and only the
MiB/s and tokens/s columns are comparable across dates. The suite runner
normalizes for exactly this reason; see `docs/benchmarks/runner.md`.

## Method

Each workload runs three warmups and seven measured samples. Timed samples
include scanning, syntax construction, origin construction, grouping, and
diagnostics. Validation runs outside the timer and checks byte-exact printing
plus token counts.

The runner records process peak heap after each file and retained heap change
after forced GC. V8's sampling heap profiler records allocation samples at a
32,768-byte interval. The report stores sample arrays, environment data,
TypeScript version, commit, command, and dirty status.

## Budget result

All three workloads miss the provisional 25 MiB/s target. The macro-free
workload reaches 3.16 MiB/s. Phase 1 records this gap; it does not weaken the
target.

`PRF-001` should profile these costs first:

- source-origin string keys and per-token interning;
- repeated span, trivia-array, and syntax-array allocation;
- `Object.freeze` and defensive copies on hot constructors;
- TypeScript scanner setup for small files.

The next benchmark runner should split scanner, tree construction, origin
tracking, and printing times. That split will identify changes that improve
throughput without removing syntax data required by matching, hygiene, or
diagnostics.
