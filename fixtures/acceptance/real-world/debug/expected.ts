

// The macro introduces a binding spelled `inspected`; this one must survive.
export const inspected = "call-site binding";

export function total(values: readonly number[]): number {
  const sum = ((inspected_1) => {
      globalThis.console.error(
        `${"values.reduce((left, right) => left + right, 0)"} = ${globalThis.JSON.stringify(inspected_1)}`,
      );
      return inspected_1;
    })(values.reduce((left, right) => left + right, 0));
  {
      const actual = sum;
      const bound = 0;
      if (!(actual >= bound)) {
        throw (new globalThis.Error(
          `assertion failed: ${"sum"} >= ${"0"}` +
            `\n  ${"sum"} = ${globalThis.JSON.stringify(actual)}` +
            `\n  ${"0"} = ${globalThis.JSON.stringify(bound)}`,
        ));
      }
    }
  {
      const actual_1 = values.length;
      const expected = 3;
      if (!globalThis.Object.is(actual_1, expected)) {
        throw (new globalThis.Error(
          `assertion failed: ${"values.length"} === ${"3"}` +
            `\n  ${"values.length"} = ${globalThis.JSON.stringify(actual_1)}` +
            `\n  ${"3"} = ${globalThis.JSON.stringify(expected)}`,
        ));
      }
    }
  return sum;
}

export function describeFailure(values: readonly number[]): string {
  try {
    total(values);
    return "no failure";
  } catch (error) {
    return error instanceof Error ? error.message : "unknown";
  }
}

export const failure: string = describeFailure([1, 2]);