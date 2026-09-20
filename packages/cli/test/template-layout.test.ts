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

  test("does not carry a capture's line break to where the template wrote none", () => {
    // The call site broke the line after `=>`, in front of the arm's body.
    // Spliced after the template's `return` that same break read `return` and
    // then a statement of its own, so the arm returned nothing at all.
    const output = expand(
      `export syntax pick:expr {
           rule { pick { $pattern:expr => $body:expr } } => {
             ((matched: unknown) => {
               if (matched === $pattern) { return $body; }
               throw new Error("unmatched");
             })(1)
           }
         }`,
      `import { pick } from "./macros.sts" for syntax;
export const chosen: string = pick {
  1 =>
    \`one \${String(1)}\`
};`,
    );
    expect(output).toContain("return `one ${String(1)}`;");
    expect(output).not.toMatch(/return\s*\n/u);
  });

  test("hoists a comment that would part `return` from what it returns", () => {
    // A line comment cannot give up its line break, and `return` followed by
    // one returns nothing. The comment is kept, above the statement.
    const pick = `export syntax pick:expr {
           rule { pick { $pattern:expr => $body:expr } } => {
             ((matched: unknown) => {
               if (matched === $pattern) { return $body; }
               throw new Error("unmatched");
             })(1)
           }
         }`;
    const output = expand(
      pick,
      `import { pick } from "./macros.sts" for syntax;
export const chosen: string = pick {
  1 => // why one
    "one"
};`,
    );
    expect(output).toMatch(/\/\/ why one\n\s*return "one";/u);
    expect(output).not.toMatch(/return\s*\/\//u);
  });

  test("hoists it past every keyword a line break would end", () => {
    const output = expand(
      `export syntax relay:stmt {
           rule { relay($value:expr); } => {
             function* relayed() { return yield $value; }
           }
         }`,
      `import { relay } from "./macros.sts" for syntax;
relay(
  // handed on
  1
);`,
    );
    expect(output).toMatch(/\/\/ handed on\n\s*return \(yield 1\);/u);
  });

  test("keeps a comment the call site wrote in front of a capture", () => {
    expect(
      expand(
        `export syntax twice:expr {
           rule { twice($value:expr) } => { [$value, $value] }
         }`,
        `import { twice } from "./macros.sts" for syntax;
export const doubled = twice(
  // the answer, halved
  21
);`,
      ),
    ).toContain("// the answer, halved");
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

/**
 * A template is written in the file that defines the macro and printed into the
 * file that invokes it, and the two need not read `<` alike. `<T>(value: T) =>
 * value` is a generic arrow in a `.ts` file and an unclosed element in a `.tsx`
 * one, where only `<T,>` and `<T extends U>` are type parameters. Generated
 * `.ts` is also read as `.tsx` by whatever it is pasted into. So the printer
 * writes the one spelling both read.
 */
describe("a generic arrow's type parameters", () => {
  const made = `export syntax made:item {
           rule { made $name:binding<$parameter:binding>; }
           bind $name in following as recursive value;
           => {
             #core(const $name = <$parameter>(value: $parameter): $parameter => value;)
           }
         }`;

  test("take the comma a .tsx file needs to read them", () => {
    expect(
      expand(
        made,
        `import { made } from "./macros.sts" for syntax;
made same<T>;
export const kept: number = same(1);`,
      ),
    ).toContain("<T,>(value: T): T => value");
  });

  test("take it behind `async` and before a block body", () => {
    const output = expand(
      `export syntax made:item {
           rule { made $name:binding<$parameter:binding>; }
           bind $name in following as recursive value;
           => {
             #core(const $name = async <$parameter>(value: $parameter) => { return value; };)
           }
         }`,
      `import { made } from "./macros.sts" for syntax;
made same<T>;
export const kept: Promise<number> = same(1);`,
    );
    expect(output).toContain("async <T,>(value: T) =>");
  });

  test("are left as written where a .tsx file already reads them", () => {
    const output = expand(
      `export syntax made:item {
           rule { made $name:binding<$parameter:binding>; }
           bind $name in following as recursive value;
           => {
             #core(const $name = {
               bounded: <$parameter extends number>(value: $parameter) => value,
               paired: <$parameter, Other>(value: $parameter, other: Other) => [value, other],
             };)
           }
         }`,
      `import { made } from "./macros.sts" for syntax;
made both<T>;
export const kept = both.bounded(1);`,
    );
    expect(output).toContain("<T extends number>(value: T) => value");
    expect(output).toContain("<T, Other>(value: T, other: Other) =>");
  });

  test("are left as the author of the file wrote them", () => {
    // Only a template is written for one file and printed into another. What
    // stands in the file being printed was written for it, and is not respelled.
    expect(
      expand(
        made,
        `import { made } from "./macros.sts" for syntax;
made same<T>;
export const own = <U>(value: U): U => same(value);`,
      ),
    ).toContain("<U>(value: U): U => same(value)");
  });

  test("are not mistaken for a type assertion, which a comma would break", () => {
    expect(
      expand(
        `export syntax cast:expr {
           rule { cast<$asserted:type>($value:expr) } => { <$asserted>($value) }
         }`,
        `import { cast } from "./macros.sts" for syntax;
export const asserted = cast<number>(1 as unknown);`,
      ),
    ).not.toContain(",>");
  });
});

/**
 * A prefix type assertion has no spelling a `.tsx` file reads -- there is no
 * comma to add, as there is for a generic arrow -- so one a template wrote is
 * printed as the `as` it means. `as` binds more loosely than the prefix did,
 * so the parentheses come with it.
 */
describe("a prefix type assertion a template wrote", () => {
  const cast = `export syntax cast:expr {
           rule { cast<$asserted:type>($value:expr) } => { <$asserted>$value }
         }`;

  test("is printed as the `as` both kinds of file read", () => {
    expect(
      expand(
        cast,
        `import { cast } from "./macros.sts" for syntax;
declare const raw: unknown;
export const one: number = cast<number>(raw);`,
      ),
    ).toContain("export const one: number = (raw as number);");
  });

  test("keeps what it bound: the operand, and not the product", () => {
    expect(
      expand(
        `export syntax doubled:expr {
           rule { doubled<$asserted:type>($value:expr) } => { <$asserted>-$value * 2 }
         }`,
        `import { doubled } from "./macros.sts" for syntax;
export const product: number = doubled<number>(3);`,
      ),
    ).toContain("((-3 as number) * 2)");
  });

  test("is printed from the inside out where one asserts another", () => {
    expect(
      expand(
        `export syntax forced:expr {
           rule { forced<$asserted:type>($value:expr) } => { <$asserted><unknown>$value }
         }`,
        `import { forced } from "./macros.sts" for syntax;
export const count: number = forced<number>("x");`,
      ),
    ).toContain('(("x" as unknown) as number)');
  });

  test("holds a union it asserts together", () => {
    expect(
      expand(
        cast,
        `import { cast } from "./macros.sts" for syntax;
declare const raw: unknown;
export const either = cast<number | string>(raw) === 1;`,
      ),
    ).toContain("(raw as (number | string)) === 1");
  });

  test("is left as written where the author of the file wrote it", () => {
    expect(
      expand(
        cast,
        `import { cast } from "./macros.sts" for syntax;
declare const raw: unknown;
export const own = <number>raw * 2;
export const made: number = cast<number>(raw);`,
      ),
    ).toContain("export const own = <number>raw * 2;");
  });
});
