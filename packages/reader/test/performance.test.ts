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

function nanosecondsPerCharacter(source: string): number {
  for (let index = 0; index < 3; index += 1)
    readSyntax(source, { sourceId, scopes, variant: "jsx" });
  const runs = 5;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1)
    readSyntax(source, { sourceId, scopes, variant: "jsx" });
  return ((performance.now() - started) / runs / source.length) * 1e6;
}

describe("reading scales with the size of the file", () => {
  test("costs no more per character as the file grows", () => {
    const small = components(25);
    const large = components(200);
    expect(large.length / small.length).toBeGreaterThan(7);

    const smallRate = nanosecondsPerCharacter(small);
    const largeRate = nanosecondsPerCharacter(large);

    // Generous, because this shares a machine with the rest of the suite. A
    // per-character cost that grew with the file — an allocation per token
    // that the collector then has to walk, or a scan of the remaining source
    // at every `<` — shows up here as a multiple, not as a few percent.
    expect(
      largeRate / smallRate,
      `${largeRate.toFixed(0)} ns/char at ${String(large.length)} characters against ${smallRate.toFixed(0)} at ${String(small.length)}`,
    ).toBeLessThan(2);
  });
});
