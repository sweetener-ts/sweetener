import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * An expression next to an operator of the `>` family, and a `<` comparison
 * in front of a `>`, printed so that they read back as what they are.
 *
 * The scanner leaves `>=`, `>>` and `>>>` as one token per character, and
 * held against one token at a time `a >= (b && c)` was held against its `=`
 * and printed `a >= b && c`, which is `(a >= b) && c`. A `<` comparison or a
 * shift in front of a `>` reads as type arguments: `(x < y) > (z)` printed
 * bare is the call `x<y>(z)`, which type-checks.
 *
 * Where the `>` stands inside what the `<` compares with, or after it in a
 * list -- `x < (y > (z))`, `[x < y, y > (z)]` -- no parentheses part them:
 * TypeScript reads types on from the `<` and recovers into the call. What
 * follows the `<` is printed `((void 0, …))` there, the same value read in
 * the same order, which TypeScript's reading of types cannot reach past.
 */

const macros = `
export syntax ge:expr { rule { ge($a:expr, $b:expr) } => { $a >= $b } }
export syntax shr:expr { rule { shr($a:expr, $b:expr) } => { $a >> $b } }
export syntax ushr:expr { rule { ushr($a:expr, $b:expr) } => { $a >>> $b } }
export syntax le:expr { rule { le($a:expr, $b:expr) } => { $a <= $b } }
export syntax shl:expr { rule { shl($a:expr, $b:expr) } => { $a << $b } }
export syntax and:expr { rule { and($a:expr, $b:expr) } => { $a && $b } }
export syntax lt:expr { rule { lt($a:expr, $b:expr) } => { $a < $b } }
export syntax gt:expr { rule { gt($a:expr, $b:expr) } => { $a > $b } }
`;

function printed(expression: string, expectedCalls = 0): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-greater-than-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { ge, shr, ushr, le, shl, and, lt, gt } from "./macros.sts" for syntax;\n` +
      `declare let a: number, b: number, c: number, x: number, y: number, z: number;\n` +
      `export const r = ${expression};\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: false,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  const text = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (text === undefined) throw new Error("main.sts was not expanded");
  const line = text.split("\n").find((l) => l.startsWith("export const r"));
  if (line === undefined) throw new Error("no result line was printed");
  // What TypeScript reads: no call, which a `<`/`>` pair misread would be.
  const file = ts.createSourceFile("r.ts", line, ts.ScriptTarget.Latest, true);
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(calls, line).toBe(expectedCalls);
  return line.replace("export const r = ", "").replace(/;$/u, "");
}

test.each([
  ["ge(a, and(b, c))", "a >= (b && c)"],
  ["ushr(le(a, b), c)", "(a <= b) >>> c"],
  ["shr(a, shl(b, c))", "a >>(b << c)"],
  ["ge(and(a, b), c)", "(a && b) >= c"],
])("prints %s grouped as written", (expression, expected) => {
  expect(printed(expression)).toBe(expected);
});

test.each([
  ["gt(lt(x, y), (z))", "(x < y) >(z)"],
  ["gt(lt(x, y), z)", "(x < y) > z"],
  ["gt(shl(x, (y)), (z))", "(x << (y)) >(z)"],
])("keeps %s from reading as type arguments", (expression, expected) => {
  expect(printed(expression)).toBe(expected);
});

test.each([
  ["lt(x, gt(y, (z)))", "x < ((void 0, y >(z)))"],
  ["shl(x, gt(y, (z)))", "x << ((void 0, y >(z)))"],
  ["[lt(x, y), gt(y, (z))]", "[x < ((void 0, y)), y >(z)]"],
])("parts %s, which no parentheses keep from type arguments", (expression, expected) => {
  expect(printed(expression)).toBe(expected);
});

test.each([
  ["lt(x, gt(y, z))", "x < (y > z)"],
  ["[lt(x, y), gt(y, z)]", "[x < y, y > z]"],
])("leaves %s, which reads as written, as it is", (expression, expected) => {
  expect(printed(expression)).toBe(expected);
});

test("leaves the call an author wrote with the same tokens as written", () => {
  // TypeScript reads `x<y, y>(z)` here, and so does the author's source.
  expect(printed("[x < y, y > (z)]", 1)).toBe("[x < y, y > (z)]");
});
