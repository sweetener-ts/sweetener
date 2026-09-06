import { describe, expect, test } from "vitest";
import { readSyntax } from "../src/index.js";
import type { ScopeSetId, SourceId } from "@sweetener/shared";

/**
 * The reader's cost has to stay proportional to the file.
 *
 * Reading allocated per token far more than the tokens themselves: an empty
 * trivia array and a `Map` for every one, and a copy of trivia that was
 * already immutable. None of that changed the answer, so nothing failed when
 * it was there — the suite only got slower, until the slowest test began
 * timing out under load and it looked like flakiness.
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
 * The cost of one read, in nanoseconds per character.
 *
 * The suite runs these in parallel with everything else, so any single
 * measurement may have spent its time waiting for a core. The fastest round is
 * the one that was least interrupted, and it is stable in a way a mean is not.
 */
function nanosecondsPerCharacter(sources: readonly string[]): number[] {
  const best = sources.map(() => Number.POSITIVE_INFINITY);
  for (const source of sources)
    for (let index = 0; index < 3; index += 1)
      readSyntax(source, { sourceId, scopes, variant: "jsx" });
  // Interleaved, so a slow stretch of machine falls on both rather than on
  // whichever happened to be measured during it.
  for (let round = 0; round < 5; round += 1)
    for (const [index, source] of sources.entries()) {
      const started = performance.now();
      readSyntax(source, { sourceId, scopes, variant: "jsx" });
      const rate = ((performance.now() - started) / source.length) * 1e6;
      best[index] = Math.min(best[index]!, rate);
    }
  return best;
}

describe("reading scales with the size of the file", () => {
  test("costs no more per character as the file grows", () => {
    const small = components(25);
    const large = components(200);
    expect(large.length / small.length).toBeGreaterThan(7);

    const [smallRate, largeRate] = nanosecondsPerCharacter([small, large]) as [
      number,
      number,
    ];

    // Generous, because this shares a machine with the rest of the suite. What
    // this catches is cost that grows with the file rather than with the
    // tokens in it: work per token that the collector then has to walk, or a
    // lookahead that reads further the longer the file gets. Injecting work
    // proportional to a token's offset moves this ratio to about eight, so the
    // threshold has room for a loaded machine and still fails on the shape.
    expect(
      largeRate / smallRate,
      `${largeRate.toFixed(0)} ns/char at ${String(large.length)} characters against ${smallRate.toFixed(0)} at ${String(small.length)}`,
    ).toBeLessThan(3);
  });
});
