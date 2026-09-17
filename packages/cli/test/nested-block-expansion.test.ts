import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Macros must expand wherever their category is valid, not only at the top
 * level of a module.
 *
 * A block carried through expansion as an opaque token tree leaves an
 * expression macro inside any function body, control-flow block, or class
 * method silently unexpanded, failing only later as an "unknown name" error
 * from TypeScript. The acceptance corpus invokes no expression macro inside a
 * block, so these are what catch it.
 */

const macros = `
export syntax duplicate:expr {
  rule { duplicate($value:tt) } => { [$value, $value] }
}
`;

function expand(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-blocks-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { duplicate } from "./macros.sts" for syntax;\n${source}\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const provider = createDefaultProjectExpansionProvider();
  const expanded = provider.expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  const generated = expanded.files.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not generated");
  return generated;
}

describe("expansion inside nested blocks", () => {
  const positions: readonly (readonly [string, string])[] = [
    ["module top level", "export const value = duplicate(1);"],
    ["arrow body", "export const value = (v) => duplicate(v);"],
    [
      "arrow block body",
      "export const value = (v) => { return duplicate(v); };",
    ],
    [
      "function declaration body",
      "export function f(v) { return duplicate(v); }",
    ],
    [
      "function declaration statement",
      "export function f(v) { const a = duplicate(v); return a; }",
    ],
    [
      "generator body",
      "export function* g(v) { const a = duplicate(v); yield a; }",
    ],
    ["class method body", "export class K { m(v) { return duplicate(v); } }"],
    [
      "if block",
      "export function f(v) { if (v) { return duplicate(v); } return v; }",
    ],
    [
      "for block",
      "export function f(v) { for (const x of v) { return duplicate(x); } }",
    ],
    [
      "while block",
      "export function f(v) { while (v) { return duplicate(v); } }",
    ],
    ["bare block", "export function f(v) { { return duplicate(v); } }"],
    [
      "try block",
      "export function f(v) { try { return duplicate(v); } catch { return v; } }",
    ],
    [
      "catch block",
      "export function f(v) { try { return v; } catch { return duplicate(v); } }",
    ],
    [
      "finally block",
      "export function f(v) { try { return v; } finally { duplicate(v); } }",
    ],
  ];

  for (const [position, source] of positions)
    test(`expands an expression macro in a ${position}`, () => {
      const generated = expand(source);
      expect(generated, position).not.toContain("duplicate(");
      expect(generated, position).toContain("[");
    });

  test("leaves a block with no macro invocation unchanged", () => {
    const generated = expand(
      "export function f(v) { const a = v + 1; return a; }",
    );
    expect(generated).toContain("const a = v + 1");
  });
});
