import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A macro definition that cannot work should say so where it is written.
 *
 * Unreported, both faults here are silent at the definition and confusing at
 * the use: a second definition of one name is discarded without a word, and a
 * rule naming a syntax class that does not exist compiles and then reports only
 * that no rule matched, pointing at the call rather than at the name that was
 * never declared.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-definition-errors-"));
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
  return expanded.diagnostics.map(
    ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
  );
}

describe("defining one name twice", () => {
  test("a second definition in the same category is refused", () => {
    const messages = run(
      "export syntax dup:expr { rule { dup($x:tt) } => { 1 } }\n" +
        "export syntax dup:expr { rule { dup($x:tt) } => { 2 } }\n",
      'import { dup } from "./macros.sts" for syntax;\nexport const a = dup(9);\n',
    );
    expect(messages.join("\n")).toContain(
      "Macro dup is already defined in this module: another expr definition",
    );
  });

  test("two exported definitions in different categories are refused", () => {
    // A module's export list records one category per name, so the second is
    // unreachable through any import.
    const messages = run(
      "export syntax both:expr { rule { both($x:tt) } => { 1 } }\n" +
        "export syntax both:stmt { rule { both($x:tt); } => { ; } }\n",
      'import { both } from "./macros.sts" for syntax;\nexport const a = both(9);\n',
    );
    expect(messages.join("\n")).toContain(
      "export list records one category per name",
    );
  });

  test("one exported and one local definition may share a name", () => {
    const messages = run(
      "export syntax both:expr { rule { both($x:tt) } => { 1 } }\n" +
        "syntax both:stmt { rule { both($x:tt); } => { ; } }\n",
      'import { both } from "./macros.sts" for syntax;\nexport const a = both(9);\n',
    );
    expect(messages).toEqual([]);
  });
});

describe("naming a syntax class", () => {
  test("a class that does not exist is named where the rule names it", () => {
    const messages = run(
      "export syntax m:expr { rule { m($x:NoSuchClass) } => { 1 } }",
      'import { m } from "./macros.sts" for syntax;\nexport const a = m(9);\n',
    );
    expect(messages.join("\n")).toContain(
      "Unresolved syntax class NoSuchClass",
    );
    expect(messages.join("\n")).not.toContain("No rule for macro m");
  });

  test("the classes the language provides still resolve", () => {
    expect(
      run(
        "export syntax m:expr { rule { m($x:expr, $y:ident, $z:tt) } => { [$x] } }",
        'import { m } from "./macros.sts" for syntax;\nexport const a = m(1, two, 3);\n',
      ),
    ).toEqual([]);
  });

  test("a class the module declares still resolves", () => {
    expect(
      run(
        `
export syntax class Pair {
  fields {
    left: tt;
    right: tt;
  }

  rule { $left:tt : $right:tt }
}
export syntax m:expr { rule { m($p:Pair) } => { [$p.left, $p.right] } }
`,
        'import { m } from "./macros.sts" for syntax;\nexport const a = m(1 : 2);\n',
      ),
    ).toEqual([]);
  });
});
