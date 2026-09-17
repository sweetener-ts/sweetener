import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
  runConfiguredProjectCommand,
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

/**
 * The same boundary, for a type a rule captured.
 *
 * A capture is matched by the type consumer, so what the rule binds is one
 * type however many tokens it took. Splicing the tokens back into a template
 * throws that boundary away, and the template's own operators re-associate
 * against it: `$t[]` over `string | number` printed `string | number[]`, an
 * array of `number` unioned with `string`. Nothing reports it -- the program
 * type-checks, under the wrong type.
 *
 * The rule is the one the printer already applies to a macro's own expansion:
 * a captured type is kept whole, and parenthesized only where its own top
 * level holds an operator that could re-associate.
 */

const captureMacros = `
export syntax arrayOf:type {
  rule { arrayOf<$t:type> } => { $t[] }
}
export syntax arrayOfParens:type {
  rule { arrayOfParens($t:type) } => { $t[] }
}
export syntax orNothing:type {
  rule { orNothing<$t:type> } => { $t | null }
}
export syntax andTagged:type {
  rule { andTagged<$t:type> } => { $t & { tag: "t" } }
}
export syntax whenNull:type {
  rule { whenNull<$t:type> } => { $t extends null ? "yes" : "no" }
}
export syntax keysOf:type {
  rule { keysOf<$t:type> } => { keyof $t }
}
export syntax lengthOf:type {
  rule { lengthOf<$t:type> } => { $t["length"] }
}
export syntax listOf:type {
  rule { listOf<$t:type> } => { Array<$t> }
}
export syntax valueOf:type {
  rule { valueOf<$t:type> } => { { [K in "a"]: $t } }
}
`;

/**
 * `Same` is invariant in both arguments, so the witness below it is assignable
 * only when the expansion produced exactly the type the test names. A weaker
 * `extends` check passes for `string | number[]` against `(string | number)[]`
 * in one direction and would not catch the re-association.
 */
const witnessPrelude = `import {
  arrayOf,
  arrayOfParens,
  orNothing,
  andTagged,
  whenNull,
  keysOf,
  lengthOf,
  listOf,
  valueOf,
} from "./macros.sts" for syntax;
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
`;

interface CaptureExpansion {
  readonly text: string;
  readonly diagnostics: readonly { readonly code: number }[];
}

/** Expands and type-checks a use of the capture macros above. */
function expandCapture(source: string): CaptureExpansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-type-capture-"));
  writeFileSync(join(directory, "macros.sts"), captureMacros);
  writeFileSync(join(directory, "main.sts"), `${witnessPrelude}${source}\n`);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
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
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not generated");
  return {
    text: generated
      .replace(/\s+/g, " ")
      .replace(/\( /g, "(")
      .replace(/ \)/g, ")"),
    diagnostics: result.diagnostics,
  };
}

/**
 * Each row writes one captured type into one template context, and names both
 * the text the expansion must print and the type it must mean. The witness is
 * what the text is for: `string | number[]` and `(string | number)[]` are both
 * types TypeScript accepts, and only the identity check tells them apart.
 */
const captureRows: readonly {
  readonly name: string;
  readonly use: string;
  readonly printed: string;
  readonly identity: string;
}[] = [
  {
    name: "a union under a template's array suffix",
    use: "arrayOf<string | number>",
    printed: "(string | number)[]",
    identity: "(string | number)[]",
  },
  {
    name: "a function type under a template's array suffix",
    use: "arrayOf<() => void>",
    printed: "(() => void)[]",
    identity: "(() => void)[]",
  },
  {
    name: "an intersection under a template's array suffix",
    use: "arrayOf<{ a: 1 } & { b: 2 }>",
    printed: "({ a: 1 } & { b: 2 })[]",
    identity: "({ a: 1 } & { b: 2 })[]",
  },
  {
    name: "a keyof under a template's array suffix",
    use: "arrayOf<keyof { a: 1 }>",
    printed: "(keyof { a: 1 })[]",
    identity: '("a")[]',
  },
  {
    name: "a conditional type under a template's array suffix",
    use: 'arrayOf<number extends string ? "a" : "b">',
    printed: '(number extends string ? "a" : "b")[]',
    identity: '"b"[]',
  },
  {
    name: "a capture the rule took in parentheses",
    use: "arrayOfParens(string | null)",
    printed: "(string | null)[]",
    identity: "(string | null)[]",
  },
  {
    name: "a function type in a template's union",
    use: "orNothing<() => void>",
    printed: "((() => void) | null)",
    identity: "(() => void) | null",
  },
  {
    name: "a union in a template's intersection",
    use: "andTagged<{ a: 1 } | { b: 2 }>",
    printed: '(({ a: 1 } | { b: 2 }) & { tag: "t" })',
    identity: '({ a: 1 } | { b: 2 }) & { tag: "t" }',
  },
  {
    name: "a union on the left of a template's conditional",
    use: "whenNull<string | null>",
    printed: '((string | null) extends null ? "yes" : "no")',
    identity: '"no"',
  },
  {
    name: "a union under a template's keyof",
    use: "keysOf<{ a: 1 } | { b: 2 }>",
    printed: "(keyof({ a: 1 } | { b: 2 }))",
    identity: "never",
  },
  {
    name: "a union under a template's indexed access",
    use: "lengthOf<string | string[]>",
    printed: '(string | string[])["length"]',
    identity: "number",
  },
  {
    name: "a union as a template's type argument",
    use: "listOf<string | number>",
    printed: "Array<(string | number)>",
    identity: "Array<string | number>",
  },
  {
    name: "a union as a mapped type's value",
    use: "valueOf<string | number>",
    printed: '{ [K in "a"]: (string | number) }',
    identity: "{ a: string | number }",
  },
];

describe("grouping a captured type", () => {
  for (const { name, use, printed, identity } of captureRows) {
    test(name, () => {
      const { text, diagnostics } = expandCapture(
        `export type A = ${use};\nexport const witness: Same<A, ${identity}> = true;`,
      );
      expect(text).toContain(`export type A = ${printed};`);
      expect(diagnostics).toEqual([]);
    });
  }

  test("a captured name is spliced without parentheses", () => {
    const { text, diagnostics } = expandCapture(
      "export type A = arrayOf<string>;\nexport const witness: Same<A, string[]> = true;",
    );
    expect(text).toContain("export type A = string[];");
    expect(diagnostics).toEqual([]);
  });

  test("a captured type whose arguments are delimited is spliced without parentheses", () => {
    const { text, diagnostics } = expandCapture(
      "export type A = arrayOf<Array<string>>;\nexport const witness: Same<A, Array<string>[]> = true;",
    );
    expect(text).toContain("export type A = Array<string>[];");
    expect(diagnostics).toEqual([]);
  });

  test("a capture already in parentheses does not gain a second pair", () => {
    const { text, diagnostics } = expandCapture(
      "export type A = arrayOf<(string | number)>;\nexport const witness: Same<A, (string | number)[]> = true;",
    );
    expect(text).toContain("export type A = (string | number)[];");
    expect(text).not.toContain("((string | number))");
    expect(diagnostics).toEqual([]);
  });
});
