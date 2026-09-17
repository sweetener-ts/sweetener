import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * The expressions written inside things that are not expressions.
 *
 * A binding pattern names what a declaration binds, and a decorator names what
 * is applied to a member — neither is an expression. Both hold expressions all
 * the same: the default of a property, the key computed for one, the arguments
 * a decorator is called with. A macro written in one of them expands the way it
 * does anywhere else, however deeply the pattern nests.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { ($value) * 2 }
}
export syntax pair:type {
  rule { pair<$inner:type> } => { readonly [$inner, $inner] }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-binder-interior-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice, pair } from "./macros.sts" for syntax;\n${source}\n`,
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
        experimentalDecorators: true,
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  const text =
    expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
      ?.generated.text ?? "";
  return {
    text: text.replaceAll(/\s+/gu, " ").trim(),
    messages: expanded.diagnostics.map(({ messageText }) =>
      String(messageText),
    ),
  };
}

const source = "declare const source: { p: { q?: number } };\n";

describe("a default written inside a binding pattern", () => {
  const nested: readonly (readonly [string, string])[] = [
    [
      "a const declaration",
      `${source}export const { p: { q = twice(1) } } = source;`,
    ],
    [
      "a let declaration",
      `${source}export let { p: { q = twice(1) } } = source;`,
    ],
    [
      "a function parameter",
      "export function f({ p: { q = twice(1) } }: { p: { q?: number } }) { return q; }",
    ],
    [
      "a method parameter",
      "export class C { m({ p: { q = twice(1) } }: { p: { q?: number } }) { return q; } }",
    ],
    [
      "a constructor parameter",
      "export class C { held: number; constructor({ p: { q = twice(1) } }: { p: { q?: number } }) { this.held = q; } }",
    ],
    [
      "a catch parameter",
      "export function f() { try { return 0; } catch ({ p: { q = twice(1) } }: any) { return q; } }",
    ],
    [
      "an array pattern three deep",
      "declare const deep: [[{ q?: number }]];\nexport const [[{ q = twice(1) }]] = deep;",
    ],
  ];
  for (const [name, code] of nested) {
    test(`expands in ${name}`, () => {
      const { text, messages } = expand(code);
      expect(messages).toEqual([]);
      expect(text).toContain("(1) * 2");
    });
  }
});

describe("a key computed inside a binding pattern", () => {
  test("expands the expression between its brackets", () => {
    const { text, messages } = expand(
      "declare const keyed: Record<string, number>;\n" +
        "export const { [twice(1) as unknown as string]: r } = keyed;",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(1) * 2");
  });

  test("leaves the name the key binds alone", () => {
    const { text, messages } = expand(
      "declare const keyed: Record<string, number>;\n" +
        "export const { [twice(1) as unknown as string]: twice } = keyed;",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("]: twice }");
  });
});

describe("the arguments a decorator is called with", () => {
  const decorators = "declare function deco(value: number): any;\n";

  test("expand on a class", () => {
    const { text, messages } = expand(
      `${decorators}@deco(twice(1))\nexport class C {}`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(1) * 2");
  });

  test("expand on a member", () => {
    const { text, messages } = expand(
      `${decorators}export class C { @deco(twice(1)) m() {} }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(1) * 2");
  });

  test("expand on a field", () => {
    const { text, messages } = expand(
      `${decorators}export class C { @deco(twice(1)) held = 1; }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(1) * 2");
  });

  test("still read a type as a type", () => {
    const { text, messages } = expand(
      `${decorators}export class C { @deco(([1, 1] as pair<number>).length) m() {} }`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("readonly [number, number]");
  });
});
