import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A macro is dispatched only in the space it declares.
 *
 * A name written where another space is read is not that macro, and passing it
 * through splices the wrong kind of syntax into the program: an item macro
 * read as a type printed `export type T = export const thing = 1;`, which is
 * not a type at all. The member space already refuses this and says which
 * space the macro was declared for; the type and expression spaces say the
 * same thing, so which space a name belongs to is one rule rather than one per
 * reader.
 */

const macros = `
export syntax mkItem:item {
  rule { mkItem } => { export const thing = 1; }
}
export syntax mkStmt:stmt {
  rule { mkStmt } => { let counted = 1; }
}
export syntax mkExpr:expr {
  rule { mkExpr } => { 1 + 2 }
}
export syntax mkType:type {
  rule { mkType } => { string }
}
export syntax mkMember:typeMember {
  rule { mkMember } => { readonly at: number; }
}
`;

interface Expansion {
  readonly text: string;
  readonly reports: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-macro-space-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { mkItem, mkStmt, mkExpr, mkType, mkMember } from "./macros.sts" for syntax;\n${source}\n`,
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
  return {
    text: generated,
    reports: expanded.diagnostics.map(
      ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
    ),
  };
}

/** The one report a mismatched space makes, or a description of what came out. */
function report(source: string): string {
  const { text, reports } = expand(source);
  const mismatch = reports.filter((message) =>
    message.includes("cannot be written where"),
  );
  if (mismatch.length === 1) return mismatch[0]!;
  return `no single space report: ${JSON.stringify(reports)} for ${text}`;
}

describe("a macro written where another space is read", () => {
  test("an item macro after the equals of a type alias", () => {
    expect(report("export type T = mkItem;")).toBe(
      "TS4013: Macro mkItem is declared item and cannot be written where a type is read. Declare it type to use it here.",
    );
  });

  test("an item macro among type arguments", () => {
    expect(report("export type T = Array<mkItem>;")).toBe(
      "TS4013: Macro mkItem is declared item and cannot be written where a type is read. Declare it type to use it here.",
    );
  });

  test("an item macro in a parameter's annotation", () => {
    expect(report("export function f(x: mkItem): void {}")).toBe(
      "TS4013: Macro mkItem is declared item and cannot be written where a type is read. Declare it type to use it here.",
    );
  });

  test("a statement macro after the equals of a type alias", () => {
    expect(report("export type T = mkStmt;")).toBe(
      "TS4013: Macro mkStmt is declared stmt and cannot be written where a type is read. Declare it type to use it here.",
    );
  });

  test("an expression macro after the equals of a type alias", () => {
    expect(report("export type T = mkExpr;")).toBe(
      "TS4013: Macro mkExpr is declared expr and cannot be written where a type is read. Declare it type to use it here.",
    );
  });

  test("a member macro after the equals of a type alias", () => {
    expect(report("export type T = mkMember;")).toBe(
      "TS4013: Macro mkMember is declared typeMember and cannot be written where a type is read. Declare it type to use it here.",
    );
  });

  test("a type macro in an initializer", () => {
    expect(report("export const value = mkType;")).toBe(
      "TS4013: Macro mkType is declared type and cannot be written where an expr is read. Declare it expr to use it here.",
    );
  });

  test("a type macro as a statement", () => {
    expect(report("export function f(): void { mkType; }")).toBe(
      "TS4013: Macro mkType is declared type and cannot be written where an expr is read. Declare it expr to use it here.",
    );
  });

  test("a member macro in an initializer", () => {
    expect(report("export const value = mkMember;")).toBe(
      "TS4013: Macro mkMember is declared typeMember and cannot be written where an expr is read. Declare it expr to use it here.",
    );
  });

  test("nothing is spliced where the space did not match", () => {
    const { text } = expand("export type T = mkItem;");
    expect(text).not.toContain("export const thing");
  });
});

describe("a macro written where its own space is read", () => {
  test("a type macro in a type", () => {
    const { text, reports } = expand("export type T = Array<mkType>;");
    expect(reports).toEqual([]);
    expect(text).toContain("Array<string>");
  });

  test("an item macro at the top level", () => {
    const { text, reports } = expand("mkItem");
    expect(reports).toEqual([]);
    expect(text).toContain("export const thing = 1;");
  });

  test("an expression macro in an initializer", () => {
    const { text, reports } = expand("export const value = mkExpr;");
    expect(reports).toEqual([]);
    expect(text).toContain("1 + 2");
  });

  test("a statement macro in a block", () => {
    const { text, reports } = expand(
      "export function f(): void { mkStmt; counted; }",
    );
    expect(reports).toEqual([]);
    // The name the template binds is renamed away from the caller's own
    // `counted`, which is hygiene rather than anything about spaces.
    expect(text).toMatch(/let counted_\d+ = 1;/);
  });

  test("a member macro in an interface", () => {
    const { text, reports } = expand("export interface I { mkMember }");
    expect(reports).toEqual([]);
    expect(text).toContain("readonly at: number;");
  });

  test("an ordinary name that shares a macro's spelling is left alone", () => {
    const { reports } = expand(
      "export interface Shape { mkType: number; }\nexport const mkItem = 1;",
    );
    expect(reports).toEqual([]);
  });
});
