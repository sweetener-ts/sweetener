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

export syntax wrap:expr { rule { wrap $e:expr } => { [$e] } }

export syntax num:expr { rule { num $e:expr } => { <number>$e } }
`;

/**
 * Macros whose templates write elements, defined where JSX is read. Each
 * template is read where it is written, so a `<` its reader judged the other
 * way is one only reading that module again corrects.
 */
const elementMacros = `
export syntax x:expr { rule { x } => { 99 } }

export syntax el:expr { rule { el } => { <p>(optional) note</p> } }

export syntax mk:item {
  rule { mk } => { export function h() { <p>(optional) x</p>; } }
}

export syntax mk2:item {
  rule { mk2 } => { export function k() { <b>(note): x</b>; } }
}

export syntax spaced:expr { rule { spaced } => { <p>(a)   b, c</p> } }
`;

interface Expansion {
  readonly text: string;
  readonly codes: readonly number[];
}

function expand(
  source: string,
  extension = ".stsx",
  module: { readonly name: string; readonly text: string } = {
    name: "macros.sts",
    text: macros,
  },
): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-jsx-reading-"));
  writeFileSync(join(directory, module.name), module.text);
  const imported =
    module.text === macros ? "x, gen, wrap, num" : "x, el, mk, mk2, spaced";
  writeFileSync(
    join(directory, `main${extension}`),
    `import { ${imported} } from "./${module.name}" for syntax;\n${source}\n`,
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
      files: [module.name, `main${extension}`],
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

/**
 * The reader reads a macro's name as any other name, and a `<` after a name
 * as a comparison; where the macro's rule reads an operand there, TypeScript
 * reads an element. Read as a type assertion instead, `<p>optional` matched
 * the rule, and the element's tags and text were expanded as code.
 */
describe("an element written after a macro's name", () => {
  test.each([
    ["holding a container", "export const v = wrap <p>{x}</p>;", "<p>{99}</p>"],
    [
      "holding text",
      'export const v = wrap <div className="a">optional x</div>;',
      '<div className="a">optional x</div>',
    ],
    [
      "spelled like a signature",
      "export const v = wrap <b>(note): x</b>;",
      "<b>(note): x</b>",
    ],
  ])("is read as an element %s", (_, source, element) => {
    const { text, codes } = expand(source);
    expect(codes).toEqual([]);
    expect(text).toContain(`[ ${element}]`);
  });

  test("leaves an assertion a `.sts` template writes one", () => {
    const { text, codes } = expand("export const v = num 1;");
    expect(codes).toEqual([]);
    expect(text).toContain("(1 as number)");
  });
});

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
   * JSX text holds no `>`, so an element whose text reads like a generic
   * arrow is not TSX. A bare `<T>` heading an arrow is the arrow's, and
   * TypeScript reports the `>` its own parser finds there.
   */
  test("leaves an arrow written like an element to TypeScript", () => {
    const { codes } = expand("export const e = <b>(v) => x</b>;");
    expect(codes).toEqual([1382]);
  });

  test("opens an element a template in the same file writes", () => {
    const { text, codes } = expand(
      "syntax note:item {\n  rule { note } => { export function k() { <b>(note): x</b>; } }\n}\nnote",
    );
    expect(codes).toEqual([]);
    expect(text).toContain("export function k() { <b>(note): x</b>; }");
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

/**
 * An element a macro's template writes is read as one, so what is written in
 * its text is text, wherever the macro is used.
 */
describe("an element a template writes", () => {
  const module = { name: "macros.stsx", text: elementMacros };

  test.each([
    ["as an expression", "export const e = el;", "<p>(optional) note</p>"],
    ["as a statement", "mk", "export function h() { <p>(optional) x</p>; }"],
    [
      "as a statement whose text reads like a signature",
      "mk2",
      "export function k() { <b>(note): x</b>; }",
    ],
    [
      "with spaces in its text",
      "export const s = spaced;",
      "<p>(a)   b, c</p>",
    ],
  ])("is read as an element %s", (_, source, written) => {
    const { text, codes } = expand(source, ".stsx", module);
    expect(codes).toEqual([]);
    expect(text).toContain(written);
  });
});
