import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Syntax captured by a macro and spliced into its template must still have its
 * own macro invocations expanded.
 *
 * Two separate defects broke this. Definition-order visibility compared an
 * offset from the call site against definition offsets in the macro's own
 * file, so whether a captured invocation expanded depended on where it
 * happened to sit in an unrelated file. And a replacement was walked while
 * still raw, so a captured statement's interior expressions were never given
 * their categories and an expression macro inside one was never recognized.
 */

const macros = `
export syntax duplicate:expr {
  rule { duplicate($value:tt) } => { [$value, $value] }
}

export syntax wrapExpr:expr {
  rule { wrapExpr($inner:expr) } => { ($inner) }
}

export syntax unless:stmt {
  rule { unless ($test:expr) $body:stmt } => { if (!($test)) $body }
}
`;

function expand(source: string, header = ""): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-capture-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `${header}import { duplicate, wrapExpr, unless } from "./macros.sts" for syntax;\n${source}\n`,
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
  expect(
    expanded.diagnostics.map(({ messageText }) => messageText),
    "expansion reported diagnostics",
  ).toEqual([]);
  const generated = expanded.files.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not generated");
  return generated;
}

describe("macro invocations inside captures", () => {
  const cases: readonly (readonly [string, string])[] = [
    [
      "an expression capture that is entirely an invocation",
      "export const value = wrapExpr(duplicate(1));",
    ],
    [
      "an expression capture with the invocation nested inside it",
      "export const value = wrapExpr(2 + duplicate(1));",
    ],
    [
      "a statement capture holding a block",
      "export function f(x) { unless (x) { const a = duplicate(1); } }",
    ],
    [
      "a statement capture holding a single statement",
      "export function f(x) { unless (x) console.log(duplicate(1)); }",
    ],
    [
      "a statement capture in a return position",
      "export function f(x) { unless (x) { return duplicate(1); } return x; }",
    ],
  ];

  for (const [description, source] of cases)
    test(`expands ${description}`, () => {
      const generated = expand(source);
      expect(generated, description).not.toContain("duplicate(");
      expect(generated, description).toContain("[1, 1]");
    });

  test("expansion does not depend on the call site's offset in its file", () => {
    // The visibility threshold that broke this was an offset into the macro's
    // own file, so padding the call site past that offset used to be the
    // difference between expanding and not.
    const short = expand("export const value = wrapExpr(duplicate(1));");
    const padded = expand(
      `${"// padding\n".repeat(20)}export const value = wrapExpr(duplicate(1));`,
    );
    expect(short).toContain("[1, 1]");
    expect(padded).toContain("[1, 1]");
  });
});

/**
 * A comment above a compile-time import describes the module, not the import.
 *
 * The import is removed from the generated file, and its leading trivia went
 * with it — so a licence header at the top of a `.sts`, or any module comment
 * written above the first `for syntax` import, was deleted from the output.
 */
describe("comments above a compile-time import", () => {
  test("survive the import being removed", () => {
    const generated = expand(
      `export const value = duplicate(1);`,
      `// Copyright someone.\n// All rights reserved.\n`,
    );
    expect(generated).toContain("// Copyright someone.");
    expect(generated).toContain("// All rights reserved.");
    // On their own lines: run together, the second is inside the first.
    expect(generated).toMatch(
      /\/\/ Copyright someone\.\s*\n\s*\/\/ All rights reserved\./u,
    );
  });

  test("do not disturb a file that has none", () => {
    expect(expand(`export const value = duplicate(1);`)).toContain(
      "[1, 1]".replace(", ", ","),
    );
  });
});
