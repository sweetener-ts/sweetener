import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * How a template's own spacing reaches the expansion.
 *
 * A placeholder carries the layout written before it -- the space in
 * `[$value, $value]` is trivia on the second `$value` -- and substitution
 * replaces the placeholder token outright. That threw the spacing away, so a
 * macro whose template read like TypeScript printed `[21,21]` in the middle of
 * a file whose every other line kept the author's formatting exactly.
 */

function expand(macros: string, source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-template-layout-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  expect(
    expanded.diagnostics.map(({ messageText }) => String(messageText)),
  ).toEqual([]);
  const generated = expanded.files.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not expanded");
  return generated;
}

describe("the layout a template writes around its placeholders", () => {
  test("reaches the expansion", () => {
    expect(
      expand(
        `export syntax twice:expr {
           rule { twice($value:expr) } => { [$value, $value] }
         }`,
        `import { twice } from "./macros.sts" for syntax;
export const doubled = twice(21);`,
      ),
    ).toContain("[21, 21]");
  });

  test("is not invented where the template wrote none", () => {
    expect(
      expand(
        `export syntax pair:expr {
           rule { pair($left:expr,$right:expr) } => { [$left,$right] }
         }`,
        `import { pair } from "./macros.sts" for syntax;
export const both = pair(1,2);`,
      ),
    ).toContain("[1,2]");
  });

  test("yields to layout the call site wrote of its own", () => {
    // `$right` captures `  2`, spacing included. That spacing is the author's
    // own spelling of this very text, so it outranks the template's.
    expect(
      expand(
        `export syntax pair:expr {
           rule { pair($left:expr,$right:expr) } => { [$left,$right] }
         }`,
        `import { pair } from "./macros.sts" for syntax;
export const both = pair(1,  2);`,
      ),
    ).toContain("[1,  2]");
  });

  test("survives a placeholder that stands for several tokens", () => {
    expect(
      expand(
        `export syntax sum:expr {
           rule { sum($left:expr, $right:expr) } => { ($left + $right) }
         }`,
        `import { sum } from "./macros.sts" for syntax;
export const total = sum(1 * 2, 3);`,
      ),
    ).toContain("((1 * 2) + 3)");
  });
});
