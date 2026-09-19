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
  test("keeps a decimal integer valid before a spliced member access", () => {
    const output = expand(
      `export syntax fixed:expr {
         rule { fixed($value:expr) } => { $value.toFixed(2) }
       }`,
      `import { fixed } from "./macros.sts" for syntax;
export const text = fixed(1);`,
    );
    expect(output).toContain("1 .toFixed(2)");
  });
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

/**
 * Where an expansion puts two pieces side by side, the gap between them is the
 * one a person would have written: enough to keep the scanner reading each
 * piece as itself, and no more.
 */
describe("the gap the printer decides", () => {
  const boxed = `export syntax boxed:type {
           rule { boxed<$element:type> } => { Array<$element> }
         }`;

  test("parts a closing `>` from the `=` of a type parameter default", () => {
    // `>` and `=` reach the printer apart because `>=` is one operator and a
    // `>` may close type arguments. Printing them together hands the scanner
    // `>=` to take apart again, which is a hazard rather than the text a
    // person would write.
    expect(
      expand(
        boxed,
        `import { boxed } from "./macros.sts" for syntax;
export type Defaulted<T extends boxed<string> = boxed<string>> = T;`,
      ),
    ).toContain(
      "export type Defaulted<T extends Array<string> = Array<string>>",
    );
  });

  test("holds type arguments against the `<` that opened them", () => {
    // `of` after `.` is a property name, so `Array.of<` opens type arguments
    // and nothing belongs between the `<` and the type it takes.
    expect(
      expand(
        boxed,
        `import { boxed } from "./macros.sts" for syntax;
export const called = Array.of<boxed<string>>();`,
      ),
    ).toContain("Array.of<Array<string>>()");
  });

  test("keeps a word operator apart from the parenthesis after it", () => {
    // `keyof({ a: 1 } | { b: 2 })` reads as a call to `keyof`.
    expect(
      expand(
        `export syntax keys:type {
           rule { keys<$element:type> } => { keyof $element }
         }`,
        `import { keys } from "./macros.sts" for syntax;
export type K = keys<{ a: 1 } | { b: 2 }>;`,
      ),
    ).toContain("keyof ({ a: 1 } | { b: 2 })");
  });

  test("leaves a `for` header's clauses unparenthesized", () => {
    // A `for` clause stands between `;` and `;`, which nothing can
    // re-associate across, so its expression needs no parentheses of its own.
    expect(
      expand(
        `export syntax counted:stmt {
           rule { counted($body:expr) } => {
             for (let at = 0; at < 2; at += 1) { $body; }
           }
         }`,
        `import { counted } from "./macros.sts" for syntax;
counted(1 + 1);`,
      ),
    ).toContain("for (let at = 0; at < 2; at += 1)");
  });

  test("indents a line it begins itself", () => {
    // The expansion ends a statement, so what the author wrote after it on the
    // same line starts a line of its own -- at the indentation the block's
    // lines stand at, not at column zero.
    expect(
      expand(
        `export syntax fieldy:classElement {
           rule { fieldy } => { value = 0; }
         }`,
        `import { fieldy } from "./macros.sts" for syntax;
class C { fieldy; other = 1; }`,
      ),
    ).toContain("class C { value = 0;\n  other = 1; }");
  });

  /**
   * The `:` of a conditional written around an expansion.
   *
   * A conditional's `:` is spaced away from what stands before it, and every
   * other `:` is not: an annotation's and an object literal's both hold to the
   * name in front of them. Which one a `:` is was read from a flag saying a
   * `?` was still awaiting its own, so a conditional written in another's
   * consequent answered for both -- and the outer `:`, reached at a seam the
   * expansion made, was spaced as an annotation's.
   */
  test.each([
    ["c ? c ? 1 : wrapped(2) : 3", "c ? c ? 1 : (2) : 3"],
    ["c ? wrapped(2) : 3", "c ? (2) : 3"],
    ["c ? 1 : c ? wrapped(2) : 3", "c ? 1 : c ? (2) : 3"],
    ["c ? c ? c ? 1 : wrapped(2) : 3 : 4", "c ? c ? c ? 1 : (2) : 3 : 4"],
  ])("keeps the space before it: %s", (written, printed) => {
    expect(
      expand(
        `export syntax wrapped:expr {
           rule { wrapped($value:expr) } => { ($value) }
         }`,
        `import { wrapped } from "./macros.sts" for syntax;
declare const c: boolean;
export const chosen = ${written};`,
      ),
    ).toContain(printed);
  });

  test("indents it to where the block's own lines stand", () => {
    expect(
      expand(
        `export syntax started:stmt {
           rule { started } => { first(); }
         }`,
        `import { started } from "./macros.sts" for syntax;
declare function first(): void;
function outer() {
    started; second();
}
declare function second(): void;`,
      ),
    ).toContain("    first();\n    second();");
  });
});
