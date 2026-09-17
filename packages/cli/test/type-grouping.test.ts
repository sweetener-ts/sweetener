import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A type macro's expansion keeps its own boundary.
 *
 * `|` and `&` bind looser than the postfix `[]` and than indexed access, so a
 * macro spliced loose into the type around it is re-associated by whatever
 * follows: `orNull(string)[]` printed as `string | null[]` is an array of
 * `null` unioned with `string` rather than an array of `string | null`. The
 * program still type-checks, under the wrong type, with nothing to say it has
 * happened.
 *
 * Grouping is only added where something could re-associate. A macro expanding
 * to a plain reference, or to one whose arguments are already delimited, is
 * printed as written.
 */

const macros = `
export syntax orNull:type {
  rule { orNull($t:type) } => { $t | null }
}
export syntax justString:type {
  rule { justString() } => { string }
}
export syntax listOfString:type {
  rule { listOfString() } => { Array<string> }
}
export syntax voidFn:type {
  rule { voidFn() } => { () => void }
}
`;

function expand(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-type-grouping-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { orNull, justString, listOfString, voidFn } from "./macros.sts" for syntax;\n${source}\n`,
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
  // The printer's spacing around a group is not what these are about.
  return generated
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")");
}

describe("grouping a type expansion", () => {
  test("an array of the expansion, not an array of its last member", () => {
    expect(expand("export type A = orNull(string)[];")).toContain(
      "(string | null)[]",
    );
  });

  test("an index into the expansion", () => {
    expect(expand('export type A = orNull(string)["length"];')).toContain(
      '(string | null)["length"]',
    );
  });

  test("a function type keeps its arrow together", () => {
    expect(expand("export type A = voidFn()[];")).toContain("(() => void)[]");
  });

  test("the left side of a conditional type", () => {
    expect(
      expand("export type A = orNull(string) extends null ? 1 : 2;"),
    ).toContain("(string | null) extends null");
  });

  test("a plain reference is left ungrouped", () => {
    expect(expand("export type A = justString()[];")).toContain("string[]");
  });

  test("delimited type arguments are left ungrouped", () => {
    expect(expand("export type A = listOfString()[];")).toContain(
      "Array<string>[]",
    );
  });

  test("the grouping stands outside the layout before it", () => {
    // Emitted the moment the group is reached, the parenthesis lands before
    // the first token's leading trivia and prints `=( string | null)[]`.
    const generated = expand("export type A = orNull(string)[];");
    expect(generated).toContain("= (string | null)[]");
    expect(generated).not.toContain("=(");
  });

  test("an expansion still enforests back into one type", () => {
    // Keeping the expansion whole means the type consumer meets a protected
    // type rather than the expansion's tokens, and has to accept it.
    expect(expand("export const value: orNull(string) = null;")).toContain(
      "string | null",
    );
  });
});
