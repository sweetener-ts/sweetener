import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A slash read the other way from the grammar, through a whole expansion.
 *
 * The reader judges a slash from what stands before it, and where the grammar
 * says otherwise the enforester reads it as the grammar does: in place where
 * only the tokens of one expression change, and by reading the source again
 * where more does. What the expansion emits is read from the right tokens: a
 * statement macro under the slash is reached, a macro whose capture begins at
 * it reads it, and the regular expression's text is passed through as one
 * token rather than as names and operators the printer and hygiene may touch.
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

export syntax log:stmt {
  rule { log $level:ident $x:expr; } => { console.log($x); }
  rule { log $x:expr; } => { console.log($x); }
}

export syntax ret:stmt { rule { ret $k:tt; } => { $k / 2 /g; } }

export syntax pick:stmt { rule { pick $k:tt; } => { $k / (g) / 2; } }
`;

interface Expansion {
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string, macroModule = macros): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-slash-reading-"));
  writeFileSync(join(directory, "macros.sts"), macroModule);
  writeFileSync(
    join(directory, "main.sts"),
    `import { unless, twice, keep, log, ret, pick } from "./macros.sts" for syntax;\n` +
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
    messages: result.diagnostics.map(({ messageText }) =>
      typeof messageText === "string" ? messageText : messageText.messageText,
    ),
  };
}

describe("a slash the reader judged a division where an operand begins", () => {
  test.each([
    ["after a condition", "  if (c) /a  b/.test(s);\n"],
    ["holding a bracket, after a condition", "  if (c) /[(]/.test(s);\n"],
    ["under an annotation", "  let x: string\n  /a  b/.test(s);\n"],
    [
      "holding a bracket, under an annotation",
      "  let x: string\n  /[(]/.test(s);\n",
    ],
    [
      "holding a quote, under an annotation",
      "  let x: string\n  /'/.test(s);\n",
    ],
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

  test.each([
    [
      "after a comparison in an initializer",
      "declare const b: number, c: number;\nlet a = b < c, d: string\n",
    ],
    [
      "after an initializer that goes on across a line",
      "declare const b: number, c: number;\nlet a = b\n  + c, d: string\n",
    ],
  ])(
    "is read as a regular expression under a module's declaration %s",
    (_label, declaration) => {
      // Only the enforester sees the declaration end at its type, and a
      // declaration of the module's own was read on to its `;` with the
      // regular expression in it, where nothing asked to read it again.
      const { text, messages } = expand(
        `declare const s: string;\n${declaration}/[(]/.test(s);\nunless(false) { run(); }\n`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("/[(]/.test(s);");
      expect(text).toContain("if (!(false)) { run(); }");
    },
  );

  test("is read as a regular expression where a capture begins at it", () => {
    const { text, messages } = expand(
      "export function f(c: boolean, s: string) {\n" +
        "  unless(c) /a  b/.test(s);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("if (!(c)) /a  b/.test(s);");
  });

  test("is read again where a capture begins at it and it holds a bracket", () => {
    // No rule reads the invocation as it was read, and the capture that came
    // closest says the slash begins a regular expression: read so, a rule
    // reads it.
    const { text, messages } = expand(
      "export function f(c: boolean, s: string) {\n" +
        "  unless(c) /[(]/.test(s);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("if (!(c)) /[(]/.test(s);");
  });

  test("is read as a regular expression in a file that defines macros", () => {
    const { text, messages } = expand(
      "export const t = twice(3);\n",
      macros +
        "export function test(s: string) {\n" +
        "  let x: string\n" +
        "  /[(]/.test(s);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const t = 3 * 2;");
  });
});

/**
 * A macro's rules are tried in turn, and a rule's capture reads a slash the
 * way its own grammar does, however the rule tried before it read it.
 */
describe("a slash a macro's rules read", () => {
  test.each([
    [
      "divided, after a rule that takes a name",
      "log a / 2;",
      "console.log(a / 2);",
    ],
    [
      "a regular expression, after a name it takes",
      "log info /a  b/.test(s);",
      "console.log(/a  b/.test(s));",
    ],
    [
      "divided, after a name spelled `of`",
      "log of / 2 / 1;",
      "console.log(of / 2 / 1);",
    ],
    [
      "divided around a group, which the rule tried first read as more",
      "log a / (b) / 2;",
      "console.log(a / (b) / 2);",
    ],
  ])("is read %s", (_label, line, expected) => {
    const { text, messages } = expand(
      "declare const a: number, b: number, s: string, info: string;\n" +
        "const of = 4;\n" +
        line,
    );
    expect(messages).toEqual([]);
    expect(text).toContain(expected);
  });
});

/**
 * A template is read once, where it is written, and each use of it decides
 * where its slashes stand: `$k / 2 /g` divides for one use and is a regular
 * expression for another.
 */
describe("a slash a macro's template writes", () => {
  test("is read as each use of the template needs", () => {
    const { text, messages } = expand(
      "const g = 1, x = 4;\n" +
        "export function f() { ret x; }\n" +
        "export function h() { ret return; }\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("x / 2 /g;");
    expect(text).toContain("return / 2 /g;");
  });

  test("is reported where reading it for one use would regroup the template", () => {
    const { text, messages } = expand(
      "const g = 1, x = 4;\n" +
        "export function f() { pick x; }\n" +
        "export function h() { pick return; }\n",
    );
    expect(text).toContain("x / (g) / 2;");
    expect(
      messages.filter((message) =>
        message.startsWith(
          "This slash, written in a macro's template, is a regular expression where the use",
        ),
      ),
    ).toHaveLength(1);
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
