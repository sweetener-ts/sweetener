import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A `token` capture takes a whole operator of the `>` family.
 *
 * TypeScript's scanner reads `>=` as `>` then `=`, because a `>` may close a
 * list of type arguments. A `$op:token` capture took just the `>`, and the
 * rule then failed on the `=`, so a macro could not capture a comparison
 * operator generically and needed one literal rule per operator.
 */

const macros = `
export syntax compare:expr {
  rule { compare($left:ident $op:token $right:expr) }
  refine $op spelling in (==, !=, <, <=, >, >=)
  => { [#text($op), $left $op $right] }
}

export syntax shift:expr {
  rule { shift($op:tt) } => { #text($op) }
}
`;

function run(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-greater-than-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { compare, shift } from "./macros.sts" for syntax;\n${source}\n`,
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
  const generated =
    expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
      ?.generated.text ?? "";
  const exports: Record<string, unknown> = {};
  if (expanded.diagnostics.length === 0)
    new Function(
      "exports",
      ts.transpileModule(generated, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      }).outputText,
    )(exports);
  return {
    exports,
    messages: expanded.diagnostics.map(({ messageText }) =>
      String(messageText),
    ),
  };
}

describe("a token capture of a `>` operator", () => {
  test("takes the whole operator, and a refinement reads it whole", () => {
    const { exports, messages } = run(`
const a = 3;
export const atLeast = compare(a >= 3);
export const greater = compare(a > 3);
export const atMost = compare(a <= 3);
`);
    expect(messages).toEqual([]);
    expect(exports["atLeast"]).toEqual([">=", true]);
    expect(exports["greater"]).toEqual([">", false]);
    expect(exports["atMost"]).toEqual(["<=", true]);
  });

  test("takes every operator of the family as one token", () => {
    const { exports, messages } = run(`
export const right = shift(>>);
export const rightAssign = shift(>>=);
export const unsigned = shift(>>>);
export const unsignedAssign = shift(>>>=);
`);
    expect(messages).toEqual([]);
    expect(exports).toEqual({
      right: ">>",
      rightAssign: ">>=",
      unsigned: ">>>",
      unsignedAssign: ">>>=",
    });
  });

  test("pieces written apart are separate tokens", () => {
    const { messages } = run(`
const a = 3;
export const apart = compare(a > = 3);
`);
    expect(messages.join("\n")).toContain("No rule for macro compare");
  });

  test("a refinement still refuses an operator it does not list", () => {
    const { messages } = run(`
const a = 3;
export const shifted = compare(a >> 3);
`);
    expect(messages.join("\n")).toContain("No rule for macro compare");
  });
});
