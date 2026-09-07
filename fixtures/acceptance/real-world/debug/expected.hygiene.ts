

// `inspected`, `actual`, and `expected` are the macros' own temporaries.
const inspected = 1;
const actual = 2;
const expected = 3;

export const total: number = ((inspected_1) => {
      globalThis.console.error(
        `${"inspected + actual + expected"} = ${globalThis.JSON.stringify(inspected_1)}`,
      );
      return inspected_1;
    })(((inspected + actual) + expected));

export function check(): void {
  {
      const actual_1 = inspected;
      const expected_1 = 1;
      if (!globalThis.Object.is(actual_1, expected_1)) {
        throw (new globalThis.Error(
          `assertion failed: ${"inspected"} === ${"1"}` +
            `\n  ${"inspected"} = ${globalThis.JSON.stringify(actual_1)}` +
            `\n  ${"1"} = ${globalThis.JSON.stringify(expected_1)}`,
        ));
      }
    }
}