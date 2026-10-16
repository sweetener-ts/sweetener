import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * An arrow whose parameter list begins with nothing an expression can begin
 * with, and whose body is a block: `() => {}`, `(): void => {}`, `<T,>() => {}`.
 *
 * The infix `=>` reads an arrow from the operand standing to its left, but an
 * empty parenthesis group and a `<` are not operands, so nothing could
 * begin the expression and the statement holding the arrow did not parse. A
 * statement list with one in it then fell back to a raw token walk, where an
 * expression macro written beside the arrow resolves in no category at all and
 * is emitted verbatim -- silently, with only TypeScript's later "cannot find
 * name" to show for it.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { ($value + $value) }
}
export syntax parenthesized:item {
  rule { parenthesized $name:binding; }
  bind $name in following as recursive value;
  => { export function $name() { const g = (twice: (v: number) => number) => { return twice(1); }; return g; } }
}
export syntax unparenthesized:item {
  rule { unparenthesized $name:binding; }
  bind $name in following as recursive value;
  => { export function $name() { const g: (f: (v: number) => number) => number = twice => { return twice(1); }; return g; } }
}
export syntax concise:item {
  rule { concise $name:binding; }
  bind $name in following as recursive value;
  => { export function $name() { const g: (f: (v: number) => number) => number = twice => twice(1); return g; } }
}
export syntax doubling:item {
  rule { doubling $name:binding; }
  bind $name in following as recursive value;
  => { export function $name() { return (v: number) => { return twice(v); }; } }
}
export syntax verbatim:stmt {
  rule { verbatim { $($statements:tt)* } } => { $($statements)* }
}
export syntax run:stmt {
  rule { run $statement:stmt } => { $statement }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-arrow-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice, parenthesized, unparenthesized, concise, doubling, verbatim, run } from "./macros.sts" for syntax;\n${source}\n`,
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

describe("a statement list holding a block-bodied arrow", () => {
  const shapes: readonly (readonly [string, string])[] = [
    ["const with empty parameters", "const handler = () => {};"],
    ["let with empty parameters", "let handler = () => {};"],
    ["var with empty parameters", "var handler = () => {};"],
    ["assignment", "let handler: unknown; handler = () => {};"],
    ["return", "return () => {};"],
    ["with a return type", "const handler = (): void => {};"],
    ["with type parameters", "const handler = <T,>(): void => {};"],
    [
      "with type parameters and a parameter",
      "const handler = <T,>(first: T) => { return first; };",
    ],
    ["with statements in the body", "const handler = () => { return 1; };"],
    ["async with empty parameters", "const handler = async () => {};"],
    [
      "with one parameter",
      "const handler = (first: number) => { return first; };",
    ],
    ["with a concise body", "const handler = () => 1;"],
    // A return type stands between the parameters and the `=>`, so the `=>`
    // is not beside the operand the infix reading would protect.
    [
      "with a return type and a parameter",
      "const handler = (first: number): number => { return first; };",
    ],
    [
      "async with a return type",
      "const handler = async (): Promise<void> => {};",
    ],
    // `async v => …` puts two operands in front of the `=>`, of which only the
    // name would be taken, so that reading dropped the `async`.
    [
      "async with an unparenthesized parameter",
      "const handler: (v: number) => Promise<number> = async v => { return v; };",
    ],
    [
      "async with an unparenthesized parameter and a concise body",
      "const handler: (v: number) => Promise<number> = async v => v;",
    ],
    ["inside a call", "[1].forEach(() => {});"],
    ["immediately invoked", "(() => {})();"],
  ];

  for (const [name, statement] of shapes) {
    test(`expands a macro beside an arrow ${name}`, () => {
      const { text, messages } = expand(
        `export function z(): unknown { twice(1); ${statement} return 0; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("(1 + 1);");
      expect(text).not.toContain("twice(");
    });
  }

  test("expands a macro written inside a block-bodied arrow", () => {
    const { text, messages } = expand(
      `export const handler = (): number => { return twice(3); };`,
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export const handler = (): number => { return (3 + 3); };",
    );
  });
});

/**
 * The same arrow written as the value of an object literal's member.
 *
 * An arrow whose head is one operand and whose body is a block is read through
 * the infix `=>`, which protected its parameter list as an expression; the
 * reading was unwrapped where the item reader handed its items to the
 * expander, and the object literal's own route handed its members over without
 * it. So the parameters were walked as an expression: a parameter spelled like
 * a macro was dispatched in binder position, and the arrow no longer parsed.
 */
describe("a block-bodied arrow written as an object literal's member", () => {
  const alias = "type Fn = (v: number) => number;";
  const binders: readonly (readonly [string, string])[] = [
    [
      "one parameter",
      "export const o = { handler: (twice: Fn) => { return twice(1); } };",
    ],
    [
      "an unparenthesized parameter",
      "export const o: { handler: (twice: Fn) => number } = { handler: twice => { return twice(1); } };",
    ],
    [
      "two parameters",
      "export const o = { handler: (twice: Fn, v: number) => { return twice(v); } };",
    ],
    [
      "a rest parameter",
      "export const o = { handler: (...twice: Fn[]) => { return twice[0]!(1); } };",
    ],
    [
      "a destructured parameter",
      "export const o = { handler: ({ twice }: { twice: Fn }) => { return twice(1); } };",
    ],
    [
      "a return type",
      "export const o = { handler: (twice: Fn): number => { return twice(1); } };",
    ],
    [
      "an async parameter list",
      "export const o = { handler: async (twice: Fn) => { return twice(1); } };",
    ],
    [
      "a concise body",
      "export const o = { handler: (twice: Fn) => twice(1) };",
    ],
    [
      "a nested arrow",
      "export const o = { handler: (twice: Fn) => { return () => { return twice(1); }; } };",
    ],
  ];
  for (const [name, statement] of binders) {
    test(`binds ${name} rather than dispatching it`, () => {
      const { text, messages } = expand(`${alias}\n${statement}`);
      expect(messages).toEqual([]);
      expect(text).toMatch(/\btwice\b/u);
      // Nothing the macro would have written: its replacement is a sum.
      expect(text).not.toContain(" + ");
    });
  }

  test("still expands a macro in a block-bodied arrow's body", () => {
    const { text, messages } = expand(
      "export const o = { handler: (v: number) => { return twice(v); } };",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return (v + v);");
  });

  test("still expands a macro in a block-bodied arrow with no parameters", () => {
    const { text, messages } = expand(
      "export const o = { handler: () => { return twice(1); } };",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return (1 + 1);");
  });
});

/**
 * The same arrow in a body the walk reads as a list of its own: the block of
 * an arrow, which is read as statements, and the body of a class expression,
 * which is read as members.
 *
 * Neither is read until the walk reaches it, so neither came through the item
 * reader, and the routes that read them handed their readings over without
 * unwrapping the parameter list the infix `=>` had protected. The parameter
 * was walked as the expression it had been protected as, and a parameter
 * spelled like a macro was dispatched in binder position, as it was in an
 * object literal's member.
 */
describe("a block-bodied arrow in a body the walk reads", () => {
  const alias = "type Fn = (v: number) => number;";
  const bodies: readonly (readonly [string, string])[] = [
    [
      "a statement list",
      "export const outer = () => { const g = (twice: Fn) => { return twice(1); }; return g; };",
    ],
    [
      "a class expression's method",
      "export const C = class { m() { const g = (twice: Fn) => { return twice(1); }; return g; } };",
    ],
  ];
  for (const [name, statement] of bodies) {
    test(`binds the parameter in ${name} rather than dispatching it`, () => {
      const { text, messages } = expand(`${alias}\n${statement}`);
      expect(messages).toEqual([]);
      expect(text).toMatch(/\btwice\b/u);
      expect(text).not.toContain(" + ");
    });
  }
});

/**
 * The same arrow written as a template literal's substitution, which the walk
 * reads as one expression before it enters it. That reading came through the
 * route that reads a single node, which handed it over with its parameter list
 * still protected, like the list routes did.
 */
describe("a block-bodied arrow in a template literal's substitution", () => {
  test("binds the parameter rather than dispatching it", () => {
    const { text, messages } = expand(
      "type Fn = (v: number) => number;\nexport const s = `${(twice: Fn) => { return twice(1); }}`;",
    );
    expect(messages).toEqual([]);
    expect(text).toMatch(/\btwice\b/u);
    expect(text).not.toContain(" + ");
  });
});

/**
 * The same arrow, and one with a concise body, written where no normalization
 * reaches it: in a template, in the tokens a `tt` capture hands back, and in a
 * block statement a macro captured whole.
 *
 * The infix `=>` protected its parameter list as an expression. Over source
 * text normalization took that wrapping apart again, but it keeps the nesting
 * the reader builds over what an expansion produced, which the printer reads
 * its grouping from, and it does not enter a capture it was handed. Left wrapped,
 * the parameter was walked as an expression: `twice` was dispatched where it
 * is bound, and nothing recorded the binding, so the `twice(1)` in the body
 * became `(1 + 1)` as well. The arrow now holds its parameters as written, so
 * there is no wrapping to take apart.
 */
describe("an arrow no normalization reaches", () => {
  const alias = "type Fn = (v: number) => number;";
  const placed: readonly (readonly [string, string])[] = [
    ["a template, with a parenthesized parameter", "parenthesized g;"],
    ["a template, with an unparenthesized parameter", "unparenthesized g;"],
    [
      "a template, with an unparenthesized parameter and a concise body",
      "concise g;",
    ],
    [
      "the tokens a `tt` capture hands back",
      "export function z() { verbatim { const g = (twice: Fn) => { return twice(1); }; return g; } }",
    ],
    [
      "a block statement captured whole",
      "export function z() { run { const g = (twice: Fn) => { return twice(1); }; void g; } }",
    ],
    [
      "a declaration captured whole",
      "export function z() { run const g = (twice: Fn) => { return twice(1); }; void g; }",
    ],
  ];
  for (const [name, statement] of placed) {
    test(`binds the parameter in ${name} rather than dispatching it`, () => {
      const { text, messages } = expand(`${alias}\n${statement}`);
      expect(messages).toEqual([]);
      expect(text).toMatch(/\btwice/u);
      expect(text).not.toContain(" + ");
    });
  }

  test("still expands a macro the arrow's parameter does not shadow", () => {
    const { text, messages } = expand("doubling g;");
    expect(messages).toEqual([]);
    expect(text).toMatch(/return \((v\w*) \+ \1\);/u);
  });
});
