import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * What a brace opens, read from what stands before it, and what the names in
 * front of it mean.
 *
 * A function's body binds its parameters and decides whether `await` and
 * `yield` are expressions inside it; a class's or an enum's body is a member
 * list; anything else is a block or an object literal. The header is read
 * back from the brace, and each misreading here either shadowed a macro with
 * a parameter that was never one, left one unshadowed by a parameter that
 * was, or wrote an `await` into a function that is not async -- with nothing
 * said in any case.
 */

const macros = `
export syntax x:expr {
  rule { x } => { 99 }
}
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
  const directory = mkdtempSync(join(tmpdir(), "sweet-brace-header-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { x, awaitonly, (<-) } from "./macros.sts" for syntax;\n` +
      `declare function use(...values: unknown[]): unknown;\n` +
      `declare const o: Record<string, number>;\n${source}\n`,
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

describe("a word spelled like a declaring keyword", () => {
  test("read through a member access heads nothing", () => {
    const { text, messages } = expand(
      "export function f() { return o.class || { k: x }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("o.class || { k: 99 }");
  });

  test("as a key in a raw run heads nothing", () => {
    const { text, messages } = expand(
      "export function f() { one <- 1; return { a: one, enum: { k: x } }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("enum: { k: 99 }");
  });

  test("as a member in a raw run ends no expression", () => {
    const { text, messages } = expand(
      "export function f() { one <- 1; return o.type + x + one; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("o.type + 99 + one");
  });

  test("still heads a class expression's body", () => {
    const { text, messages } = expand(
      "export const C = class { m(x: number) { return x; } };",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return x;");
  });
});

describe("a parameter list behind its body", () => {
  test("is found behind a parenthesized return type", () => {
    const { text, messages } = expand(
      "export function g(x: number): (number) { return x; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("g(x: number): (number) { return x; }");
  });

  test("is found behind an optional method's `?`", () => {
    const { text, messages } = expand(
      "export class C { m?(x: number) { return x; } }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("m?(x: number) { return x; }");
  });

  test("makes neither of those functions async because the one around is", () => {
    const { messages } = expand(
      "export async function h() {\n" +
        "  function f(p: Promise<number>): (number) { return awaitonly(p); }\n" +
        "  class C { m?(p: Promise<number>) { return awaitonly(p); } }\n" +
        "  return [f, C];\n" +
        "}",
    );
    expect(messages).toHaveLength(2);
    for (const message of messages)
      expect(message).toContain("No rule for macro awaitonly");
  });

  test("is a call where a block stands on the line under it", () => {
    const { text, messages } = expand(
      "export function f() {\n  one <- 1;\n  use(x)\n  { use(x, one) }\n}",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("use(99) { use(99, one) }");
  });

  test("is still a method's in a literal a raw run walked as a block", () => {
    const { text, messages } = expand(
      "export function f() { one <- 1; return { m(x: number) { return x + one; } }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return x + one;");
  });
});

describe("an enum body", () => {
  test("is split only at commas between members", () => {
    const { text, messages } = expand(
      "declare function id<A, B>(value: unknown): number;\n" +
        "export enum E { A = id<number, string>(x), B = x }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("A = id<number, string>(99), B = 99");
  });

  test("binds its members in their initializers", () => {
    const { text, messages } = expand("export enum E { x = 1, y = x * 2 }");
    expect(messages).toEqual([]);
    expect(text).toContain("y = x * 2");
  });
});

describe("a shorthand property", () => {
  test("keeps its name as the key where a macro is its value", () => {
    const { text, messages } = expand("export const v = { x, k: 1 };");
    expect(messages).toEqual([]);
    expect(text).toContain("{ x: 99, k: 1 }");
  });

  test("written alone keeps its name as the key", () => {
    const { text, messages } = expand("export const v = { x };");
    expect(messages).toEqual([]);
    expect(text).toContain("{ x: 99 }");
  });

  test("is written as it was where it names an ordinary binding", () => {
    const { text, messages } = expand(
      "const k = 1;\nexport const v = { k, x };",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("{ k, x: 99 }");
  });
});

describe("a brace where an operand begins in a block walked as tokens", () => {
  test("is an object literal after `return`", () => {
    const { text, messages } = expand(
      "export function f() { one <- 1; return { a: one, x() { return 2; } }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("{ a: one, x() { return 2; } }");
  });

  test("keeps a shorthand's name as its key", () => {
    const { text, messages } = expand(
      "export function f() { one <- 1; return { x, one }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("{ x: 99, one }");
  });

  test("holds a method whose body opens on the next line", () => {
    const { text, messages } = expand(
      "export function f() {\n  one <- 1;\n  return {\n    m(x: number)\n    {\n      return x + one;\n    }\n  };\n}",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("m(x: number) { return x + one; }");
  });

  test("is an object literal after an operator", () => {
    const { text, messages } = expand(
      "export function f(c: boolean) { one <- 1; return c ? { x } : { k: one }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("c ? { x: 99 } : { k: one }");
  });

  test("is a block on the line under a `return`", () => {
    const { text } = expand(
      "export function f() { one <- 1; return\n{ use(x, one); } }",
    );
    expect(text).toContain("{ use(99, one); }");
  });
});
