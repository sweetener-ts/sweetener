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
    "export const twice = 3;\nexport type boxed = number;\nexport const boxed = 4;\nconst fallback = 5;\nexport default fallback;\n",
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
    // A method names itself with a property name, and a private name is one:
    // `#m` is a single token of its own kind, which the rule that reads a
    // brace's header had left out, so the parameters of a private method bound
    // nothing at all.
    [
      "a private method's parameter",
      "export class C { #m(twice: (v: number) => number) { return twice(1); } }",
    ],
    [
      "a generic private method's parameter",
      "export class C { #m<T>(twice: (v: T) => T, v: T) { return twice(v); } }",
    ],
    [
      "a static private method's parameter",
      "export class C { static #m(twice: (v: number) => number) { return twice(1); } }",
    ],
    [
      "an async private method's parameter",
      "export class C { async #m(twice: (v: number) => number) { return twice(1); } }",
    ],
    [
      "a method named by a bigint literal, in its parameter",
      "export class C { 1n(twice: (v: number) => number) { return twice(1); } }",
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
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      // A name the macro was dispatched on is gone from the emitted text, and
      // the replacement stands where it was written; a name that shadowed the
      // macro is still spelled out.
      expect(text).toContain("twice");
      expect(text).not.toContain("[1, 1]");
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

  /**
   * `import type ...` writes a modifier where a binding otherwise stands, and
   * the name after it is still what the clause binds. Read as the `type` of a
   * type alias, the clause bound the name in the type namespace alone, so a
   * value macro of that spelling was still dispatched on a name the file had
   * imported for itself. What that name may be used for afterwards is
   * TypeScript's to report; rewriting it here is not.
   */
  const typeOnlyImports: readonly (readonly [string, string])[] = [
    ["a default binding", 'import type twice from "./other.js";'],
    ["a named specifier", 'import type { twice } from "./other.js";'],
    [
      "a renamed specifier",
      'import type { boxed as twice } from "./other.js";',
    ],
    ["a namespace binding", 'import type * as twice from "./other.js";'],
    [
      "a default binding beside a named one",
      'import type twice, { boxed } from "./other.js";',
    ],
  ];
  for (const [name, clause] of typeOnlyImports) {
    test(`a type-only import with ${name} is not dispatched as one`, () => {
      const { text, messages } = expand(`${clause}\nexport const p = twice;`);
      expect(messages).toEqual([]);
      expect(text).toContain("p = twice");
    });
  }

  test.each([
    ["on its own", "type boxed = number;"],
    [
      "after an import",
      'import fallback from "./other.js";\nvoid fallback;\ntype boxed = number;',
    ],
    [
      "after a type-only import",
      'import type fallback from "./other.js";\ntype boxed = number;',
    ],
  ])("a type alias %s still declares its name", (_, source) => {
    // The `type` of an alias is what names it; only the `type` of an import
    // clause is a modifier.
    const { text, messages } = expand(`${source}\nexport type P = boxed;`);
    expect(messages).toEqual([]);
    expect(text).toContain("P = boxed");
    expect(text).not.toContain("readonly number[]");
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

/**
 * A name written inside an import or export specifier list, or as the one a
 * `* as` introduces, is a specifier: it names an export of a module, or the
 * local binding a clause re-exports, and nothing there can be an invocation.
 * Dispatching there rejected ordinary TypeScript -- `export { twice } from
 * "./other.js"` re-exports the other module's `twice`, which the emitted code
 * does define -- and reported it against a macro the file only imported for
 * syntax.
 */
describe("a name an import or export clause writes", () => {
  const clauses: readonly (readonly [string, string])[] = [
    ["a re-exported name", 'export { twice } from "./other.js";'],
    [
      "a re-exported name given the spelling",
      'export { boxed as twice } from "./other.js";',
    ],
    [
      "a re-exported name renamed away",
      'export { twice as other } from "./other.js";',
    ],
    ["a namespace re-export", 'export * as twice from "./other.js";'],
    [
      "an imported name renamed away",
      'import { twice as t2 } from "./other.js";\nvoid t2;',
    ],
    [
      "an imported name given the spelling",
      'import { boxed as twice } from "./other.js";\nvoid twice;',
    ],
    ["a type-only re-export", 'export type { twice } from "./other.js";'],
    [
      "a type-only import",
      'import type { twice } from "./other.js";\nexport type P = typeof twice;',
    ],
    [
      "an inline type specifier",
      'import { type twice } from "./other.js";\nexport type P = typeof twice;',
    ],
    [
      "a default binding beside a specifier list",
      'import fallback, { twice as t2 } from "./other.js";\nvoid fallback;\nvoid t2;',
    ],
    ["a local re-export of a binding", "const twice = 1;\nexport { twice };"],
  ];
  for (const [name, source] of clauses) {
    test(`${name} is not dispatched as one`, () => {
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
      expect(text).not.toContain("[1, 1]");
    });
  }

  /**
   * A local `export { name }` re-exports a binding of this module, so a name
   * no binding declares does not exist -- but that is TypeScript's `TS2304`
   * to report about a name, not a macro report about an invocation that was
   * never written. The clause is a specifier list either way.
   */
  test("a local re-export of nothing is left for TypeScript to report", () => {
    const { text, messages } = expand("export { twice };");
    expect(messages).toEqual([]);
    expect(text).toContain("export { twice }");
  });

  test("a name after the clause is still dispatched", () => {
    const { text, messages } = expand(
      'export { boxed } from "./other.js";\nexport const p = twice(1);',
    );
    expect(messages).toEqual([]);
    expect(text).toContain("[1, 1]");
  });

  test("the `as` of a type assertion still reads a type", () => {
    // `as` inside an export declaration is a specifier's only where a `*`
    // stands in front of it.
    const { text, messages } = expand("export const p = [] as boxed;");
    expect(messages).toEqual([]);
    expect(text).toContain("readonly number[]");
  });

  test("an import attribute is still read as what it is", () => {
    const { messages } = expand(
      'import { boxed } from "./other.js" with { type: "json" };\nexport const p: boxed = 1;',
    );
    expect(messages).toEqual([]);
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
 * A name an enum member writes.
 *
 * An enum body is a list of members, each named and each optionally given a
 * value; the name is a name there as surely as a property's is. Walked as the
 * items or statements around it, the name stood at the head of one and was
 * dispatched, which rewrote a declaration that never mentioned the macro into
 * syntax TypeScript cannot read.
 */
describe("a name an enum member writes", () => {
  const enums: readonly (readonly [string, string])[] = [
    ["an enum member with a value", "export enum E { twice = 1 }"],
    ["an enum member with no value", "export enum E { twice }"],
    ["an enum member after another", "export enum E { first = 1, twice = 2 }"],
    [
      "an enum member before another",
      "export enum E { twice = 1, second = 2 }",
    ],
    ["a member of a const enum", "export const enum E { twice = 1 }"],
    ["a member of an ambient enum", "export declare enum E { twice = 1 }"],
    [
      "a member of an enum in a namespace",
      "export namespace N { export enum E { twice = 1 } }",
    ],
    [
      "a member of an enum in a function body",
      "export function f() { enum E { twice = 1 } return E; }",
    ],
  ];
  for (const [name, source] of enums) {
    test(`${name} keeps its name`, () => {
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
      expect(text).not.toContain("[1, 1]");
    });
  }

  test("a member's value is still an expression", () => {
    const { text, messages } = expand("export enum E { first = twice(1)[0] }");
    expect(messages).toEqual([]);
    expect(text).toContain("[1, 1][0]");
  });

  test("a string-valued member keeps its name", () => {
    const { text, messages } = expand('export enum E { twice = "twice" }');
    expect(messages).toEqual([]);
    expect(text).toContain('twice = "twice"');
  });
});

/**
 * A brace written where a return type stands is an object type, and the body
 * is the brace after the whole type. A declaration with no body at all — an
 * ambient one, an overload signature — has no later brace to settle on, and
 * the annotation was taken for the body: its members were read at statement
 * head, where a name is dispatched.
 */
describe("a bodiless signature's object-type return annotation", () => {
  const signatures: readonly (readonly [string, string])[] = [
    [
      "an ambient function declaration",
      "export declare function f(): { readonly twice: number };",
    ],
    [
      "an ambient function declaration with a plain member",
      "export declare function f(): { twice: number };",
    ],
    [
      "an ambient function declaration with a method member",
      "export declare function f(): { twice(): number };",
    ],
    [
      "an overload signature",
      "export declare function f(): { readonly twice: number };\nexport declare function f(v: number): { readonly twice: number };",
    ],
    [
      "an ambient function in a namespace",
      "export namespace N { export function f(): { readonly twice: number }; }",
    ],
  ];
  for (const [name, source] of signatures) {
    test(`${name} reads its annotation as a type`, () => {
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      expect(text).toContain("twice");
      expect(text).not.toContain("[1, 1]");
    });
  }

  test("a declaration that does have a body still reads one", () => {
    const { text, messages } = expand(
      "export function f(): { readonly twice: number } { return { twice: twice(1)[0] }; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("readonly twice: number");
    expect(text).toContain("[1, 1][0]");
  });

  test("a member macro still reads in the annotation", () => {
    const { text, messages } = expand(
      "export declare function f(): { boxedMember };",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("readonly at: number;");
  });
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
    // A member macro reads in a member list and nowhere else. Written where
    // there is no member list, an item run asks about the position, finds
    // nothing, and nothing else speaks for it.
    const { text, messages } = expand(") boxedMember;");
    expect(text).toContain("boxedMember");
    expect(messages.join("\n")).toContain(swallowed);
  });

  /**
   * An interface body recovery swallowed is still a member list, so a member
   * macro written in one is dispatched there and nothing is left unexpanded to
   * report. This was the fixture above until the body was walked as members.
   */
  test("says nothing about a member macro in an interface it swallowed", () => {
    const { text, messages } = expand(") export interface I { boxedMember; }");
    expect(text).toContain("readonly at: number;");
    expect(text).not.toContain("boxedMember");
    expect(messages.join("\n")).not.toContain(swallowed);
  });
});
