import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * What a block walked as raw tokens still reads.
 *
 * A block holding a statement-level infix operator cannot be enforested before
 * the operator is offered its statement, because `a <- b` also reads as a
 * comparison against a negation. Such a block is therefore walked as tokens,
 * and everything the enforester would have decided about the positions inside
 * it has to be decided by the walk instead: that a statement begins where the
 * one before it ended, that an expression begins with a statement, and that
 * the `:` of a label annotates nothing.
 */

const macros = `
export operator (<-):stmt {
  fixity infix;
  associativity none;
  precedence 20;
  rule { $name:binding <- $source:expr; }
  bind $name in following as lexical value;
  => { const $name = $source; }
}

export syntax twice:expr {
  rule { twice($value:expr) } => { ($value) * 2 }
}

export syntax logit:stmt {
  rule { logit($value:expr); } => { recorded.push($value); }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-raw-walk-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { (<-), twice, logit } from "./macros.sts" for syntax;\n` +
      `export const recorded: number[] = [];\n${source}\n`,
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
    text: generated.replaceAll(/\s+/gu, " ").trim(),
    messages: result.diagnostics.map(({ messageText }) => String(messageText)),
  };
}

describe("a block walked as raw tokens", () => {
  test("expands a labelled statement macro", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  here: logit(value);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("here: recorded.push(value);");
  });

  test("expands an expression macro standing as a statement", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  twice(value);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(value) * 2");
  });

  test("expands an expression macro in a call at the head of a statement", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  recorded.push(twice(value));\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("recorded.push((value) * 2)");
  });

  test("keeps a type annotation after the label a statement carries", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  here: {\n" +
        "    const held: number = twice(value);\n" +
        "    recorded.push(held);\n" +
        "  }\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("const held: number = ((value) * 2);");
  });

  /**
   * A brace standing where an expression does is an object literal, and the
   * key of each member names it. The rule that says so had been asked only
   * where the run being walked was itself an expression, so in a block walked
   * as tokens a key spelled like a macro was dispatched and the literal was
   * rewritten into syntax TypeScript cannot read.
   */
  const literals: readonly (readonly [string, string])[] = [
    ["an initializer", "const o = { twice: 1 }; recorded.push(o.twice);"],
    [
      "an initializer after an annotation",
      "const o: { twice: number } = { twice: 1 }; recorded.push(o.twice);",
    ],
    [
      "a returned literal",
      "const o = ((): { twice: number } => ({ twice: 1 }))(); recorded.push(o.twice);",
    ],
    [
      "an argument",
      "recorded.push(((held: { twice: number }) => held.twice)({ twice: 1 }));",
    ],
    [
      "a nested literal",
      "const o = { held: { twice: 1 } }; recorded.push(o.held.twice);",
    ],
    [
      "a method's name",
      "const o = { twice(v: number) { return v; } }; recorded.push(o.twice(1));",
    ],
  ];
  for (const [name, statement] of literals) {
    test(`keeps the key of an object literal written as ${name}`, () => {
      const { text, messages } = expand(
        "export function f(source: number) {\n" +
          "  value <- source;\n" +
          `  ${statement}\n` +
          "  recorded.push(value);\n" +
          "}\n",
      );
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
      expect(text).not.toContain(") * 2");
    });
  }

  test("still expands a computed key in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  const o = { [twice(value)]: 1 };\n" +
        "  recorded.push(o[2] ?? 0);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("[(value) * 2]: 1");
  });

  test("still expands a member's value in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  const o = { held: twice(value) };\n" +
        "  recorded.push(o.held);\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("held: ((value) * 2)");
  });

  test("leaves the label a break names alone", () => {
    const { text, messages } = expand(
      "export function f(source: number) {\n" +
        "  value <- source;\n" +
        "  twice: for (;;) { recorded.push(value); break twice; }\n" +
        "}\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("break twice;");
  });
});
