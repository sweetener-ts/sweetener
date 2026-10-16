import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Where a binder hides a macro of its spelling: within its scope, and nowhere
 * else.
 *
 * A parameter is bound in its function, a `catch` binding in its block, a
 * loop variable in its loop, a block's `let`, `const` and functions in the
 * block, and `var` in the whole function; a function or class expression's
 * name inside that expression; a type parameter in what declares it, a mapped
 * type's key in that type, and what `infer` names in its `extends` clause and
 * true branch. Each case is written twice: as the file's own items, which the
 * walk reads as nodes, and handed back by a macro's `tt` replay, which the
 * walk reads as a run of tokens. A run of tokens used to bind every name it
 * held in the whole run, so a parameter hid the macro from what came after
 * its function.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { ($value + $value) }
}
export syntax boxed:type {
  rule { boxed } => { readonly number[] }
}
export syntax emit:item {
  rule { emit { $($items:tt)* } } => { $($items)* }
}
export syntax withParameter:item {
  rule { withParameter $name:binding { $($body:tt)* } }
  bind $name in following as recursive value;
  => { export function $name(twice: (v: number) => number): number { return $($body)*; } }
}
export syntax callTwice:expr {
  rule { callTwice($value:expr) } => { twice($value) }
}
export syntax same:expr {
  rule { same($value:expr) } => { $value }
}
export syntax defineBound:item {
  rule { defineBound $name:binding; }
  bind $name in following as recursive value;
  => { export const $name = (v: number) => v; }
}
export syntax defineUnbound:item {
  rule { defineUnbound $name:binding; }
  => { export const $name = (v: number) => v; }
}
export syntax defineTwice:item {
  rule { defineTwice; } => { export const twice = (v: number) => v; }
}
export syntax defineThroughBound:item {
  rule { defineThroughBound $name:binding; }
  bind $name in following as recursive value;
  => { defineBound $name; }
}
export syntax defineThrough:item {
  rule { defineThrough $name:binding; } => { defineBound $name; }
}
export syntax letBound:stmt {
  rule { letBound $name:binding; }
  bind $name in following as lexical value;
  => { const $name = (v: number) => v; }
}
export syntax letUnbound:stmt {
  rule { letUnbound $name:binding; } => { const $name = (v: number) => v; }
}
export syntax letTwice:stmt {
  rule { letTwice; } => { const twice = (v: number) => v; void twice(5); }
}
export syntax member:classElement {
  rule { member $name:binding; } => { $name = (v: number) => v; }
}
export syntax run:stmt {
  rule { run { $($statements:tt)* } } => { $($statements)* }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  return expandWith(
    macros,
    `import { twice, boxed, emit, withParameter, callTwice, same, defineBound, defineUnbound, defineTwice, defineThroughBound, defineThrough, letBound, letUnbound, letTwice, member, run } from "./macros.sts" for syntax;\ntype Fn = (v: number) => number;\n${source}\n`,
  );
}

/** `main` expanded against the macro module `definitions`. */
function expandWith(definitions: string, main: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-binder-scope-"));
  writeFileSync(join(directory, "macros.sts"), definitions);
  writeFileSync(join(directory, "main.sts"), main);
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
  return {
    text: (generated ?? "").replaceAll(/\s+/gu, " ").trim(),
    messages: result.diagnostics.map(({ messageText }) => String(messageText)),
  };
}

interface Boundary {
  readonly name: string;
  readonly source: string;
  /** Text standing where the binder is in scope, left as it was written. */
  readonly inside: readonly string[];
  /** Text the macro expands to where the binder is out of scope. */
  readonly outside: readonly string[];
}

const boundaries: readonly Boundary[] = [
  {
    name: "a function's parameter",
    source:
      "export function f(twice: Fn): number { return twice(1); }\nexport const after = twice(2);",
    inside: ["return twice(1);"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a parameter, in a later parameter's default",
    source:
      "export function f(twice: Fn, v = twice(1)): number { return v; }\nexport const after = twice(2);",
    inside: ["v = twice(1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "an arrow's parameter",
    source:
      "export const f = (twice: Fn): number => twice(1);\nexport const after = twice(2);",
    inside: ["=> twice(1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "an arrow's unparenthesized parameter",
    source:
      "export const f: (g: Fn) => number = twice => twice(1);\nexport const after = twice(2);",
    inside: ["=> twice(1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a function expression's name",
    source:
      "export const f = function twice(v: number): number { return v > 0 ? twice(v - 1) : 0; };\nexport const after = twice(2);",
    inside: ["? twice(v - 1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a function expression's name, in an array",
    source:
      "export const r = [function twice(): number { return 0; }, twice(2)];",
    inside: ["function twice(): number"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a function expression's name, in an argument list",
    source:
      "declare function g(...a: unknown[]): void;\ng(function twice(): number { return 0; }, twice(2));",
    inside: ["function twice(): number"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a class expression's name",
    source:
      "export const C = class twice { static self(): unknown { return twice.name; } };\nexport const after = twice(2);",
    inside: ["return twice.name;"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a catch binding",
    source:
      "try { void twice(1); } catch (twice) { void twice; } finally { void twice(3); }",
    inside: ["catch (twice) {"],
    outside: ["(1 + 1)", "(3 + 3)"],
  },
  {
    name: "a for-of loop's variable",
    source:
      "for (const twice of [(v: number) => v]) { void twice(1); }\nexport const after = twice(2);",
    inside: ["twice(1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a for loop's variable",
    source:
      "for (let twice = 0; twice < 1; twice++) { void twice; }\nexport const after = twice(2);",
    inside: ["twice < 1; twice++"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a block's const",
    source:
      "{ const twice = (v: number) => v; void twice(1); }\nexport const after = twice(2);",
    inside: ["twice(1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a block's class",
    source:
      "{ class twice { static n = 1; } void twice.n; }\nexport const after = twice(2);",
    inside: ["twice.n"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a function declared under a line that has no semicolon",
    source:
      "declare function g(): void;\ng()\nfunction twice(v: number): number { return v }\nexport const after = twice(1)",
    inside: ["after = twice(1)"],
    outside: [],
  },
  {
    name: "a function declared under a declaration that has no semicolon",
    source:
      "const k = 1\nfunction twice(v: number): number { return v + k }\nexport const after = twice(1)",
    inside: ["after = twice(1)"],
    outside: [],
  },
  {
    name: "a block's function",
    source:
      "{ function twice(v: number): number { return v; } void twice(1); }\nexport const after = twice(2);",
    inside: ["twice(1)"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a var in a function's block",
    source:
      "export function f(): number { { var twice: Fn = (v) => v; } return twice(1); }\nexport const after = twice(2);",
    inside: ["return twice(1);"],
    outside: ["(2 + 2)"],
  },
  {
    name: "a type alias's type parameter",
    source: "export type P<boxed> = boxed[];\nexport type After = boxed;",
    inside: ["P<boxed> = boxed[];"],
    outside: ["readonly number[]"],
  },
  {
    name: "a type alias's type parameter, with no semicolon",
    source: "export type P<boxed> = boxed[]\nexport type After = boxed",
    inside: ["P<boxed> = boxed[]"],
    outside: ["readonly number[]"],
  },
  {
    name: "a class's type parameter",
    source: "export class C<boxed> { v!: boxed; }\nexport type After = boxed;",
    inside: ["C<boxed> { v!: boxed; }"],
    outside: ["readonly number[]"],
  },
  {
    name: "a class's type parameter, in a static member",
    source:
      "export class C<boxed> { v!: boxed; static s: boxed = []; static { const t: boxed = []; void t; } }",
    inside: ["v!: boxed;"],
    outside: ["static s: (readonly number[])", "const t: (readonly number[])"],
  },
  {
    name: "a method signature's type parameter in a type literal",
    source: "export type L = { m<boxed>(v: boxed): boxed; n: boxed };",
    inside: ["m<boxed>(v: boxed): boxed;"],
    outside: ["readonly number[]"],
  },
  {
    name: "a method signature's type parameter in an interface, with no semicolons",
    source: "export interface I {\n  m<boxed>(v: boxed): boxed\n  n: boxed\n}",
    inside: ["m<boxed>(v: boxed): boxed"],
    outside: ["readonly number[]"],
  },
  {
    name: "a generic arrow's type parameter",
    source:
      "export const g = <boxed,>(v: boxed): boxed => v;\nexport type After = boxed;",
    inside: ["<boxed,>(v: boxed): boxed => v"],
    outside: ["readonly number[]"],
  },
  {
    name: "what `infer` declares",
    source: "export type E<X> = X extends Array<infer boxed> ? boxed : boxed;",
    inside: ["Array<infer boxed> ? boxed :"],
    outside: ["readonly number[]"],
  },
  {
    name: "a mapped type's key",
    source:
      "export type M<K extends string> = { [boxed in K]: boxed } | boxed;",
    inside: ["[boxed in K]: boxed"],
    outside: ["readonly number[]"],
  },
];

describe("a binder's scope", () => {
  for (const { name, source, inside, outside } of boundaries) {
    for (const [written, text] of [
      ["written in the file", source],
      ["handed back as tokens", `emit { ${source} }`],
    ] as const) {
      test(`${name}, ${written}, hides the macro inside it and not outside`, () => {
        const expanded = expand(text);
        expect(expanded.messages).toEqual([]);
        for (const kept of inside) expect(expanded.text).toContain(kept);
        for (const expansion of outside)
          expect(expanded.text).toContain(expansion);
      });
    }
  }

  test("a var written in a block is bound in the function around it", () => {
    const { text, messages } = expand(
      "{ var twice = (v: number) => v; }\nexport const after = twice(2);",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("after = twice(2)");
  });
});

/**
 * Whose a name is, when a template and its call site both write one: a
 * reference is to a binder only where it carries every scope the binder does.
 */
describe("a binder and a name written by different hands", () => {
  test("a binder a template writes does not capture the call site's name", () => {
    const { text, messages } = expand("withParameter f { twice(3) }");
    expect(messages).toEqual([]);
    expect(text).toContain("return (3 + 3);");
  });

  test("a binder the call site writes does not capture the template's name", () => {
    const { text, messages } = expand(
      "export const f = (twice: Fn): number => callTwice(2);",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(twice: Fn): number => (2 + 2)");
  });

  test("a binder the call site writes captures its own name handed to a macro", () => {
    const { text, messages } = expand(
      "export const f = (twice: Fn): number => same(twice(1));",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("=> twice(1)");
  });
});

/**
 * A name a template writes, where the macro is defined in the file that uses
 * it. The template was written at the top of the module, so it sees what the
 * module declares there, and nothing a function or a block declares: those
 * are scopes its text was never inside. Its tokens carry the module's scope,
 * as the call site's do, so the scope of the binding form is what tells them
 * apart.
 */
describe("a name a template of this file writes", () => {
  const localTwice = `syntax localTwice:expr {
  rule { localTwice($value:expr) } => { twice($value) }
}
`;
  const cases: readonly {
    readonly name: string;
    readonly source: string;
    readonly expected: string;
  }[] = [
    {
      name: "is not captured by a function's parameter",
      source: "export function f(twice: Fn): number { return localTwice(3); }",
      expected: "return (3 + 3);",
    },
    {
      name: "is not captured by an arrow's parameter",
      source: "export const f = (twice: Fn): number => localTwice(3);",
      expected: "=> (3 + 3)",
    },
    {
      name: "is not captured by a block's const",
      source:
        "export function f(): number { { const twice = (v: number) => v; return localTwice(3) + twice(0); } }",
      expected: "return (3 + 3) + twice(0);",
    },
    {
      name: "is not captured by a catch binding",
      source:
        "export function f(): number { try { return 0; } catch (twice) { return localTwice(3); } }",
      expected: "return (3 + 3);",
    },
    {
      name: "is not captured by a parameter handed back as tokens",
      source:
        "emit { export function f(twice: Fn): number { return localTwice(3); } }",
      expected: "return (3 + 3);",
    },
    {
      name: "sees what a block binds, where the macro is generated in the block",
      source:
        "export function f(): number { const twice = (v: number) => v; run { #syntax { syntax useLocal:expr { rule { useLocal() } => { twice(1) } } } } return useLocal(); }",
      expected: "return twice(1);",
    },
    {
      name: "sees a declaration at the top of the module",
      source:
        "export const twice = (v: number): number => v;\nexport const r = localTwice(3);",
      expected: "r = twice(3);",
    },
  ];
  for (const { name, source, expected } of cases) {
    test(name, () => {
      const { text, messages } = expand(localTwice + source);
      expect(messages).toEqual([]);
      expect(text).toContain(expected);
    });
  }
});

/**
 * A declaration an expansion writes, and the names after it in the same run.
 *
 * Such a declaration is in scope for the rest of the block the expansion
 * stands in, as one written there is, and binds a name there by the scopes the
 * spec's hygiene gives it. A name a template wrote carries the invocation's
 * introduction scope, so it binds nothing the call site wrote. A name taken
 * from the call site carries the invocation's use-site scope, which nothing
 * written after the invocation does, so it binds the call site's names only
 * where the macro says so with a binding contract: `bind $name in following`
 * gives the binding and the syntax after the invocation one scope of their
 * own, and it is that binding the later names resolve to.
 */
describe("a declaration an expansion writes", () => {
  const declarations: readonly Boundary[] = [
    {
      name: "an item binding a call-site name in following",
      source: "defineBound twice;\nexport const after = twice(2);",
      inside: ["after = twice(2)"],
      outside: [],
    },
    {
      name: "an item declaring a call-site name with no binding contract",
      source: "defineUnbound twice;\nexport const after = twice(2);",
      inside: [],
      outside: ["after = (2 + 2)"],
    },
    {
      name: "an item declaring a name its template wrote",
      source: "defineTwice;\nexport const after = twice(2);",
      inside: [],
      outside: ["after = (2 + 2)"],
    },
    {
      name: "a statement binding a call-site name in following",
      source:
        "export function f(): number { letBound twice; return twice(2); }",
      inside: ["return twice(2);"],
      outside: [],
    },
    {
      name: "a statement declaring a call-site name with no binding contract",
      source:
        "export function f(): number { letUnbound twice; return twice(2); }",
      inside: [],
      outside: ["return (2 + 2);"],
    },
    {
      name: "a statement declaring a name its template wrote",
      source: "export function f(): number { letTwice; return twice(2); }",
      inside: ["twice(5)"],
      outside: ["return (2 + 2);"],
    },
    {
      name: "a statement binding in following inside a block",
      source:
        "export function f(): number { { letBound twice; void twice(1); } return twice(2); }",
      inside: ["void twice(1);"],
      outside: ["return (2 + 2);"],
    },
    {
      name: "a statement binding in following in a method's body",
      source:
        "export class C { m(): number { letBound twice; return twice(1); } n(): number { return twice(2); } }",
      inside: ["return twice(1);"],
      outside: ["return (2 + 2);"],
    },
    {
      name: "a class member named from the call site",
      source:
        "export class C { member twice; n(): number { return twice(2); } }",
      inside: ["{ twice = "],
      outside: ["return (2 + 2);"],
    },
    {
      name: "an item binding in following through a macro that also binds",
      source: "defineThroughBound twice;\nexport const after = twice(2);",
      inside: ["after = twice(2)"],
      outside: [],
    },
    {
      name: "an item declared through a macro that binds nothing itself",
      source: "defineThrough twice;\nexport const after = twice(2);",
      inside: [],
      outside: ["after = (2 + 2)"],
    },
    {
      name: "an item binding in following, handed back as tokens",
      source: "emit { defineBound twice; export const after = twice(2); }",
      inside: ["after = twice(2)"],
      outside: [],
    },
  ];
  for (const { name, source, inside, outside } of declarations) {
    test(`${name} binds where hygiene says it does`, () => {
      const expanded = expand(source);
      expect(expanded.messages).toEqual([]);
      for (const kept of inside) expect(expanded.text).toContain(kept);
      for (const expansion of outside)
        expect(expanded.text).toContain(expansion);
      if (outside.length === 0) expect(expanded.text).not.toContain(" + ");
    });
  }
});

/**
 * What a `following` region is: the rest of the block or module the
 * invocation stands in, and nothing a member list or a reading of one
 * expression holds.
 */
describe("a following region", () => {
  test("is refused for a class member macro", () => {
    const { messages } = expandWith(
      `export syntax memberBound:classElement {
  rule { memberBound $name:binding; }
  bind $name in following as lexical value;
  => { $name = (v: number) => v; }
}
`,
      `import { memberBound } from "./macros.sts" for syntax;\nexport class C { memberBound twice; }\n`,
    );
    expect(messages.join("\n")).toContain(
      "A classElement macro cannot bind in following: a member list is not a lexical scope.",
    );
  });

  test("is refused for an operator expanded while its expression is read", () => {
    const { messages } = expandWith(
      `export operator (<~):expr {
  fixity infix;
  associativity right;
  precedence 2;
  rule { $name:ident <~ $value:expr }
  bind $name in following as lexical value;
  => { ($name = $value) }
}
`,
      `import { (<~) } from "./macros.sts" for syntax;\nexport function f(): number { let v = 0; v <~ 1; return v; }\n`,
    );
    expect(messages.join("\n")).toContain(
      "Operator <~ binds a name in following syntax, but it was expanded while the expression holding it was read, where no syntax following it can be bound.",
    );
  });
});
