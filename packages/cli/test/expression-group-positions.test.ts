import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A group standing in an expression holds an expression, whatever token is in
 * front of it.
 *
 * The walk decided whether a group held a type from the one token before it,
 * and the tokens that introduce a type -- `,` `?` `:` `|` `&` `<` `=>` -- are
 * every one of them also an expression's. So `[1, (twice(2))]`,
 * `ready ? (twice(1)) : (twice(2))`, `(x) => (twice(x))` and
 * `f(1, { a: twice(2) })` looked the macro up among type macros, found none,
 * and emitted it verbatim as a call to a name the output does not define.
 * Inside an expression only `as` and `satisfies` introduce a type.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}
export syntax pair:type {
  rule { pair($value:type) } => { [$value, $value] }
}
export syntax inTemplate:expr {
  rule { inTemplate($value:expr) } => {
    [1, (twice($value)), true ? (twice($value)) : 0, { a: twice($value) }]
  }
}
`;

function expand(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-expression-groups-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice, pair, inTemplate } from "./macros.sts" for syntax;\n${source}\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  return {
    generated:
      expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text ?? "",
    messages: expanded.diagnostics.map(({ messageText }) =>
      String(messageText),
    ),
  };
}

describe("a group in an expression holds an expression", () => {
  test.each([
    ["after a comma in an array", "export const value = [1, (twice(2))];"],
    [
      "after a comma in a call",
      "const f = (a: number, b: number[]) => b;\nexport const value = f(1, (twice(2)));",
    ],
    [
      "in both arms of a conditional",
      "declare const ready: boolean;\nexport const value = ready ? (twice(1)) : (twice(2));",
    ],
    ["after a bitwise or", "export const value = 1 | (twice(2))[0];"],
    ["after a less-than", "export const value = 1 < (twice(2))[0];"],
    ["as an arrow's body", "export const value = (x: number) => (twice(x));"],
    [
      "as an object literal after a comma",
      "const f = (a: number, b: { a: number[] }) => b;\nexport const value = f(1, { a: twice(2) });",
    ],
    [
      "in a function body",
      "export function g(ready: boolean) { return ready ? (twice(1)) : [1, (twice(2))]; }",
    ],
    ["written in a template", "export const value = inTemplate(3);"],
  ])("%s", (_position, source) => {
    const { generated, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(generated).not.toMatch(/\btwice\b/u);
  });

  /**
   * The complement of the rule above: a brace written where the type
   * arguments of an expression are is an object type, and each name in it
   * names a member. Walked as an object literal -- which asks only that the
   * brace hold a `:` -- the `;` between two members separated nothing, so the
   * second member was read as the continuation of the first and its name was
   * dispatched.
   */
  test.each([
    [
      "a member past a semicolon",
      "export const m = new Map<string, { b: string; twice: number }>();",
    ],
    [
      "a member past a comma",
      "export const m = new Map<string, { b: string, twice: number }>();",
    ],
    ["the only member", "export const s = new Set<{ twice: number }>();"],
    [
      "a member of a call's type argument",
      "declare function make<T>(): T;\nexport const v = make<{ b: string; twice: number }>();",
    ],
    [
      "a member of a nested object type",
      "export const m = new Map<string, { b: { twice: number } }>();",
    ],
    [
      "a method signature",
      "export const s = new Set<{ b: string; twice(): number }>();",
    ],
  ])("keeps %s of an object type in type arguments", (_position, source) => {
    const { generated, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(generated).toMatch(/\btwice\b/u);
  });

  test("a type macro still reads inside an object type in type arguments", () => {
    const { generated, messages } = expand(
      "declare function make<T>(): T;\nexport const v = make<{ b: pair(number); c: number }>();",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("b: [number, number]");
  });

  test("a group after `as` or `satisfies` still holds a type", () => {
    const { generated, messages } = expand(
      "export const value = [1, 1] as (pair(number));\nexport const other = [2, 2] satisfies (pair(number));",
    );
    expect(messages).toEqual([]);
    expect(generated).not.toMatch(/\bpair\b/u);
  });
});
