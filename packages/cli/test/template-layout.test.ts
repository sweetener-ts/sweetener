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
 * replaces the placeholder token outright. Throwing that spacing away would
 * print `[21,21]` for a template that reads like TypeScript, in the middle of
 * a file whose every other line keeps the author's formatting exactly.
 *
 * Layout is kept wherever two tokens still stand where they were written side
 * by side, in the template or at the call site. Where an expansion puts tokens
 * next to each other that were never written together, the gap is spaced as
 * code ordinarily is.
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

  test("is decided where a capture meets the template", () => {
    // The template wrote nothing between `,` and `$right`, and the call site
    // wrote its own spacing between `,` and `2` -- each a gap from a different
    // neighbour than the one `2` stands beside in the expansion. The gap is
    // spaced as code ordinarily is.
    for (const source of ["pair(1,2)", "pair(1,  2)"])
      expect(
        expand(
          `export syntax pair:expr {
             rule { pair($left:expr,$right:expr) } => { [$left,$right] }
           }`,
          `import { pair } from "./macros.sts" for syntax;
export const both = ${source};`,
        ),
      ).toContain("[1, 2]");
  });

  test("keeps the call site's layout inside what it captured", () => {
    expect(
      expand(
        `export syntax pair:expr {
           rule { pair($left:expr,$right:expr) } => { [$left,$right] }
         }`,
        `import { pair } from "./macros.sts" for syntax;
export const both = pair(1,  2  +   3);`,
      ),
    ).toContain("[1, 2  +   3]");
  });

  test("does not carry a capture's spacing to where it lands", () => {
    // The space after `=` is written in front of `[`, and must not follow it
    // into the call it is spliced into: `total =map( [1, 2, 3]`.
    expect(
      expand(
        `export operator (|>):expr {
           fixity infix;
           associativity left;
           precedence 35;
           rule { $value:expr |> $function:ident($($argument:expr),*) } => {
             $function($value #if(present $argument) {, $($argument),*})
           }
         }`,
        `import { (|>) } from "./macros.sts" for syntax;
declare function map(items: number[], f: (n: number) => number): number[];
export const total = [1, 2, 3]
  |> map((n) => n * 2);`,
      ),
    ).toContain("export const total = map([1, 2, 3], (n) => n * 2);");
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
