import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

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
 *
 * Which names a program defines, though, is TypeScript's to answer and never
 * the expander's: `lib.d.ts`, an ambient declaration and a `declare global`
 * each declare names the expander cannot see, and a member list names members
 * of its own. So the sentence is written where TypeScript reports it cannot
 * find the name, or cannot type the member the name introduces, and nowhere
 * else -- which is why these run the whole `check` rather than expansion
 * alone. Where the name resolves, nothing is said and the program builds.
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
  readonly exitCode: 0 | 1;
}

/** Build a project out of the given files and run `check` over it. */
function check(
  files: Readonly<Record<string, string>>,
  compilerOptions: Readonly<Record<string, unknown>> = {},
): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-macro-space-"));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(directory, name), text);
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: false,
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        ...compilerOptions,
      },
      sweet: { macroExtensions: [".sts"] },
      files: Object.keys(files),
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath,
    writeThrough: false,
  });
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not generated");
  return {
    text: generated,
    reports: result.diagnostics.map(
      ({ code, messageText }) =>
        `TS${String(code)}: ${ts.flattenDiagnosticMessageText(messageText, "\n")}`,
    ),
    exitCode: result.exitCode,
  };
}

function expand(source: string): Expansion {
  return check({
    "macros.sts": macros,
    "main.sts": `import { mkItem, mkStmt, mkExpr, mkType, mkMember } from "./macros.sts" for syntax;\n${source}\n`,
  });
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

  /**
   * A member list is the place TypeScript may ask for nothing: a bare name
   * there is a member of its own, implicitly typed, which is an error only
   * under `noImplicitAny`. Where it does ask, the macro is what the sentence
   * is about.
   */
  test("an expression macro in a member list, under noImplicitAny", () => {
    const { reports } = check(
      {
        "macros.sts": macros,
        "main.sts": `import { mkExpr } from "./macros.sts" for syntax;\nexport interface I { mkExpr }\n`,
      },
      { strict: true },
    );
    expect(reports).toEqual([
      "TS4013: Macro mkExpr is declared expr and cannot be written where a typeMember is read. Declare it typeMember to use it here.",
    ]);
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
      "export function f(): void { const counted = 2; mkStmt; counted; }",
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

/**
 * A macro's spelling is not reserved, and the expander is not the side that
 * knows what a name means. It sees this module's declarations and its imports;
 * it never sees `lib.d.ts`, an ambient declaration, a `declare global`, or the
 * members an interface declares. Reporting a mismatched space on its own
 * knowledge therefore refused valid TypeScript whenever a macro was spelled
 * like something the program already had.
 */
describe("a name TypeScript resolves is not a mismatched space", () => {
  test("a library type against an expression macro of the same name", () => {
    const { text, reports, exitCode } = check({
      "macros.sts": `export syntax Partial:expr {\n  rule { Partial($value:expr) } => { [$value, $value] }\n}\n`,
      "main.sts": `import { Partial } from "./macros.sts" for syntax;\nexport type Halved = Partial<{ a: number }>;\nexport const doubled = Partial(1);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
    expect(text).toContain("Partial<{ a: number }>");
    expect(text).toContain("[1, 1]");
  });

  test("a library type against a statement macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Record:stmt {\n  rule { Record } => { let counted = 1; }\n}\n`,
      "main.sts": `import { Record } from "./macros.sts" for syntax;\nexport type R = Record<string, number>;\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("a library type against an item macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Omit:item {\n  rule { Omit } => { export const thing = 1; }\n}\n`,
      "main.sts": `import { Omit } from "./macros.sts" for syntax;\nexport type O = Omit<{ a: number }, "a">;\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("a global value against a type macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Event:type {\n  rule { Event } => { string }\n}\n`,
      "main.sts": `import { Event } from "./macros.sts" for syntax;\nexport const constructed = Event;\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("a global value against a member macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Element:typeMember {\n  rule { Element } => { readonly at: number; }\n}\n`,
      "main.sts": `import { Element } from "./macros.sts" for syntax;\nexport const constructed = Element;\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("an interface member against a class-element macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax held:classElement {\n  rule { held } => { readonly at = 1; }\n}\n`,
      "main.sts": `import { held } from "./macros.sts" for syntax;\nexport interface I { held }\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("an ambient declaration against an expression macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Box:expr {\n  rule { Box($value:expr) } => { [$value] }\n}\n`,
      "ambient.d.ts": `declare type Box<T> = { readonly value: T };\n`,
      "main.sts": `import { Box } from "./macros.sts" for syntax;\nexport type Held = Box<number>;\nexport const boxed = Box(1);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("a declare global type against an expression macro of the same name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Crate:expr {\n  rule { Crate($value:expr) } => { [$value] }\n}\n`,
      "ambient.d.ts": `export {};\ndeclare global {\n  type Crate<T> = { readonly value: T };\n}\n`,
      "main.sts": `import { Crate } from "./macros.sts" for syntax;\nexport type Held = Crate<number>;\nexport const boxed = Crate(1);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
