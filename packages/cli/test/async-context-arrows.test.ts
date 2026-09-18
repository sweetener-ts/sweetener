import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A macro declared `context async` written inside an arrow, in a block the
 * expander walks as raw tokens.
 *
 * `await` belongs to the function it is written directly in, and an arrow is
 * async only when it is written `async`. Where a block is parsed, an arrow
 * arrives as one node and descending into it decides the context for it. Where
 * it is walked as tokens -- a block holding a statement operator is, by design
 * -- the arrow is only a run of tokens, and the context of the function around
 * it must not simply reach the arrow's body: a plain arrow written inside an
 * async function admits no `await`, and an async arrow written inside a plain
 * one admits one.
 */

const macros = `
export syntax awaitonly:expr {
  rule { awaitonly($value:expr) }
  context async;
  => { (await $value) }
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
  const directory = mkdtempSync(join(tmpdir(), "sweet-async-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { awaitonly, (<-) } from "./macros.sts" for syntax;\n${source}\n`,
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

/** The refusal the language promises for an async-only macro. */
const refusal =
  "No rule for macro awaitonly accepted this input: async context.";

describe("an async-only macro inside an arrow", () => {
  const arrows: readonly (readonly [string, string])[] = [
    ["a concise body", "const handler = () => awaitonly(1);"],
    [
      "a named parameter and a concise body",
      "const handler = (v) => awaitonly(v);",
    ],
    ["a block body", "const handler = () => { return awaitonly(1); };"],
    [
      "a concise body after a type annotation",
      "const handler: () => number = () => awaitonly(1);",
    ],
    ["a nested arrow", "const handler = () => () => awaitonly(1);"],
    ["an argument list", "const handler = [1].map(() => awaitonly(1));"],
  ];

  for (const [name, statement] of arrows) {
    test(`is refused in ${name}, in a block walked as tokens`, () => {
      const { text, messages } = expand(
        `export async function g(): Promise<number> { total <- 1; ${statement} return await total; }`,
      );
      expect(messages).toEqual([refusal]);
      expect(text).not.toContain("await 1");
      expect(text).toContain("awaitonly(");
    });

    test(`is refused in ${name}, in a block that parses`, () => {
      const { text, messages } = expand(
        `export async function g(): Promise<number> { const total = 1; ${statement} return await total; }`,
      );
      expect(messages).toEqual([refusal]);
      expect(text).not.toContain("await 1");
      expect(text).toContain("awaitonly(");
    });
  }

  test("is still admitted in the async function itself, in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export async function g(): Promise<number> { total <- 1; return awaitonly(total); }",
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export async function g(): Promise<number> { const total = 1; return (await total); }",
    );
  });

  test("is still admitted after an arrow's body ends, in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export async function g(): Promise<number> { total <- 1; const handler = () => total; return awaitonly(handler()); }",
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export async function g(): Promise<number> { const total = 1; const handler = () => total; return (await handler()); }",
    );
  });

  test("is admitted in an async arrow written inside a plain function, in a block walked as tokens", () => {
    // An arrow is async by its own header, whatever encloses it, so the
    // context is set inside one as readily as it is cleared inside a plain
    // arrow written in an async function.
    const { text, messages } = expand(
      "export function g(): () => Promise<number> { total <- 1; const handler = async () => awaitonly(total); return handler; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("async () => (await total)");
  });

  test("is admitted in an async arrow written inside a plain function, in a block that parses", () => {
    const { text, messages } = expand(
      "export function g(): () => Promise<number> { const total = 1; const handler = async () => awaitonly(total); return handler; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("async () => (await total)");
  });

  test("is still admitted in a function written inside an async one, when that function is async", () => {
    const { text, messages } = expand(
      "export async function g(): Promise<number> { total <- 1; async function inner(): Promise<number> { return awaitonly(total); } return inner(); }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return (await total)");
  });

  test("is refused in a plain function written inside an async one", () => {
    const { text, messages } = expand(
      "export async function g(): Promise<number> { total <- 1; function inner(): number { return awaitonly(total); } return inner(); }",
    );
    expect(messages).toEqual([refusal]);
    expect(text).toContain("awaitonly(");
  });
});
