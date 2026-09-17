import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A macro declared `context generator` written inside an arrow, in a block the
 * expander walks as raw tokens.
 *
 * `yield` belongs to the function it is written directly in, and an arrow is
 * never a generator. Where a block is parsed, an arrow arrives as one node and
 * descending into it clears the context. Where it is walked as tokens -- a
 * block holding a statement operator is, by design -- the arrow is only a run
 * of tokens, nothing is descended into, and the context of the generator
 * around it reached the arrow's body. The macro was admitted there and emitted
 * a `yield` inside an arrow, which is not an expression: the refusal the
 * language promises became a TypeScript error on generated code.
 */

const macros = `
export syntax genonly:expr {
  rule { genonly($value:expr) }
  context generator;
  => { (yield $value) }
}
export operator (<-):stmt {
  fixity infix;
  associativity none;
  precedence 20;
  rule { $name:binding <- $source:expr; }
  bind $name in following as lexical value;
  => { const $name = $source; }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-generator-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { genonly, (<-) } from "./macros.sts" for syntax;\n${source}\n`,
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

/** The refusal the language promises for a generator-only macro. */
const refusal =
  "No rule for macro genonly accepted this input: generator context.";

describe("a generator-only macro inside an arrow", () => {
  const arrows: readonly (readonly [string, string])[] = [
    ["a concise body", "const handler = () => genonly(1);"],
    [
      "a named parameter and a concise body",
      "const handler = (v) => genonly(v);",
    ],
    ["a block body", "const handler = () => { return genonly(1); };"],
    [
      "a concise body after a type annotation",
      "const handler: () => number = () => genonly(1);",
    ],
    ["a nested arrow", "const handler = () => () => genonly(1);"],
    ["an argument list", "const handler = [1].map(() => genonly(1));"],
  ];

  for (const [name, statement] of arrows) {
    test(`is refused in ${name}, in a block walked as tokens`, () => {
      const { text, messages } = expand(
        `export function* g(): Generator<number> { total <- 1; ${statement} yield total; }`,
      );
      expect(messages).toEqual([refusal]);
      expect(text).not.toContain("yield 1");
      expect(text).toContain("genonly(");
    });

    test(`is refused in ${name}, in a block that parses`, () => {
      const { text, messages } = expand(
        `export function* g(): Generator<number> { const total = 1; ${statement} yield total; }`,
      );
      expect(messages).toEqual([refusal]);
      expect(text).not.toContain("yield 1");
      expect(text).toContain("genonly(");
    });
  }

  test("is still admitted in the generator itself, in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export function* g(): Generator<number> { total <- 1; yield genonly(total); }",
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export function* g(): Generator<number> { const total = 1; yield (yield total); }",
    );
  });

  test("is still admitted after an arrow's body ends, in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export function* g(): Generator<number> { total <- 1; const handler = () => total; yield genonly(handler()); }",
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export function* g(): Generator<number> { const total = 1; const handler = () => total; yield (yield handler()); }",
    );
  });

  test("is still admitted in a function written inside a generator, when that function is one", () => {
    const { text, messages } = expand(
      "export function* g(): Generator<number> { total <- 1; function* inner(): Generator<number> { yield genonly(total); } yield total; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("yield (yield total)");
  });
});
