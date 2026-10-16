/**
 * A fixed-seed generator for the model tests: mulberry32, whose every bit
 * varies. The linear congruential generator these tests used before has low
 * bits with a short period, and `random() % n` read only those: a scope pick
 * that was always the third of four calls per step chose 4 of 16 scopes, and
 * `(random() & 1) === 0` never once came out false.
 *
 * Answers an integer at least 0 and below `bound`.
 */
export function seededRandom(seed: number): (bound: number) => number {
  let state = seed >>> 0;
  return (bound: number): number => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000) * bound) >>> 0;
  };
}
