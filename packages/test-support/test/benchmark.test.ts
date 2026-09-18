import { describe, expect, test } from "vitest";
import {
  benchmarkComparisonBasis,
  benchmarkWorkload,
  compareBenchmarkReports,
  runBenchmarkScenario,
  selectBenchmarkScenarios,
  summarizeDurations,
  type BenchmarkReport,
  type BenchmarkResult,
} from "../src/index.js";

function report(
  id: string,
  p50Ms: number,
  p95Ms: number,
  p99Ms: number,
): BenchmarkReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    commit: "abc",
    dirty: false,
    command: "benchmark",
    environment: {
      platform: "linux",
      release: "test",
      architecture: "x64",
      cpu: "test",
      logicalCpus: 1,
      totalMemoryBytes: 1,
      loadAverage: 0.5,
      node: "v24",
      typescript: "6.0.2",
      gcExposed: false,
    },
    results: [
      {
        id,
        description: id,
        warmups: 1,
        statistics: {
          samples: 5,
          minMs: p50Ms,
          maxMs: p99Ms,
          meanMs: p50Ms,
          p50Ms,
          p95Ms,
          p99Ms,
        },
        rawSamples: [],
      },
    ],
  };
}

describe("benchmark runner", () => {
  test("selects scenarios deterministically and validates IDs", () => {
    const scenarios = [
      { id: "b", description: "b", run: () => undefined },
      { id: "a", description: "a", run: () => undefined },
    ];
    expect(selectBenchmarkScenarios(scenarios).map(({ id }) => id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      selectBenchmarkScenarios(scenarios, ["b"]).map(({ id }) => id),
    ).toEqual(["b"]);
    expect(() => selectBenchmarkScenarios(scenarios, ["missing"])).toThrow(
      /Unknown benchmark scenario/u,
    );
  });

  test("records warmups, raw CPU/heap samples, counters, and percentiles", async () => {
    let executions = 0;
    let time = 0;
    let heapCalls = 0;
    const result = await runBenchmarkScenario(
      {
        id: "reader",
        description: "reader",
        run: () => {
          executions += 1;
          return { tokens: 10 };
        },
      },
      {
        warmups: 2,
        samples: 5,
        now: () => time++,
        cpuUsage: (previous) =>
          previous === undefined
            ? { user: 10, system: 20 }
            : { user: 3, system: 4 },
        heapUsed: () => (heapCalls++ % 2 === 0 ? 100 : 110),
      },
    );
    expect(executions).toBe(7);
    expect(result.statistics).toMatchObject({
      samples: 5,
      p50Ms: 1,
      p95Ms: 1,
      p99Ms: 1,
    });
    expect(result.rawSamples[0]).toMatchObject({
      cpuUserMicros: 3,
      cpuSystemMicros: 4,
      retainedHeapDeltaBytes: 10,
      counters: { tokens: 10 },
    });
    // A stored report says on its face what a comparison may divide by.
    expect(result.workload).toEqual({
      counter: "tokens",
      units: 10,
      unit: "token",
    });
    await expect(
      runBenchmarkScenario(
        { id: "bad", description: "bad", run: () => undefined },
        { warmups: 0, samples: 4 },
      ),
    ).rejects.toThrow(/at least five/u);
  });

  test("summarizes distributions and applies relative plus absolute budgets", () => {
    expect(summarizeDurations([5, 1, 4, 2, 3])).toMatchObject({
      minMs: 1,
      maxMs: 5,
      p50Ms: 3,
      p95Ms: 5,
      p99Ms: 5,
    });
    expect(
      compareBenchmarkReports({
        baseline: report("reader", 10, 12, 14),
        candidate: report("reader", 13, 14, 18),
        allowedRelativeChange: 0.2,
        allowedAbsoluteChangeMs: 2,
      }).map(({ metric }) => metric),
    ).toEqual(["p50Ms", "p99Ms"]);
  });
});

test("counts a percentile that repeats a coarser one only once", () => {
  // Fifteen samples put both p95 and p99 on the slowest run, so a single slow
  // sample must not be reported as two separate regressions.
  const statistics = (p50: number, tail: number) => ({
    samples: 15,
    minMs: p50,
    maxMs: tail,
    meanMs: p50,
    p50Ms: p50,
    p95Ms: tail,
    p99Ms: tail,
  });
  const report = (p50: number, tail: number) => ({
    schemaVersion: 1 as const,
    generatedAt: "2026-08-29T00:00:00.000Z",
    commit: "abcdef0",
    dirty: false,
    command: "benchmark",
    environment: {
      platform: "darwin" as const,
      release: "25.5.0",
      architecture: "arm64",
      cpu: "Apple M2 Max",
      logicalCpus: 12,
      totalMemoryBytes: 1,
      loadAverage: 0.5,
      node: "v26.5.0",
      typescript: "6.0.3",
      gcExposed: true,
    },
    results: [
      {
        id: "scenario",
        description: "one scenario",
        warmups: 2,
        statistics: statistics(p50, tail),
        rawSamples: [],
      },
    ],
  });
  const regressions = compareBenchmarkReports({
    baseline: report(10, 10),
    candidate: report(10, 40),
    allowedRelativeChange: 0.15,
    allowedAbsoluteChangeMs: 2,
  });
  expect(regressions).toHaveLength(1);
  expect(regressions[0]?.metric).toBe("p95Ms");
});

describe("workload-normalized comparison", () => {
  function sized(
    durationMs: number,
    counters: Readonly<Record<string, number>>,
  ): BenchmarkReport {
    const sample = {
      durationMs,
      cpuUserMicros: 0,
      cpuSystemMicros: 0,
      heapBeforeBytes: 0,
      heapAfterBytes: 0,
      retainedHeapDeltaBytes: 0,
      counters,
    };
    const result: BenchmarkResult = {
      id: "reader",
      description: "reader",
      warmups: 2,
      statistics: {
        samples: 5,
        minMs: durationMs,
        maxMs: durationMs,
        meanMs: durationMs,
        p50Ms: durationMs,
        p95Ms: durationMs,
        p99Ms: durationMs,
      },
      rawSamples: [sample, sample, sample, sample, sample],
    };
    return {
      schemaVersion: 1,
      generatedAt: "2026-09-18T00:00:00.000Z",
      commit: "abcdef0",
      dirty: false,
      command: "benchmark",
      environment: {
        platform: "darwin",
        release: "25.5.0",
        architecture: "arm64",
        cpu: "Apple M2 Max",
        logicalCpus: 12,
        totalMemoryBytes: 1,
        loadAverage: 0.5,
        node: "v26.5.0",
        typescript: "6.0.3",
        gcExposed: true,
      },
      results: [result],
    };
  }

  test("prefers bytes and ignores counters that are outcomes, not sizes", () => {
    const { results } = sized(100, { hits: 7, tokens: 40, bytes: 1_000 });
    expect(benchmarkWorkload(results[0]!)).toEqual({
      counter: "bytes",
      units: 1_000,
      unit: "byte",
    });
    expect(
      benchmarkWorkload(sized(100, { hits: 7 }).results[0]!),
    ).toBeUndefined();
  });

  test("a corpus that grew at unchanged cost per byte is not a regression", () => {
    // The reader's corpus is this repository, so a commit that adds sources
    // makes the scenario take longer without making it slower.
    const regressions = compareBenchmarkReports({
      baseline: sized(1_000, { bytes: 1_000_000 }),
      candidate: sized(1_300, { bytes: 1_300_000 }),
      allowedRelativeChange: 0.15,
      allowedAbsoluteChangeMs: 2,
    });
    expect(regressions).toEqual([]);
  });

  test("reports per-byte cost, and the budget converted to it", () => {
    const [regression, ...rest] = compareBenchmarkReports({
      baseline: sized(1_000, { bytes: 1_000_000 }),
      candidate: sized(1_600, { bytes: 1_300_000 }),
      allowedRelativeChange: 0.15,
      allowedAbsoluteChangeMs: 2,
    });
    expect(rest).toEqual([]);
    expect(regression).toMatchObject({
      scenario: "reader",
      metric: "p50Ms",
      basis: {
        kind: "per-unit",
        unit: "ns/byte",
        counter: "bytes",
        baselineUnits: 1_000_000,
        candidateUnits: 1_300_000,
      },
      baseline: 1_000,
      baselineMs: 1_000,
      candidateMs: 1_600,
      // Two milliseconds of slack spread over the baseline's million bytes.
      allowedAbsoluteChange: 2,
      allowedAbsoluteChangeMs: 2,
    });
    expect(regression?.candidate).toBeCloseTo(1_230.77, 2);
    expect(regression?.relativeChange).toBeCloseTo(0.2308, 4);
  });

  test("keeps the absolute budget's protection on a small fixed workload", () => {
    // One update per sample: normalization divides both sides by the same
    // number, so a 4 ms scenario is still allowed its two milliseconds.
    const budgets = {
      allowedRelativeChange: 0.15,
      allowedAbsoluteChangeMs: 2,
    } as const;
    expect(
      compareBenchmarkReports({
        baseline: sized(4, { updates: 1 }),
        candidate: sized(5.9, { updates: 1 }),
        ...budgets,
      }),
    ).toEqual([]);
    expect(
      compareBenchmarkReports({
        baseline: sized(4, { updates: 1 }),
        candidate: sized(6.1, { updates: 1 }),
        ...budgets,
      }),
    ).toHaveLength(1);
  });

  test("falls back to wall clock when the two sides count different work", () => {
    const wallClock = { kind: "duration", unit: "ms" } as const;
    expect(
      benchmarkComparisonBasis(
        sized(100, { bytes: 10 }).results[0]!,
        sized(100, { operations: 10 }).results[0]!,
      ),
    ).toEqual(wallClock);
    expect(
      benchmarkComparisonBasis(
        sized(100, { bytes: 10 }).results[0]!,
        sized(100, { hits: 10 }).results[0]!,
      ),
    ).toEqual(wallClock);
    expect(
      compareBenchmarkReports({
        baseline: sized(100, { bytes: 10 }),
        candidate: sized(200, { operations: 10 }),
        allowedRelativeChange: 0.15,
        allowedAbsoluteChangeMs: 2,
      })[0],
    ).toMatchObject({ basis: wallClock, baseline: 100, candidate: 200 });
  });

  test("a recorded workload survives a report that dropped its samples", () => {
    const { results } = sized(100, { bytes: 1_000 });
    const trimmed: BenchmarkResult = {
      ...results[0]!,
      workload: { counter: "bytes", units: 1_000, unit: "byte" },
      rawSamples: [],
    };
    expect(benchmarkWorkload(trimmed)).toEqual({
      counter: "bytes",
      units: 1_000,
      unit: "byte",
    });
  });
});
