import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A type assertion standing in a statement must not suppress the macros around
 * it.
 *
 * What follows `as` and `satisfies` is a type, not an expression, so an
 * expression parse that runs past the operator consumes the rest of the
 * statement as operands and swallows the `;` that ends it. The following
 * statement is then read as part of the assertion rather than offered to the
 * expander, and a macro standing there is silently left alone — surfacing much
 * later as an "unknown name" error from TypeScript.
 *
 * The statement and item consumers each build an expression consumer of their
 * own, so teaching only the top-level one to hand `as` off to the type consumer
 * fixed the module top level and left every function body broken.
 */

const macros = `
export syntax duplicate:expr {
  rule { duplicate($value:tt) } => { [$value, $value] }
}
`;

function expand(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-assertions-"));
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

describe("expansion after a type assertion", () => {
  const assertions: readonly (readonly [string, string])[] = [
    ["as const", "const held = 1 as const;"],
    ["as a named type", "const held = 1 as number;"],
    ["as an array type", "const held = [1] as number[];"],
    ["as a union type", "const held = 1 as number | string;"],
    ["as with a declared type", "const held: number = 1 as number;"],
    ["as in a let", "let held = 1 as number;"],
    ["satisfies", "const held = 1 satisfies number;"],
    ["an assertion of its own statement", "(1 as number);"],
  ];

  for (const [name, assertion] of assertions) {
    test(`${name} leaves the following statement expandable`, () => {
      expect(
        expand(`export function f() { ${assertion} return duplicate(2); }`),
      ).toContain("[2, 2]");
    });

    test(`${name} leaves the following item expandable`, () => {
      expect(
        expand(`${assertion}\nexport const value = duplicate(2);`),
      ).toContain("[2, 2]");
    });
  }

  test("the assertion itself survives expansion", () => {
    const generated = expand(
      "export function f() { const held = 1 as number; return duplicate(held); }",
    );
    expect(generated).toContain("as number");
    expect(generated).toContain("[held, held]");
  });
});
