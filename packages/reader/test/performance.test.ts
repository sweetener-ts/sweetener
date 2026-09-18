import { describe, expect, test } from "vitest";
import { readSyntax } from "../src/index.js";
import type { ScopeSetId, SourceId } from "@sweetener/shared";

/**
 * The reader's cost has to stay proportional to the file.
 *
 * Allocating per token far more than the tokens themselves — an empty trivia
 * array and a `Map` for every one, a copy of trivia that is already immutable
 * — changes no answer, so nothing else fails when it happens. The suite only
 * gets slower, until the slowest test times out under load and it looks like
 * flakiness.
 *
 * This does not assert a wall-clock budget, which would fail on a loaded
 * machine for reasons that have nothing to do with the reader. It asserts the
 * shape of the curve: twice the input costs about twice the time, not four
 * times.
 */

const sourceId = 1 as SourceId;
const scopes = 0 as ScopeSetId;

function components(count: number): string {
  const parts = ['import { useState } from "react";\n'];
  for (let index = 0; index < count; index += 1)
    parts.push(`
export function Component${String(index)}({ items }: { items: readonly string[] }) {
  const [count, setCount] = useState<number>(0);
  const seen = new Map<string, number>();
  const ok = count < items.length && items.length > 0;
  return (
    <section className="row" data-index={${String(index)}}>
      <h2>{count}</h2>
      {items.map((item) => (
        <span key={item} onClick={() => setCount((n) => n + 1)}>{item}</span>
      ))}
      <footer>{ok ? seen.size : "none"}</footer>
    </section>
  );
}
`);
  return parts.join("");
}

/**
 * Generous, because this shares a machine with the rest of the suite. What it
 * catches is cost that grows with the file rather than with the tokens in it:
 * work per token that the collector then has to walk, or a lookahead that
 * reads further the longer the file gets. Reading one file eight times the
 * size of the other costs about a fifth more per character here, and work
 * proportional to a token's offset carries the ratio past this in every round
 * there is, so the threshold has room for a loaded machine and still fails on
 * the shape.
 */
const allowedRatio = 3;

/**
 * How long, and for how many rounds, a ratio over the bound may be measured
 * again before it is reported as it stands.
 *
 * Both limits are reached only where the ratio never settles, which is what a
 * real regression does. The budget is what keeps such a run short: a round
 * costs one read of each size, and a reader that has become slower enough to
 * fail this spends it in a handful of rounds, while a reader that is merely
 * sharing a busy machine gets dozens.
 */
const budgetMs = 5_000;
const rounds = 24;

/**
 * The cost per character of reading each source, in nanoseconds, kept at the
 * fastest round measured.
 *
 * The suite runs these in parallel with everything else, so any single
 * measurement may have spent its time waiting for a core -- and the larger
 * read, being eight times the work, is interrupted eight times as often. The
 * fastest round is the one that was least interrupted, and it is stable in a
 * way a mean is not: a round that comes in slow lowers no minimum and is
 * simply ignored.
 *
 * A read is timed two ways because each overstates its cost for a different
 * reason. Elapsed time counts every moment the machine spent on something
 * else, which on an oversubscribed machine is most of a long read and almost
 * none of a short one -- the very thing that would make the larger file look
 * disproportionately expensive. Processor time counts none of that, but it
 * counts the collector threads running alongside, which the larger file wakes
 * more often. Neither can report less work than was done, so the smaller of
 * the two is the closer account of it.
 */
function measure(sources: readonly string[], best: number[]): void {
  // Interleaved, so a slow stretch of machine falls on both rather than on
  // whichever happened to be measured during it.
  for (const [index, source] of sources.entries()) {
    const processorBefore = process.cpuUsage();
    const started = performance.now();
    readSyntax(source, { sourceId, scopes, variant: "jsx" });
    const elapsedMs = performance.now() - started;
    const processor = process.cpuUsage(processorBefore);
    const processorMs = (processor.user + processor.system) / 1000;
    const rate = (Math.min(elapsedMs, processorMs) / source.length) * 1e6;
    best[index] = Math.min(best[index]!, rate);
  }
}

describe("reading scales with the size of the file", () => {
  test("costs no more per character as the file grows", () => {
    const small = components(25);
    const large = components(200);
    expect(large.length / small.length).toBeGreaterThan(7);
    const sources = [small, large];

    const best = sources.map(() => Number.POSITIVE_INFINITY);
    for (const source of sources)
      for (let index = 0; index < 3; index += 1)
        readSyntax(source, { sourceId, scopes, variant: "jsx" });
    // Measuring goes on while the ratio is over the bound, because only a cost
    // that really grows with the file keeps it there. A run of bad luck on a
    // busy machine is undone by one uninterrupted round, while work
    // proportional to a token's offset is over the bound in every round there
    // is -- the same reason the benchmark suite refuses to call a single slow
    // sample a regression.
    let ratio = Number.POSITIVE_INFINITY;
    const until = performance.now() + budgetMs;
    for (let round = 0; round < rounds; round += 1) {
      measure(sources, best);
      ratio = best[1]! / best[0]!;
      if (ratio < allowedRatio || performance.now() > until) break;
    }

    const [smallRate, largeRate] = best as [number, number];
    expect(
      ratio,
      `${largeRate.toFixed(0)} ns/char at ${String(large.length)} characters against ${smallRate.toFixed(0)} at ${String(small.length)}`,
    ).toBeLessThan(allowedRatio);
  });
});
