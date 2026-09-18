import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Two sentences expansion writes about a name it left standing, and the side
 * that decides whether either of them is true.
 *
 * `SWR4017` says a macro is defined below the use, and `SWR4024` says a macro
 * name written on its own is a name nothing defines. Both are claims about
 * what the emitted program declares, and expansion cannot make one: it sees
 * the macros in scope and the bindings a module writes, and never `lib.d.ts`,
 * an ambient declaration or a `declare global`. A macro spelled `Event` or
 * `JSON` leaves an ordinary global standing where the name was written, and
 * both sentences called that an error.
 *
 * So each is held and handed to TypeScript, which resolves every name against
 * the whole program, and written where TypeScript reports it cannot find the
 * name -- in place of `Cannot find name`, at the same position, saying what
 * expansion knows about it rather than restating the question. Where
 * TypeScript resolves the name, nothing is said. That is why these run the
 * whole `check` rather than expansion alone.
 */

interface Checked {
  readonly text: string;
  readonly reports: readonly {
    readonly at: string;
    readonly message: string;
  }[];
  /** Every report as `file TScode`, for a project whose files both speak. */
  readonly reported: readonly string[];
  readonly exitCode: 0 | 1;
}

/** Build a project out of the given files and run `check` over it. */
function check(
  files: Readonly<Record<string, string>>,
  compilerOptions: Readonly<Record<string, unknown>> = {},
): Checked {
  const directory = mkdtempSync(join(tmpdir(), "sweet-macro-name-"));
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
  const main = files["main.sts"] ?? "";
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.ts was not generated");
  return {
    text: generated,
    reports: result.diagnostics.map(({ code, start, messageText }) => ({
      // Reported against the source the name was written in, so the position
      // is read back out of it.
      at: main.slice(start ?? 0, (start ?? 0) + 10),
      message: `TS${String(code)}: ${ts.flattenDiagnosticMessageText(messageText, "\n")}`,
    })),
    reported: result.diagnostics.map(
      ({ file, code }) =>
        `${file === undefined ? "<none>" : basename(file.fileName)} TS${String(code)}`,
    ),
    exitCode: result.exitCode,
  };
}

/**
 * A macro is visible to what follows its definition. A name written above it
 * is not that macro -- and is not thereby a name nothing defines.
 */
describe("a macro used above its definition", () => {
  const defined = (spelling: string): string =>
    `export syntax ${spelling}:expr {\n  rule { ${spelling} } => { 1 }\n}\n`;

  test("nothing is said where a library global is what was written", () => {
    const { reports, exitCode } = check({
      "main.sts": `export const held = JSON;\n${defined("JSON")}`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("nothing is said where a DOM global is what was written", () => {
    const { reports, exitCode } = check({
      "main.sts": `export function f(): unknown { return Event; }\n${defined("Event")}`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("nothing is said where an ambient declaration is what was written", () => {
    const { reports, exitCode } = check({
      "ambient.d.ts": `declare class Box { readonly value: number }\n`,
      "main.sts": `export const held: Box = new Box();\n${defined("Box")}`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("nothing is said where a declare global is what was written", () => {
    const { reports, exitCode } = check({
      "ambient.d.ts": `export {};\ndeclare global {\n  class Crate { readonly value: number }\n}\n`,
      "main.sts": `export const held: Crate = new Crate();\n${defined("Crate")}`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  /**
   * A member list is a place a bare name is ordinary syntax: it names a member
   * of its own, implicitly typed, which TypeScript asks about only under
   * `noImplicitAny`.
   */
  test("nothing is said where a member list names a member of its own", () => {
    const { text, reports, exitCode } = check({
      "main.sts": `export interface I { nowhere }\nexport syntax nowhere:typeMember {\n  rule { nowhere } => { readonly at: number; }\n}\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
    expect(text).toContain("export interface I { nowhere }");
  });

  test("the macro is named where nothing defines the name", () => {
    const { reports, exitCode } = check({
      "main.sts": `export const a = noop;\nexport syntax noop:expr {\n  rule { noop } => { 0 }\n}\n`,
    });
    expect(reports).toEqual([
      {
        at: "noop;\nexpo",
        message:
          "TS4017: Macro noop is defined below this point, and a macro is visible only to what follows its definition. Move the definition above this use, or into a module imported for syntax.",
      },
    ]);
    expect(exitCode).toBe(1);
  });

  /**
   * A type written above the macro that defines it reads the type space, not
   * the item space the declaration around it is walked as. Looking the name up
   * in the walked space found nothing and said nothing, and the only sentence
   * left was TypeScript's `Cannot find name`, which says nothing about the
   * definition underneath.
   */
  test("the macro is named where a type below defines the name", () => {
    const { reports, exitCode } = check({
      "main.sts": `export type Held = nowhere;\nexport syntax nowhere:type {\n  rule { nowhere } => { number }\n}\n`,
    });
    expect(reports).toEqual([
      {
        at: "nowhere;\ne",
        message:
          "TS4017: Macro nowhere is defined below this point, and a macro is visible only to what follows its definition. Move the definition above this use, or into a module imported for syntax.",
      },
    ]);
    expect(exitCode).toBe(1);
  });

  test("the macro is named where a type argument below defines the name", () => {
    const { reports, exitCode } = check({
      "main.sts": `export type Held = ReadonlyArray<nowhere>;\nexport syntax nowhere:type {\n  rule { nowhere } => { number }\n}\n`,
    });
    expect(reports).toEqual([
      {
        at: "nowhere>;\n",
        message:
          "TS4017: Macro nowhere is defined below this point, and a macro is visible only to what follows its definition. Move the definition above this use, or into a module imported for syntax.",
      },
    ]);
    expect(exitCode).toBe(1);
  });

  /**
   * The same claim about a type, and the same reason it is not expansion's to
   * make: a type macro spelled like a global leaves that global standing above
   * its definition.
   */
  test("nothing is said where a global type is what was written", () => {
    const { reports, exitCode } = check({
      "ambient.d.ts": `export {};\ndeclare global {\n  type Crated = { readonly value: number };\n}\n`,
      "main.sts": `export type Held = Crated;\nexport syntax Crated:type {\n  rule { Crated } => { number }\n}\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("the macro is named where a member list cannot be typed", () => {
    const { reports, exitCode } = check(
      {
        "main.sts": `export interface I { nowhere }\nexport syntax nowhere:typeMember {\n  rule { nowhere } => { readonly at: number; }\n}\n`,
      },
      { strict: true },
    );
    expect(reports).toEqual([
      {
        at: "nowhere }\n",
        message:
          "TS4017: Macro nowhere is defined below this point, and a macro is visible only to what follows its definition. Move the definition above this use, or into a module imported for syntax.",
      },
    ]);
    expect(exitCode).toBe(1);
  });
});

/**
 * A macro name written with nothing after it for any rule to read is a use of
 * the name as a name. Whether the emitted code defines it is TypeScript's
 * question, not expansion's.
 */
describe("a macro name written on its own", () => {
  const sentence = (spelling: string, space: string): string =>
    `TS4024: Macro ${spelling} is written here as a name on its own, where ${space}. ` +
    `A macro is a compile-time name, so nothing defines ${spelling} in the emitted code. ` +
    `Write an invocation its rules accept.`;

  test("nothing is said where a library global is what was written", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax JSON:expr {\n  rule { JSON($value:expr) } => { [$value] }\n}\n`,
      "main.sts": `import { JSON } from "./macros.sts" for syntax;\nexport const held = JSON;\nexport const made = JSON(1);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("nothing is said where a DOM global is what was written", () => {
    const { text, reports, exitCode } = check({
      "macros.sts": `export syntax Event:expr {\n  rule { Event($value:expr) } => { [$value] }\n}\n`,
      "main.sts": `import { Event } from "./macros.sts" for syntax;\nexport const held = Event;\nexport const made = Event(1);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
    expect(text).toContain("held = Event;");
    expect(text).toContain("made = [1]");
  });

  test("nothing is said where an ambient declaration is what was written", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Box:type {\n  rule { Box($element:type) } => { $element[] }\n}\n`,
      "ambient.d.ts": `declare type Box = { readonly value: number };\n`,
      "main.sts": `import { Box } from "./macros.sts" for syntax;\nexport type Held = Box;\nexport type Made = Box(number);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("nothing is said where a declare global is what was written", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Crate:type {\n  rule { Crate($element:type) } => { $element[] }\n}\n`,
      "ambient.d.ts": `export {};\ndeclare global {\n  type Crate = { readonly value: number };\n}\n`,
      "main.sts": `import { Crate } from "./macros.sts" for syntax;\nexport type Held = Crate;\nexport type Made = Crate(number);\n`,
    });
    expect(reports).toEqual([]);
    expect(exitCode).toBe(0);
  });

  test("the macro is named where nothing defines the name", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax query:expr {\n  rule { query($value:expr) } => { [$value] }\n}\n`,
      "main.sts": `import { query } from "./macros.sts" for syntax;\nexport const held = query;\n`,
    });
    expect(reports).toEqual([
      { at: "query;\n", message: sentence("query", "an expr is read") },
    ]);
    expect(exitCode).toBe(1);
  });

  test("the macro is named where nothing defines the type", () => {
    const { reports, exitCode } = check({
      "macros.sts": `export syntax Boxed:type {\n  rule { Boxed($element:type) } => { $element[] }\n}\n`,
      "main.sts": `import { Boxed } from "./macros.sts" for syntax;\nexport type Held = Boxed;\n`,
    });
    expect(reports).toEqual([
      { at: "Boxed;\n", message: sentence("Boxed", "a type is read") },
    ]);
    expect(exitCode).toBe(1);
  });
});

/**
 * A held sentence is spoken about the position it was held against, whatever
 * else in the project went wrong.
 *
 * Expansion reporting a mistake of its own used to end the run before
 * TypeScript was asked anything, so one macro error anywhere silenced every
 * held sentence in the project -- the file with the error was described, and
 * the file with the leftover macro name was not. The check is still skipped
 * over text that never finished expanding, because everything TypeScript would
 * say about it follows from the expansion that failed; TypeScript is asked
 * only which of the held names it resolves, and its own diagnostics there are
 * thrown away.
 */
describe("an expansion error elsewhere in the project", () => {
  /** A file whose macro refuses the input written for it: `SWR4001`. */
  const refuses = `export syntax only:expr {\n  rule { only(1) } => { 1 }\n}\nexport const bad = only(2);\n`;

  test("does not silence the held sentence in another file", () => {
    const { reported, exitCode } = check({
      "other.sts": refuses,
      "main.sts": `export const a = noop;\nexport syntax noop:expr {\n  rule { noop } => { 0 }\n}\n`,
    });
    expect(reported).toEqual(["other.sts TS4001", "main.sts TS4017"]);
    expect(exitCode).toBe(1);
  });

  test("does not silence the held sentence in the file it is in", () => {
    const { reported, exitCode } = check({
      "main.sts": `${refuses}export const a = noop;\nexport syntax noop:expr {\n  rule { noop } => { 0 }\n}\n`,
    });
    expect(reported).toEqual(["main.sts TS4001", "main.sts TS4017"]);
    expect(exitCode).toBe(1);
  });

  /**
   * The other half of the invariant. A held sentence is still only spoken
   * where TypeScript could not resolve the name, so an error elsewhere does
   * not turn it into a claim expansion was never able to make.
   */
  test("does not make the held sentence true where the name resolves", () => {
    const { reported, exitCode } = check({
      "other.sts": refuses,
      "main.sts": `export const held = JSON;\nexport syntax JSON:expr {\n  rule { JSON } => { 1 }\n}\n`,
    });
    expect(reported).toEqual(["other.sts TS4001"]);
    expect(exitCode).toBe(1);
  });

  /**
   * Nothing TypeScript says about text that never finished expanding is
   * reported. `only(2)` is emitted verbatim and `only` is a name the output
   * does not define, which would be a second sentence about the same mistake.
   */
  test("reports nothing the unexpanded output made TypeScript say", () => {
    const { reported } = check({
      "other.sts": refuses,
      "main.sts": `export const a = noop;\nexport syntax noop:expr {\n  rule { noop } => { 0 }\n}\n`,
    });
    expect(reported).not.toContain("other.sts TS2304");
  });
});

/**
 * One expansion is one position. Every name a macro writes is reported against
 * the invocation that wrote it, so several of them share a file and an offset
 * and can only be told apart by the name each sentence is about.
 *
 * Matching on the position alone let one held sentence stand in for every
 * unresolved name in the expansion: the errors the other names earned were
 * replaced by it and deduplicated away, and where two names were held against
 * one position only the last of them was ever written.
 */
describe("several names in one expansion", () => {
  test("keeps the errors the other names in the expansion earned", () => {
    const { reported } = check({
      "main.sts": `export syntax mkOne:type {\n  rule { mkOne } => { number }\n}\nexport syntax trio:expr {\n  rule { trio } => { [mkOne, alpha, beta] }\n}\nexport const x = trio;\n`,
    });
    expect(reported).toEqual([
      "main.sts TS4013",
      "main.sts TS2304",
      "main.sts TS2304",
    ]);
  });

  test("writes a sentence for every name it holds one for", () => {
    const { reports } = check({
      "main.sts": `export syntax mkOne:type {\n  rule { mkOne } => { number }\n}\nexport syntax mkTwo:type {\n  rule { mkTwo } => { string }\n}\nexport syntax both:item {\n  rule { both } => { export const a = mkOne; export const b = mkTwo; }\n}\nboth\n`,
    });
    expect(reports.map(({ message }) => message)).toEqual([
      "TS4013: Macro mkOne is declared type and cannot be written where an expr is read. Declare it expr to use it here.",
      "TS4013: Macro mkTwo is declared type and cannot be written where an expr is read. Declare it expr to use it here.",
    ]);
  });

  /**
   * A shorthand property is the other way TypeScript says a name has no value:
   * `{ mkType }` is not `Cannot find name`, it is `No value exists in scope for
   * the shorthand property`. The sentence was held against that position and
   * nothing ever asked for it.
   */
  test("names the macro where a shorthand property has no value", () => {
    const { reports } = check({
      "main.sts": `export syntax mkType:type {\n  rule { mkType } => { number }\n}\nexport const o = { mkType };\n`,
    });
    expect(reports.map(({ message }) => message)).toEqual([
      "TS4013: Macro mkType is declared type and cannot be written where an expr is read. Declare it expr to use it here.",
    ]);
  });

  /**
   * TypeScript finds the name, in the other space. That is the same mistake
   * `SWR4013` is about, said in TypeScript's vocabulary and with advice --
   * "Did you mean 'typeof Thing'?" -- that is wrong when a macro was meant.
   */
  test("names the macro where the name resolves in the other space", () => {
    const { reports } = check({
      "macros.sts": `export syntax Thing:expr {\n  rule { Thing($v:expr) } => { [$v] }\n}\n`,
      "ambient.d.ts": `export {};\ndeclare global {\n  const Thing: number;\n}\n`,
      "main.sts": `import { Thing } from "./macros.sts" for syntax;\nexport type T = Thing;\n`,
    });
    expect(reports.map(({ message }) => message)).toEqual([
      "TS4013: Macro Thing is declared expr and cannot be written where a type is read. Declare it type to use it here.",
    ]);
  });

  /**
   * Only that one. `SWR4024` says nothing defines the name in the emitted
   * code, and a name TypeScript found in the other space is a name it found.
   */
  test("says nothing about a bare name that resolves in the other space", () => {
    const { reports } = check({
      "macros.sts": `export syntax Thing:expr {\n  rule { Thing($v:expr) } => { [$v] }\n}\n`,
      "ambient.d.ts": `export {};\ndeclare global {\n  type Thing = number;\n}\n`,
      "main.sts": `import { Thing } from "./macros.sts" for syntax;\nexport const t = Thing;\n`,
    });
    expect(reports.map(({ message }) => message)).toEqual([
      "TS2693: 'Thing' only refers to a type, but is being used as a value here.",
    ]);
  });
});
