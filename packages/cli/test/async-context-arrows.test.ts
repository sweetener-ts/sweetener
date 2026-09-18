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
export syntax yieldonly:expr {
  rule { yieldonly($value:expr) }
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
  const directory = mkdtempSync(join(tmpdir(), "sweet-async-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { awaitonly, yieldonly, (<-) } from "./macros.sts" for syntax;\n${source}\n`,
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

  // An arrow written as another arrow's concise body is a function of its own,
  // and says for itself whether it is async: a plain arrow nested in an async
  // one admits no `await`, and an async arrow nested in a plain one admits one.
  //
  // Written with parentheses around it the inner arrow is a node the walk
  // descends into, which answers for it. Written without them the two arrows
  // are one run of tokens, and the walk measured only the outer of them: the
  // inner body inherited the outer arrow's header.
  const nestedArrows: readonly (readonly [
    string,
    string,
    readonly string[],
    string,
  ])[] = [
    [
      "a plain arrow nested in an async one",
      "const handler = async (v: number) => () => awaitonly(1);",
      [refusal],
      "async (v: number) => () => awaitonly(1)",
    ],
    [
      "a plain arrow with a block body nested in an async one",
      "const handler = async (v: number) => () => { return awaitonly(1); };",
      [refusal],
      "async (v: number) => () => { return awaitonly(1); }",
    ],
    [
      "an async arrow nested in a plain one",
      "const handler = (v: number) => async () => awaitonly(1);",
      [],
      "(v: number) => async () => (await 1)",
    ],
    [
      "an async arrow with a block body nested in a plain one",
      "const handler = (v: number) => async () => { return awaitonly(1); };",
      [],
      "(v: number) => async () => { return (await 1); }",
    ],
    [
      "a plain arrow nested two deep in an async one",
      "const handler = async (v: number) => () => () => awaitonly(1);",
      [refusal],
      "async (v: number) => () => () => awaitonly(1)",
    ],
    [
      // The inner arrow ends at the conditional's `:`, and what follows it is
      // back inside the outer arrow, which is async.
      "a plain arrow in the consequent of an async arrow's conditional body",
      "const handler = async (v: number) => v ? () => awaitonly(1) : awaitonly(2);",
      [refusal],
      "async (v: number) => v ? () => awaitonly(1) : (await 2)",
    ],
  ];

  for (const [name, statement, messages, expansion] of nestedArrows) {
    test(`reads ${name} by its own header, in a block that parses`, () => {
      const expanded = expand(
        `export function g(): unknown { const total = 1; ${statement} return [total, handler]; }`,
      );
      expect(expanded.messages).toEqual(messages);
      expect(expanded.text).toContain(expansion);
    });

    test(`reads ${name} by its own header, in a block walked as tokens`, () => {
      const expanded = expand(
        `export function g(): unknown { total <- 1; ${statement} return [total, handler]; }`,
      );
      expect(expanded.messages).toEqual(messages);
      expect(expanded.text).toContain(expansion);
    });
  }

  // The same boundary read in the generator direction. An arrow is a generator
  // in no case, so `yield` is an expression nowhere in one however deeply it is
  // nested inside a `function*` -- while the generator's own body still admits
  // it after the arrow ends.
  const generatorRefusal =
    "No rule for macro yieldonly accepted this input: generator context.";
  const inGenerator: readonly (readonly [string, string])[] = [
    ["an arrow", "const h = () => yieldonly(1);"],
    ["an arrow with a block body", "const h = () => { return yieldonly(1); };"],
    ["an arrow nested in an arrow", "const h = () => () => yieldonly(1);"],
    [
      "an async arrow nested in an arrow",
      "const h = () => async () => yieldonly(1);",
    ],
  ];

  for (const [name, statement] of inGenerator) {
    test(`is refused in ${name} inside a generator, in a block that parses`, () => {
      const { text, messages } = expand(
        `export function* g(): Generator<number, unknown, unknown> { const total = 1; ${statement} return [total, h]; }`,
      );
      expect(messages).toEqual([generatorRefusal]);
      expect(text).toContain("yieldonly(1)");
    });

    test(`is refused in ${name} inside a generator, in a block walked as tokens`, () => {
      const { text, messages } = expand(
        `export function* g(): Generator<number, unknown, unknown> { total <- 1; ${statement} return [total, h]; }`,
      );
      expect(messages).toEqual([generatorRefusal]);
      expect(text).toContain("yieldonly(1)");
    });
  }

  test("is still admitted in the generator itself after an arrow's body ends", () => {
    const { text, messages } = expand(
      "export function* g(): Generator<number, unknown, unknown> { total <- 1; const h = () => total; return yieldonly(h()); }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(yield h())");
  });

  // `async` modifies the parameters written after it on the same line. With a
  // line break between them TypeScript reads an ordinary name, ends the
  // declaration there, and reads the arrow under it as a plain one of its own
  // -- admitting no `await` even inside an async function.
  const separatedAsync = `const async = 1;
  const handler = async
  v => awaitonly(v);`;

  // The same rule where the `async` stands in front of a function rather than
  // in front of an arrow's parameters. Alone at the end of its line it is an
  // ordinary name, and the `function` written under it is a plain one:
  // TypeScript reads three statements there, the middle of them `async`.
  test.each([
    ["a block that parses", "const total = 1;"],
    ["a block walked as tokens", "total <- 1;"],
  ])(
    "is refused in a function under an `async` left on its own line, in %s",
    (_name, opening) => {
      const { text, messages } = expand(
        `export function f(): unknown {
  ${opening}
  const async = 1;
  async
  function g(): number { return awaitonly(1); }
  return [total, async, g];
}`,
      );
      expect(messages).toEqual([refusal]);
      expect(text).toContain("awaitonly(1)");
    },
  );

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

  /**
   * An arrow whose one unparenthesized parameter is spelled by a contextual
   * keyword. `type`, `of` and `from` are keyword tokens to the scanner and
   * ordinary names to the grammar, and the walk had asked for the `identifier`
   * label rather than for the rule that says which words may name a binding.
   * So the closure was not recognized as one and its body inherited the
   * context of the function around it.
   */
  test.each([["type"], ["of"], ["from"], ["readonly"], ["async"]])(
    "reads an async arrow whose parameter is spelled `%s` by its own header",
    (name) => {
      const { text, messages } = expand(
        `type Handler = (v: number) => Promise<number>;
export function g(): unknown { total <- 1; const handler: Handler = async ${name} => awaitonly(${name}); return [total, handler]; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain(`async ${name} => (await ${name})`);
    },
  );

  test.each([["type"], ["of"], ["from"], ["readonly"]])(
    "reads a plain arrow whose parameter is spelled `%s` by its own header",
    (name) => {
      const { text, messages } = expand(
        `export async function g(): Promise<unknown> { total <- 1; const handler = ${name} => awaitonly(${name}); return [total, handler]; }`,
      );
      expect(messages).toEqual([refusal]);
      expect(text).toContain(`${name} => awaitonly(${name})`);
    },
  );
});

/**
 * A private method's body is a function body of its own.
 *
 * `#m` is one token of its own kind, and the rule that reads what a brace
 * opens listed every kind of name a method may carry but that one. So a
 * private method's brace was never a function brace: its parameters bound
 * nothing, and its body inherited whether the syntax around it was async and
 * whether it was a generator.
 */
describe("a macro written in a private method's body", () => {
  test("is refused where the method is not async, at a module's top level", () => {
    const { text, messages } = expand(
      "export class C { #m(): number { return awaitonly(1); } }",
    );
    expect(messages).toEqual([refusal]);
    expect(text).toContain("awaitonly(1)");
  });

  test("is refused where the method is not async, in a block walked as tokens", () => {
    const { text, messages } = expand(
      "export function g(): unknown { total <- 1; class C { #m(): number { return awaitonly(1); } } return [total, C]; }",
    );
    expect(messages).toEqual([refusal]);
    expect(text).toContain("awaitonly(1)");
  });

  test("is refused in a plain private method of an async function's class", () => {
    const { text, messages } = expand(
      "export async function g(): Promise<unknown> { total <- 1; class C { #m(): number { return awaitonly(1); } } return [total, C]; }",
    );
    expect(messages).toEqual([refusal]);
    expect(text).toContain("awaitonly(1)");
  });

  test("is admitted where the private method is async", () => {
    const { text, messages } = expand(
      "export class C { async #m(): Promise<number> { return awaitonly(1); } }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return (await 1)");
  });

  test("is admitted in a private generator method", () => {
    const { text, messages } = expand(
      "export class C { *#m(): Generator<number> { yieldonly(1); } }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(yield 1)");
  });

  test("is refused in a private method that is no generator", () => {
    const { text, messages } = expand(
      "export class C { #m(): number { yieldonly(1); return 1; } }",
    );
    expect(messages).toEqual([
      "No rule for macro yieldonly accepted this input: generator context.",
    ]);
    expect(text).toContain("yieldonly(1)");
  });
});
