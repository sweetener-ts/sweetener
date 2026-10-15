import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A slash read the other way from the grammar, through a whole expansion.
 *
 * The reader judges a slash from the token before it, and where the grammar
 * says otherwise the expansion reads the source again with the enforester's
 * answer. What it then emits is read from the right tokens: a statement macro
 * under the slash is reached, a macro whose capture begins at it reads it,
 * and the regular expression's text is passed through as one token rather
 * than as names and operators the printer and hygiene may touch.
 */

const macros = `
export syntax unless:stmt {
  rule { unless($condition:expr) $body:stmt }
  => { if (!($condition)) $body }
}

export syntax twice:expr { rule { twice($v:expr) } => { $v * 2 } }

export syntax keep:classElement {
  rule { keep $member:classElement } => { $member }
}
`;

interface Expansion {
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-slash-reading-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { unless, twice, keep } from "./macros.sts" for syntax;\n` +
      `declare function run(): void;\n${source}\n`,
  );
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
  if (generated === undefined) throw new Error("main.sts was not expanded");
  return {
    text: generated,
    messages: result.diagnostics.map(({ messageText }) => String(messageText)),
  };
}

describe("a slash the reader judged a division where an operand begins", () => {
  test.each([
    ["after a condition", "  if (c) /a  b/.test(s);\n"],
    ["holding a bracket, after a condition", "  if (c) /[(]/.test(s);\n"],
    ["under an annotation", "  let x: string\n  /a  b/.test(s);\n"],
  ])(
    "is read as a regular expression %s, and the macro under it expands",
    (_label, line) => {
      const { text, messages } = expand(
        "export function f(c: boolean, s: string) {\n" +
          line +
          "  unless(c) { run(); }\n" +
          "}\n",
      );
      expect(messages).toEqual([]);
      expect(text).toContain(line);
      expect(text).toContain("if (!(c)) { run(); }");
    },
  );

  test("is read as a regular expression under a bodiless signature", () => {
    const { text, messages } = expand(
      "declare function g(): string\n" +
        '/[(]/.test("a");\n' +
        "unless(false) { run(); }\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain('/[(]/.test("a");');
    expect(text).toContain("if (!(false)) { run(); }");
  });

  test("is read as a regular expression where a capture begins at it", () => {
    const { text, messages } = expand(
      "export function f(c: boolean, s: string) {\n" +
        "  unless(c) /a  b/.test(s);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("if (!(c)) /a  b/.test(s);");
  });
});

describe("a regular expression the reader judged one where an operator stands", () => {
  test("is read as a division, in a capture and in the module", () => {
    const { text, messages } = expand(
      "const of = 4;\n" +
        "export const y = twice(of / 2 / 1);\n" +
        "export const z = of\n/ 2 / 1;\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("of / 2 / 1 * 2");
    expect(text).toContain("export const z = of\n/ 2 / 1;");
  });
});

/**
 * A class field's initializer is read by the expression consumer, so a macro
 * in it is expanded as one, and a member macro capturing the field takes the
 * field and nothing under it.
 */
describe("a class field's initializer", () => {
  test("expands a macro written in it", () => {
    const { text, messages } = expand(
      "export class C {\n  x = twice(3)\n  y = 1;\n}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("x = 3 * 2");
  });

  test("ends where the expression does, under a member macro", () => {
    const { text, messages } = expand(
      "declare const a: unknown;\n" +
        'const k = "k";\n' +
        "export class C {\n" +
        "  keep x = a as string\n" +
        "  [k] = 1;\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("x = a as string\n  [k] = 1;");
  });
});
