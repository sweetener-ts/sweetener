import { performance } from "node:perf_hooks";
import { cpus, loadavg, release, totalmem } from "node:os";

export interface BenchmarkScenario {
  readonly id: string;
  readonly description: string;
  readonly run: () =>
    | void
    | Readonly<Record<string, number>>
    | Promise<void | Readonly<Record<string, number>>>;
}

export interface BenchmarkSample {
  readonly durationMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
  readonly heapBeforeBytes: number;
  readonly heapAfterBytes: number;
  readonly retainedHeapDeltaBytes: number;
  readonly counters: Readonly<Record<string, number>>;
}

export interface BenchmarkStatistics {
  readonly samples: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

/**
 * How much work one sample of a scenario did, so a duration can be quoted per
 * unit of it.
 */
export interface BenchmarkWorkload {
  /** The counter the scenario reported, for example `bytes`. */
  readonly counter: string;
  /** Its median across the measured samples. */
  readonly units: number;
  /** The singular noun a per-unit cost is quoted in, for example `byte`. */
  readonly unit: string;
}

export interface BenchmarkResult {
  readonly id: string;
  readonly description: string;
  readonly warmups: number;
  readonly statistics: BenchmarkStatistics;
  /**
   * The counter a comparison will divide by, when the scenario reports one.
   * Recording it makes a stored report say on its face whether it can be
   * compared per unit of work or only as wall clock.
   */
  readonly workload?: BenchmarkWorkload | undefined;
  readonly rawSamples: readonly BenchmarkSample[];
}

export interface BenchmarkEnvironment {
  readonly platform: NodeJS.Platform;
  readonly release: string;
  readonly architecture: string;
  readonly cpu: string;
  readonly logicalCpus: number;
  readonly totalMemoryBytes: number;
  /**
   * One-minute load average when the samples were taken. Timings on a busy
   * machine move far more between runs than most real regressions do, so a
   * reader can tell whether a number deserves to be trusted.
   */
  readonly loadAverage: number;
  readonly node: string;
  readonly typescript: string;
  readonly gcExposed: boolean;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly command: string;
  readonly environment: BenchmarkEnvironment;
  readonly results: readonly BenchmarkResult[];
}

/**
 * What a comparison's numbers mean.
 *
 * Two scenarios read this repository's own sources, so their workload grows
 * with every commit and a wall-clock comparison against a stored baseline
 * measures how much the repository grew rather than how fast it is. When both
 * sides report the same workload counter the comparison divides by it and
 * speaks in cost per unit; otherwise it stays on wall clock.
 */
export type BenchmarkComparisonBasis =
  | { readonly kind: "duration"; readonly unit: "ms" }
  | {
      readonly kind: "per-unit";
      /** For example `ns/byte`. */
      readonly unit: string;
      readonly counter: string;
      readonly baselineUnits: number;
      readonly candidateUnits: number;
    };

export interface BenchmarkRegression {
  readonly scenario: string;
  readonly metric: "p50Ms" | "p95Ms" | "p99Ms";
  /** What `baseline`, `candidate` and `allowedAbsoluteChange` are counted in. */
  readonly basis: BenchmarkComparisonBasis;
  readonly baseline: number;
  readonly candidate: number;
  /** The measured percentiles, in milliseconds, whatever the basis. */
  readonly baselineMs: number;
  readonly candidateMs: number;
  readonly relativeChange: number;
  readonly allowedRelativeChange: number;
  /** The absolute budget expressed in `basis.unit`. */
  readonly allowedAbsoluteChange: number;
  /** The absolute budget as configured, in milliseconds. */
  readonly allowedAbsoluteChangeMs: number;
}

/**
 * Counter names that measure how much work a scenario did, paired with the
 * noun a per-unit cost is quoted in. The order is the comparison's preference:
 * a scenario reporting both `bytes` and `tokens` is compared per byte, which
 * is the unit the reader and printer corpora are sized in.
 *
 * Only sizes belong here. `hits`, `internedSets` and `instructions` are
 * outcomes or program sizes rather than amounts of work, and a cost per one of
 * those would measure nothing.
 */
const workloadCounters: readonly (readonly [string, string])[] = Object.freeze([
  ["bytes", "byte"],
  ["tokens", "token"],
  ["operations", "operation"],
  ["matches", "match"],
  ["invocations", "invocation"],
  ["entries", "entry"],
  ["regions", "region"],
  ["queries", "query"],
  ["files", "file"],
  ["updates", "update"],
] as const);

const durationBasis: BenchmarkComparisonBasis = Object.freeze({
  kind: "duration",
  unit: "ms",
});

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ]!;
}

export function summarizeDurations(
  values: readonly number[],
): BenchmarkStatistics {
  if (values.length === 0)
    throw new RangeError("Benchmark requires measured samples");
  if (values.some((value) => !Number.isFinite(value) || value < 0))
    throw new RangeError("Benchmark durations must be finite and non-negative");
  return Object.freeze({
    samples: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
  });
}

function workloadFromSamples(
  samples: readonly BenchmarkSample[],
): BenchmarkWorkload | undefined {
  if (samples.length === 0) return undefined;
  for (const [counter, unit] of workloadCounters) {
    const values: number[] = [];
    for (const sample of samples) {
      const value = sample.counters[counter];
      if (value === undefined || !Number.isFinite(value) || value <= 0) break;
      values.push(value);
    }
    // A counter only one sample happened to report, or one that reached zero,
    // cannot size the whole run. Dividing by it would invent a rate.
    if (values.length !== samples.length) continue;
    return Object.freeze({
      counter,
      units: percentile(values, 0.5),
      unit,
    });
  }
  return undefined;
}

/**
 * The workload a result can be normalized by: the one it recorded, or the one
 * its raw samples imply. Reports written before results carried a workload
 * still compare per unit, because their samples still carry the counters.
 */
export function benchmarkWorkload(
  result: BenchmarkResult,
): BenchmarkWorkload | undefined {
  return result.workload ?? workloadFromSamples(result.rawSamples);
}

export function benchmarkComparisonBasis(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
): BenchmarkComparisonBasis {
  const before = benchmarkWorkload(baseline);
  const after = benchmarkWorkload(candidate);
  // Different counters describe different work, and a ratio between them means
  // nothing, so only a matched pair normalizes.
  if (
    before === undefined ||
    after === undefined ||
    before.counter !== after.counter
  )
    return durationBasis;
  return Object.freeze({
    kind: "per-unit",
    unit: `ns/${after.unit}`,
    counter: after.counter,
    baselineUnits: before.units,
    candidateUnits: after.units,
  });
}

export function selectBenchmarkScenarios(
  scenarios: readonly BenchmarkScenario[],
  selected: readonly string[] = [],
): readonly BenchmarkScenario[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  if (byId.size !== scenarios.length)
    throw new RangeError("Duplicate benchmark scenario ID");
  const ids =
    selected.length === 0 ? [...byId.keys()].sort() : [...new Set(selected)];
  return Object.freeze(
    ids.map((id) => {
      const scenario = byId.get(id);
      if (scenario === undefined)
        throw new RangeError(`Unknown benchmark scenario ${id}`);
      return scenario;
    }),
  );
}

export async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  options: {
    readonly warmups: number;
    readonly samples: number;
    readonly now?: () => number;
    readonly cpuUsage?: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage;
    readonly heapUsed?: () => number;
    readonly collectGarbage?: (() => void) | undefined;
  },
): Promise<BenchmarkResult> {
  if (!Number.isSafeInteger(options.warmups) || options.warmups < 0)
    throw new RangeError("Benchmark warmups must be a non-negative integer");
  if (!Number.isSafeInteger(options.samples) || options.samples < 5)
    throw new RangeError("Benchmark reports require at least five samples");
  for (let index = 0; index < options.warmups; index += 1) await scenario.run();
  const now = options.now ?? performance.now.bind(performance);
  const cpuUsage = options.cpuUsage ?? process.cpuUsage.bind(process);
  const heapUsed = options.heapUsed ?? (() => process.memoryUsage().heapUsed);
  const rawSamples: BenchmarkSample[] = [];
  for (let index = 0; index < options.samples; index += 1) {
    options.collectGarbage?.();
    const heapBeforeBytes = heapUsed();
    const cpuBefore = cpuUsage();
    const start = now();
    const counters = (await scenario.run()) ?? {};
    const durationMs = now() - start;
    const cpu = cpuUsage(cpuBefore);
    options.collectGarbage?.();
    const heapAfterBytes = heapUsed();
    rawSamples.push(
      Object.freeze({
        durationMs,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        heapBeforeBytes,
        heapAfterBytes,
        retainedHeapDeltaBytes: heapAfterBytes - heapBeforeBytes,
        counters: Object.freeze({ ...counters }),
      }),
    );
  }
  return Object.freeze({
    id: scenario.id,
    description: scenario.description,
    warmups: options.warmups,
    statistics: summarizeDurations(
      rawSamples.map(({ durationMs }) => durationMs),
    ),
    workload: workloadFromSamples(rawSamples),
    rawSamples: Object.freeze(rawSamples),
  });
}

export function benchmarkEnvironment(
  typescriptVersion: string,
): BenchmarkEnvironment {
  const processors = cpus();
  return Object.freeze({
    platform: process.platform,
    release: release(),
    architecture: process.arch,
    cpu: processors[0]?.model ?? "unknown",
    logicalCpus: processors.length,
    totalMemoryBytes: totalmem(),
    loadAverage: loadavg()[0] ?? 0,
    node: process.version,
    typescript: typescriptVersion,
    gcExposed: typeof globalThis.gc === "function",
  });
}

export function compareBenchmarkReports(options: {
  readonly baseline: BenchmarkReport;
  readonly candidate: BenchmarkReport;
  readonly allowedRelativeChange: number;
  readonly allowedAbsoluteChangeMs: number;
}): readonly BenchmarkRegression[] {
  const baseline = new Map(
    options.baseline.results.map((result) => [result.id, result]),
  );
  const regressions: BenchmarkRegression[] = [];
  for (const candidate of options.candidate.results) {
    const previous = baseline.get(candidate.id);
    if (previous === undefined) continue;
    const basis = benchmarkComparisonBasis(previous, candidate);
    // Nanoseconds per unit keeps a normalized cost in numbers a reader can
    // hold: 176 ns/byte rather than 0.000176 ms/byte.
    const perUnit = (durationMs: number, units: number) =>
      (durationMs * 1e6) / units;
    const inBasis = (durationMs: number, units: number) =>
      basis.kind === "per-unit" ? perUnit(durationMs, units) : durationMs;
    // The relative budget survives normalization unchanged, but the absolute
    // one does not: two milliseconds of slack for a scenario is two
    // milliseconds spread over the work it does, so it converts at the
    // baseline's own size. On a scenario whose workload has not moved this is
    // exactly the old test; on one that has, the slack stays anchored to the
    // run the baseline recorded instead of growing with the corpus.
    const allowedAbsoluteChange =
      basis.kind === "per-unit"
        ? perUnit(options.allowedAbsoluteChangeMs, basis.baselineUnits)
        : options.allowedAbsoluteChangeMs;
    // A percentile the sample count cannot resolve is just the slowest sample:
    // at fifteen samples both p95 and p99 land on the maximum. Reporting each
    // of them turns one slow run into three regressions, so a metric that
    // repeats a coarser one is only counted once.
    const reported = new Set<number>();
    for (const metric of ["p50Ms", "p95Ms", "p99Ms"] as const) {
      const beforeMs = previous.statistics[metric];
      const afterMs = candidate.statistics[metric];
      if (reported.has(afterMs)) continue;
      reported.add(afterMs);
      const before = inBasis(
        beforeMs,
        basis.kind === "per-unit" ? basis.baselineUnits : 1,
      );
      const after = inBasis(
        afterMs,
        basis.kind === "per-unit" ? basis.candidateUnits : 1,
      );
      const absolute = after - before;
      const relative =
        before === 0
          ? after === 0
            ? 0
            : Number.POSITIVE_INFINITY
          : absolute / before;
      if (
        absolute > allowedAbsoluteChange &&
        relative > options.allowedRelativeChange
      )
        regressions.push(
          Object.freeze({
            scenario: candidate.id,
            metric,
            basis,
            baseline: before,
            candidate: after,
            baselineMs: beforeMs,
            candidateMs: afterMs,
            relativeChange: relative,
            allowedRelativeChange: options.allowedRelativeChange,
            allowedAbsoluteChange,
            allowedAbsoluteChangeMs: options.allowedAbsoluteChangeMs,
          }),
        );
    }
  }
  return Object.freeze(regressions);
}
