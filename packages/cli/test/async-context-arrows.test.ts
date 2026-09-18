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
      "an unparenthesized parameter and a concise body",
      "const handler = v => awaitonly(v);",
    ],
    [
      "an unparenthesized parameter and a block body",
      "const handler = v => { return awaitonly(v); };",
    ],
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

  // `async v => …` is read from its head rather than from the operand before
  // its `=>`, where only the name stands and the `async` would be dropped.
  // Read that way the arrow was not one at all, its statement did not parse,
  // and the plain function around it refused the `await` the arrow admits.
  //
  // The parameter is typed by an alias rather than by a function type written
  // beside it, so that the annotation holds no `=>` of its own.
  const aliases = `type Handler = (v: number) => Promise<number>;
type Nested = (v: number) => Promise<(w: number) => Promise<number>>;`;
  const unparenthesized: readonly (readonly [string, string, string])[] = [
    [
      "a concise body",
      "const handler: Handler = async v => awaitonly(v);",
      "async v => (await v)",
    ],
    [
      "a block body",
      "const handler: Handler = async v => { return awaitonly(v); };",
      "async v => { return (await v); }",
    ],
    [
      "a nested unparenthesized async arrow",
      "const handler: Nested = async v => async w => awaitonly(v + w);",
      "async v => async w => (await (v + w))",
    ],
  ];

  for (const [name, statement, expansion] of unparenthesized) {
    test(`is admitted in an unparenthesized async arrow with ${name}, in a block that parses`, () => {
      const { text, messages } = expand(
        `${aliases}
export function g(): unknown { const total = 1; ${statement} return [total, handler]; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain(expansion);
    });

    test(`is admitted in an unparenthesized async arrow with ${name}, in a block walked as tokens`, () => {
      const { text, messages } = expand(
        `${aliases}
export function g(): unknown { total <- 1; ${statement} return [total, handler]; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain(expansion);
    });
  }

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

  // A conditional written as an arrow's concise body keeps its own `:`. The
  // arrow was measured by stopping at the first `:` beside its body, so the
  // alternate fell outside the arrow: the consequent got the arrow's async
  // context and the alternate got the enclosing function's, and the two
  // branches of one expression disagreed.
  const conditionals: readonly (readonly [string, string, string])[] = [
    [
      "a conditional body",
      "const handler = async (v: number) => v ? awaitonly(1) : awaitonly(2);",
      "async (v: number) => v ? (await 1) : (await 2)",
    ],
    [
      "a conditional nested in the consequent",
      "const handler = async (v: number) => v ? v ? awaitonly(1) : 2 : awaitonly(3);",
      "async (v: number) => v ? v ? (await 1) : 2 : (await 3)",
    ],
    [
      "a conditional nested in the alternate",
      "const handler = async (v: number) => v ? awaitonly(1) : v ? awaitonly(2) : 3;",
      "async (v: number) => v ? (await 1) : v ? (await 2) : 3",
    ],
    [
      "an object-literal body holding a conditional",
      "const handler = async (v: number) => ({ a: v ? awaitonly(1) : awaitonly(2) });",
      "async (v: number) => ({ a: v ? (await 1) : (await 2) })",
    ],
  ];

  for (const [name, statement, expansion] of conditionals) {
    test(`reaches the whole of ${name}, in a block that parses`, () => {
      const { text, messages } = expand(
        `export function g(): unknown { const total = 1; ${statement} return [total, handler]; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain(expansion);
    });

    test(`reaches the whole of ${name}, in a block walked as tokens`, () => {
      const { text, messages } = expand(
        `export function g(): unknown { total <- 1; ${statement} return [total, handler]; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain(expansion);
    });
  }

  // The same extent read from the other side: a plain arrow inside an async
  // function admits no `await` anywhere in its body, alternate included. The
  // alternate used to fall outside the arrow, where the function's own context
  // reached it and the macro was admitted against what TypeScript says.
  const plainInsideAsync: readonly (readonly [string, string])[] = [
    [
      "a conditional body",
      "const handler = (v: number) => v ? awaitonly(1) : awaitonly(2);",
    ],
    [
      // Each branch is an arrow of its own, and a plain one.
      "a conditional whose branches are arrows",
      "const handler = (v: number) => v ? () => awaitonly(1) : () => awaitonly(2);",
    ],
  ];

  for (const [name, statement] of plainInsideAsync) {
    test(`is refused throughout ${name} of a plain arrow inside an async function, in a block that parses`, () => {
      const { text, messages } = expand(
        `export async function g(): Promise<unknown> { const total = 1; ${statement} return [total, handler]; }`,
      );
      expect(messages).toEqual([refusal, refusal]);
      expect(text).toContain(statement.slice("const handler = ".length, -1));
    });

    test(`is refused throughout ${name} of a plain arrow inside an async function, in a block walked as tokens`, () => {
      const { text, messages } = expand(
        `export async function g(): Promise<unknown> { total <- 1; ${statement} return [total, handler]; }`,
      );
      expect(messages).toEqual([refusal, refusal]);
      expect(text).toContain(statement.slice("const handler = ".length, -1));
    });
  }

  // `async` modifies the parameters written after it on the same line. With a
  // line break between them TypeScript reads an ordinary name, ends the
  // declaration there, and reads the arrow under it as a plain one of its own
  // -- admitting no `await` even inside an async function.
  const separatedAsync = `const async = 1;
  const handler = async
  v => awaitonly(v);`;

  test("is refused in the arrow under an `async` left on its own line, in a block that parses", () => {
    const { text, messages } = expand(
      `export async function g(): Promise<unknown> {
  ${separatedAsync}
  return [async, handler];
}`,
    );
    expect(messages).toEqual([refusal]);
    expect(text).toContain("awaitonly(v)");
  });

  test("is refused in the arrow under an `async` left on its own line, in a block walked as tokens", () => {
    const { text, messages } = expand(
      `export async function g(): Promise<unknown> {
  total <- 1;
  ${separatedAsync}
  return [total, async, handler];
}`,
    );
    expect(messages).toEqual([refusal]);
    expect(text).toContain("awaitonly(v)");
  });
});
