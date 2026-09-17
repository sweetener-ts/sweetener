import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Where a name is a name rather than a macro reference.
 *
 * A macro's spelling is not reserved. The same word names a property, a member
 * of an object literal, a label, and whatever a declaration binds, and in every
 * one of those places it means itself. Dispatching there rewrites syntax that
 * never invoked the macro; reporting there blames code that is correct. Both
 * are decided by asking whether the position would dispatch the macro at all.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}
export syntax mkItem:item {
  rule { mkItem } => { export const thing = 1; }
}
export syntax boxed:type {
  rule { boxed } => { readonly number[] }
}
export syntax boxedMember:typeMember {
  rule { boxedMember } => { readonly at: number; }
}
`;

interface Expansion {
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string, module = "ESNext"): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-name-position-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "other.ts"),
    "export const twice = 3;\nexport type boxed = number;\nexport const boxed = 4;\n",
  );
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice, mkItem, boxed, boxedMember } from "./macros.sts" for syntax;\n${source}\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module,
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "other.ts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  const text =
    expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
      ?.generated.text ?? "";
  return {
    text,
    messages: expanded.diagnostics.map(({ messageText }) =>
      String(messageText),
    ),
  };
}

describe("a name that shadows a macro", () => {
  const shadowing: readonly (readonly [string, string])[] = [
    [
      "a rest parameter",
      "export function f(...twice: number[]) { return twice; }",
    ],
    [
      "a parameter property",
      "export class C { held: number; constructor(private twice: number) { this.held = twice; } }",
    ],
    [
      "a statement label",
      "export function f() { twice: for (;;) { break twice; } }",
    ],
    [
      "a namespace import",
      'import * as twice from "./other.js";\nexport const p = twice.twice;',
    ],
    [
      "a default import",
      'import twice from "./other.js";\nexport const p = twice;',
    ],
  ];
  for (const [name, source] of shadowing) {
    test(`${name} is not dispatched as one`, () => {
      expect(expand(source).messages).toEqual([]);
    });
  }

  test("an import equals is not dispatched as one", () => {
    expect(
      expand(
        'import twice = require("./other.js");\nexport const p = twice.twice;',
        "CommonJS",
      ).messages,
    ).toEqual([]);
  });

  test("an import is a type as well as a value", () => {
    // An import binds its local name in whichever namespaces the module
    // exports it in, so a macro of that spelling is shadowed in both.
    const { text, messages } = expand(
      'import { boxed } from "./other.js";\nexport const p: boxed = 1;',
    );
    expect(messages).toEqual([]);
    expect(text).toContain(": boxed");
  });
});

describe("a name an object literal writes", () => {
  // Each member written twice: once bare and once with the return type that
  // stands between its parameter list and its body, which is where the name of
  // a method is furthest from the brace that makes it one.
  const members: readonly (readonly [string, string])[] = [
    ["a method", "twice(value: number) { return value; }"],
    ["an annotated method", "twice(value: number): number { return value; }"],
    ["a generic method", "twice<T>(value: T): T { return value; }"],
    [
      "a method returning an object type",
      "twice(): { a: number } { return { a: 1 }; }",
    ],
    ["a getter", "get twice() { return 1; }"],
    ["an annotated getter", "get twice(): number { return 1; }"],
    ["a setter", "set twice(value: number) { void value; }"],
    ["an async method", "async twice() { return 1; }"],
    [
      "an annotated async method",
      "async twice(): Promise<number> { return 1; }",
    ],
    ["a generator method", "*twice() { yield 1; }"],
    [
      "an annotated generator method",
      "*twice(): Generator<number, void, unknown> { yield 1; }",
    ],
    [
      "an annotated async generator method",
      "async *twice(): AsyncGenerator<number, void, unknown> { yield 1; }",
    ],
  ];
  for (const [name, member] of members) {
    test(`${name} keeps its name`, () => {
      const { text, messages } = expand(`export const o = { ${member} };`);
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
    });

    test(`${name} keeps its name after an annotated member`, () => {
      // The member before it ends in a body rather than in a `;`, so whatever
      // decides where this one begins has to find the `,` between them.
      const { text, messages } = expand(
        `export const o = { first(): number { return 1; }, ${member} };`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
    });
  }

  test("a computed key is still an expression", () => {
    const { text, messages } = expand("export const o = { [twice(1)[0]]: 2 };");
    expect(messages).toEqual([]);
    expect(text).toContain("[[1, 1][0]]: 2");
  });

  test("a computed key of a method is still an expression", () => {
    const { text, messages } = expand(
      "export const o = { [twice(1)[0] as unknown as string](v: number): number { return v; } };",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("[1, 1][0]");
  });

  test("a member whose value is an invocation is still expanded", () => {
    // A name followed by a parenthesised group is a method only where a body
    // ends the member; written without one it is a call like any other.
    const { text, messages } = expand("export const o = { held: twice(1) };");
    expect(messages).toEqual([]);
    expect(text).toContain("[1, 1]");
  });
});

describe("a name a member list writes", () => {
  const members: readonly (readonly [string, string])[] = [
    ["a class method", "export class C { twice() { return 1; } }"],
    [
      "an annotated class method",
      "export class C { twice(): number { return 1; } }",
    ],
    [
      "an annotated class getter",
      "export class C { get twice(): number { return 1; } }",
    ],
    [
      "a static annotated class method",
      "export class C { static twice(): number { return 1; } }",
    ],
    ["an optional class field", "export class C { twice?: number; }"],
    ["a definite class field", "export class C { twice!: number; }"],
    [
      "an annotated interface member",
      "export interface I { twice(): number; }",
    ],
    ["an optional interface member", "export interface I { twice?: number; }"],
    [
      "an annotated type literal member",
      "export type T = { twice(): number };",
    ],
    ["an optional type literal member", "export type T = { twice?: number };"],
  ];
  for (const [name, source] of members) {
    test(`${name} keeps its name`, () => {
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
    });
  }
});

/**
 * Syntax recovery leaves an item it could not read as it was written, and what
 * it swallowed must be reported rather than emitted in silence — but only
 * where the name it swallowed would have been dispatched as a macro at all.
 */
describe("an item recovery could not read", () => {
  const swallowed = "Sweetener could not read this item";

  const innocent: readonly (readonly [string, string])[] = [
    [
      "a property read off a value",
      ") declare const o: { twice: number };\nexport const q = o.twice;",
    ],
    ["a key in an object literal", ") const o = { twice: 1 };"],
    ["a name a declaration annotates", ") declare const twice: number;"],
    ["a label", ") export function f() { twice: for (;;) { break twice; } }"],
    [
      "a binding that shadows the macro",
      ") export function f() { const twice = 1; return twice; }",
    ],
    ["a class member's name", ") export class C { mkItem() {} }"],
    [
      "an annotated class member's name",
      ") export class C { mkItem(): number { return 1; } }",
    ],
  ];
  for (const [name, source] of innocent) {
    test(`says nothing about ${name}`, () => {
      expect(expand(source).messages.join("\n")).not.toContain(swallowed);
    });
  }

  test("still reports a macro it really did leave unexpanded", () => {
    // A member macro reads in a member list and nowhere else, so an item run
    // asks about the position, finds nothing, and nothing else speaks for it.
    const { text, messages } = expand(") export interface I { boxedMember; }");
    expect(text).toContain("boxedMember");
    expect(messages.join("\n")).toContain(swallowed);
  });
});
