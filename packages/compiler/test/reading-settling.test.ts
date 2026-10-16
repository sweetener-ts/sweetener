import type { TokenReadings } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  askedReadings,
  nextReadings,
  settleReadings,
  readLimit,
  type ReadAttempt,
} from "../src/reading-settling.js";

/**
 * A source is read again for as long as the enforester finds slashes read the
 * other way that only a read can settle. Reads that ask for a reading no read
 * asked for before end by themselves, since a source has finitely many
 * slashes; reads that only ask again are bounded.
 */
describe("settling a source's slash readings", () => {
  test("reads again with what each read found, until a read settles", () => {
    const seen: TokenReadings[] = [];
    const settled = settleReadings<string, TokenReadings>(
      new Map(),
      askedReadings,
      (readings): ReadAttempt<string, TokenReadings> => {
        seen.push(readings);
        const next = nextReadings(
          readings,
          new Map([[seen.length * 10, "regular-expression"]]),
        );
        return seen.length < 3 && next !== undefined
          ? { kind: "reread", readings: next }
          : { kind: "settled", settled: "expanded" };
      },
    );
    expect(settled).toBe("expanded");
    expect(seen.map((readings) => [...readings.keys()])).toEqual([
      [],
      [10],
      [10, 20],
    ]);
  });

  // A regular expression holding a bracket hides the next one from the
  // enforester until it is read as one, so a source of many such settles one
  // more slash with each read. None of those reads is the last.
  test("reads again for as long as each read settles a slash", () => {
    const finals: boolean[] = [];
    const settled = settleReadings<number, TokenReadings>(
      new Map(),
      askedReadings,
      (readings, final, reads) => {
        finals.push(final);
        return readings.size === 5 * readLimit
          ? { kind: "settled", settled: reads }
          : {
              kind: "reread",
              readings: new Map([
                ...readings,
                [readings.size, "regular-expression"],
              ]),
            };
      },
    );
    expect(settled).toBe(5 * readLimit + 1);
    expect(finals.every((final) => !final)).toBe(true);
  });

  test("tells a read it is the last after reads that ask only again", () => {
    const finals: boolean[] = [];
    const flip: TokenReadings[] = [
      new Map([[4, "regular-expression"]]),
      new Map([[4, "division"]]),
    ];
    const settled = settleReadings<string, TokenReadings>(
      new Map(),
      askedReadings,
      (readings, final) => {
        finals.push(final);
        // Two reads that each undo the other.
        return final
          ? { kind: "settled", settled: "reported" }
          : {
              kind: "reread",
              readings: readings === flip[0] ? flip[1]! : flip[0]!,
            };
      },
    );
    expect(settled).toBe("reported");
    // The first two reads each ask for a reading no read asked for before.
    expect(finals).toHaveLength(readLimit + 2);
    expect(finals.slice(0, -1).every((final) => !final)).toBe(true);
    expect(finals.at(-1)).toBe(true);
  });

  test("refuses a last read that asks to be read again", () => {
    expect(() =>
      settleReadings<string, TokenReadings>(
        new Map(),
        askedReadings,
        (readings) => ({ kind: "reread", readings }),
        2,
      ),
    ).toThrow(/told it was the last after 2 that settled nothing new/u);
  });

  test("finds nothing to read again in what the readings already say", () => {
    const readings: TokenReadings = new Map([[4, "regular-expression"]]);
    expect(nextReadings(readings, readings)).toBeUndefined();
    expect([
      ...nextReadings(readings, new Map([[4, "division"]]))!,
    ]).toEqual([[4, "division"]]);
  });
});
