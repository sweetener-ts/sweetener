import type { SlashReadings } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  nextSlashReadings,
  settleSlashReadings,
  slashReadLimit,
  type SlashAttempt,
} from "../src/slash-settling.js";

/**
 * A source is read again for as long as the enforester finds slashes read the
 * other way that only a read can settle, and no longer than a bound.
 */
describe("settling a source's slash readings", () => {
  test("reads again with what each read found, until a read settles", () => {
    const seen: SlashReadings[] = [];
    const settled = settleSlashReadings<string, SlashReadings>(
      new Map(),
      (readings): SlashAttempt<string, SlashReadings> => {
        seen.push(readings);
        const next = nextSlashReadings(
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

  test("tells the last read it may make that it is the last", () => {
    const finals: boolean[] = [];
    const settled = settleSlashReadings<string, SlashReadings>(
      new Map(),
      (readings, final) => {
        finals.push(final);
        // A read that never settles: each finds one more slash to read again.
        return final
          ? { kind: "settled", settled: "reported" }
          : {
              kind: "reread",
              readings: new Map([
                ...readings,
                [readings.size, "regular-expression"],
              ]),
            };
      },
    );
    expect(settled).toBe("reported");
    expect(finals).toHaveLength(slashReadLimit);
    expect(finals.slice(0, -1).every((final) => !final)).toBe(true);
    expect(finals.at(-1)).toBe(true);
  });

  test("refuses a last read that asks to be read again", () => {
    expect(() =>
      settleSlashReadings<string, SlashReadings>(
        new Map(),
        (readings) => ({ kind: "reread", readings }),
        2,
      ),
    ).toThrow(/told it was the last of 2 asked to be read again/u);
  });

  test("finds nothing to read again in what the readings already say", () => {
    const readings: SlashReadings = new Map([[4, "regular-expression"]]);
    expect(nextSlashReadings(readings, readings)).toBeUndefined();
    expect([
      ...nextSlashReadings(readings, new Map([[4, "division"]]))!,
    ]).toEqual([[4, "division"]]);
  });
});
