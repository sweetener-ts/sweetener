import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A `<` read the other way from the grammar, through a whole expansion.
 *
 * In a JSX file the reader decides a bare `<T>` by what follows it: at the
 * start of a member a parameter list makes a signature, `<T>(v: T): T`, and
 * elsewhere a parameter list and an arrow make a function type,
 * `<T>(v: T) => T`. An element's text can read the same way, and where the
 * enforester finds such a `<` where an operand begins, which TypeScript reads
 * as an element, the source is read again with it opening one. What is
 * written in the element's text is then text, and no macro spelled like a
 * word of it is expanded there.
 */

const macros = `
export syntax x:expr { rule { x } => { 99 } }

export syntax gen:expr { rule { gen } => { <T>(v: T) => v } }
`;

interface Expansion {
  readonly text: string;
  readonly codes: readonly number[];
}

function expand(source: string, extension = ".stsx"): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-jsx-reading-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, `main${extension}`),
    `import { x, gen } from "./macros.sts" for syntax;\n${source}\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: false,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "preserve",
      },
      sweet: { macroExtensions: [".sts", ".stsx"] },
      files: ["macros.sts", `main${extension}`],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith(extension === ".stsx" ? "main.tsx" : "main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main was not expanded");
  return {
    text: generated,
    codes: result.diagnostics.map(({ code }) => code),
  };
}

describe("a `<` read the other way from the grammar", () => {
  test.each([
    [
      "at the start of a block",
      "export function g() {\n  <b>(note): x</b>;\n}",
    ],
    [
      "after a statement in a block",
      "export function g() {\n  g();\n  <b>(note): x</b>;\n}",
    ],
    [
      "with no return type to read",
      "export function g() {\n  <b>(note) x</b>;\n}",
    ],
  ])("opens an element written as a statement %s", (_, source) => {
    const { text, codes } = expand(source);
    expect(codes).toEqual([]);
    expect(text).toContain(source);
  });

  /**
   * JSX text holds no `>`, so an element whose text reads like a function
   * type is not TSX: TypeScript reports the arrow's `>`. Read as the element
   * it is, the `>` is reported where it is written, and the text around it is
   * still not code.
   */
  test("reports the `>` of an element whose text holds an arrow", () => {
    const { text, codes } = expand("export const e = <b>(v) => x</b>;");
    expect(codes).toEqual([1001]);
    expect(text).toContain("export const e = <b>(v) => x</b>;");
  });

  test("still reads a generic function type", () => {
    const { text, codes } = expand(
      "export const id: <T>(v: T) => T = (v) => v;\nexport const y = x;",
    );
    expect(codes).toEqual([]);
    expect(text).toContain("export const id: <T>(v: T) => T = (v) => v;");
    expect(text).toContain("export const y = 99;");
  });

  test("still reads signatures with and without a return type", () => {
    const { text, codes } = expand(
      "export interface I {\n  <T>(v: T): T;\n  <T>(v: T);\n  new <T>(v: T);\n}\nexport const y = x;",
    );
    expect(codes).toEqual([]);
    expect(text).toContain("  <T>(v: T);\n  new <T>(v: T);\n}");
    expect(text).toContain("export const y = 99;");
  });

  test("leaves a generic arrow alone where JSX is not read", () => {
    const { text, codes } = expand(
      "export const id = <T>(v: T) => v;\nexport const y = x;",
      ".sts",
    );
    expect(codes).toEqual([]);
    expect(text).toContain("export const id = <T>(v: T) => v;");
    expect(text).toContain("export const y = 99;");
  });

  test("leaves a generic arrow a template wrote to the printer", () => {
    const { text, codes } = expand("export const id = gen;");
    expect(codes).toEqual([]);
    expect(text).toContain("export const id = <T,>(v: T) => v;");
  });
});
