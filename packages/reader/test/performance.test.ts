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
 * How many rounds are measured, and how long they may take.
 *
 * Every round is measured and kept, rather than stopping at the first one that
 * passes: the statistic is the middle of the distribution, and a distribution
 * needs all of it. The budget bounds a run on a machine so loaded that the
 * rounds themselves are slow.
 */
const budgetMs = 5_000;
const rounds = 15;

/**
 * The cost per character of reading each source, in nanoseconds, one round of
 * it, appended to what has been measured so far.
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
function measure(sources: readonly string[], rates: number[][]): void {
  // Interleaved, so a slow stretch of machine falls on both rather than on
  // whichever happened to be measured during it.
  for (const [index, source] of sources.entries()) {
    const processorBefore = process.cpuUsage();
    const started = performance.now();
    readSyntax(source, { sourceId, scopes, variant: "jsx" });
    const elapsedMs = performance.now() - started;
    const processor = process.cpuUsage(processorBefore);
    const processorMs = (processor.user + processor.system) / 1000;
    rates[index]!.push(
      (Math.min(elapsedMs, processorMs) / source.length) * 1e6,
    );
  }
}

/** The value `fraction` of the way through `values`, sorted. */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ]!;
}

describe("reading scales with the size of the file", () => {
  test("costs no more per character as the file grows", () => {
    const small = components(25);
    const large = components(200);
    expect(large.length / small.length).toBeGreaterThan(7);
    const sources = [small, large];

    const rates: number[][] = sources.map(() => []);
    for (const source of sources)
      for (let index = 0; index < 3; index += 1)
        readSyntax(source, { sourceId, scopes, variant: "jsx" });
    // Every round is measured, and none of them ends the loop. Stopping at the
    // first round that passed made the statistic the best of up to
    // twenty-four, which is blind to exactly the costs that are usually there
    // and occasionally not: a cache that degrades, an allocation that only
    // bites once the collector wakes, work a warm run hides. A reader over the
    // bound four rounds in five passed on the fifth and the other four were
    // never counted.
    const until = performance.now() + budgetMs;
    for (let round = 0; round < rounds; round += 1) {
      measure(sources, rates);
      if (performance.now() > until) break;
    }

    // The median of each, rather than the minimum of either: a machine that
    // interrupted half the rounds still has a middle, and a reader that is
    // slow most of the time no longer hides behind its best round.
    const smallRate = percentile(rates[0]!, 0.5);
    const largeRate = percentile(rates[1]!, 0.5);
    const ratio = largeRate / smallRate;
    // The spread, so a failure says whether the machine or the reader is the
    // reason: a run where the rounds disagree wildly is a busy machine, and
    // one where they agree is the reader.
    const spread = (
      percentile(rates[1]!, 0.9) / percentile(rates[1]!, 0.1)
    ).toFixed(2);
    expect(
      ratio,
      `${largeRate.toFixed(0)} ns/char at ${String(large.length)} characters ` +
        `against ${smallRate.toFixed(0)} at ${String(small.length)}, over ` +
        `${String(rates[0]!.length)} rounds with a p90/p10 spread of ${spread}`,
    ).toBeLessThan(allowedRatio);
  });
});
