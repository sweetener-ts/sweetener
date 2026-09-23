import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type InvocationId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createSyntaxSequence,
  OriginStore,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  createExpansionFrontendSession,
  ExpansionGuard,
} from "../src/index.js";

const definitionSource = 981 as SourceId;
const invocationSource = 982 as SourceId;

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(syntax: readonly Syntax[]) {
  return printLosslessSequence(syntax).replace(/\s+/gu, "");
}

function harness(definitionText: string) {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("module", "nested-template-definitions"),
  );
  const definitions = readSyntax(definitionText, {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(definitions.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(80_000);
  const bindingIds = createIdAllocator<BindingId>(80_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const phase = createPhase(1);
  const module = compileParsedMacros(parsed, {
    sourceId: definitionSource,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(definitions.diagnostics).toEqual([]);
  expect(parsed.diagnostics).toEqual([]);
  expect(module.diagnostics).toEqual([]);
  const tracker = new ResourceTracker(createResourceBudget());
  const session = createExpansionFrontendSession({
    module,
    sourceId: invocationSource,
    phase,
    scopeStore: scopes,
    origins,
    environments: new EnvironmentStore(),
    tracker,
    guard: new ExpansionGuard({ tracker }),
    allocateSyntaxId: syntaxIds.allocate,
    allocateBindingId: bindingIds.allocate,
    allocateInvocationId: invocationIds.allocate,
  });
  const run = (source: string, category: "expr" | "stmt" | "item" | "type") => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "nested-use")),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    const result = session.expand(withoutEof(read.root.children), category);
    return {
      text: compact(result.syntax),
      syntax: result.syntax,
      diagnostics: result.diagnostics,
      unresolvedNameExplanations: result.unresolvedNameExplanations,
    };
  };
  return Object.assign(
    (source: string, category: "expr" | "stmt" | "item" | "type") => {
      const { text, diagnostics } = run(source, category);
      expect(diagnostics).toEqual([]);
      return text;
    },
    { run },
  );
}

/**
 * A macro written in another macro's template has to expand wherever it
 * stands. A replacement is walked before it is parsed, and the single token in
 * front of a position finds only the head of an emitted expression and the
 * elements of an array literal: read that way, a macro in an argument list, an
 * operand, an arrow body or a function body resolves in the category of the
 * declaration around it, finds no macro, and is emitted verbatim as a call to
 * a function that does not exist -- with no diagnostic to say so.
 */
describe("macros nested in a template", () => {
  const definitions = `
    export syntax inner:expr {
      rule { inner($value:expr) } => { [$value, $value] }
    }
    export syntax operand:item {
      rule { operand $name:binding; }
      bind $name in following as recursive value;
      => { #core(const $name = 1 && inner(2)) }
    }
    export syntax argument:item {
      rule { argument $name:binding; }
      bind $name in following as recursive value;
      => { #core(const $name = wrap(inner(2))) }
    }
    export syntax arrowBody:item {
      rule { arrowBody $name:binding; }
      bind $name in following as recursive value;
      => { #core(const $name = () => inner(2)) }
    }
    export syntax functionBody:item {
      rule { functionBody $name:binding; }
      bind $name in following as recursive value;
      => { #core(function $name() { return inner(2); }) }
    }
    export syntax arrayElement:item {
      rule { arrayElement $name:binding; }
      bind $name in following as recursive value;
      => { #core(const $name = [inner(2), inner(3)]) }
    }
    export syntax head:item {
      rule { head $name:binding; }
      bind $name in following as recursive value;
      => { #core(const $name = inner(2)) }
    }
  `;

  test("expands a macro standing in an operand of a template expression", () => {
    const expand = harness(definitions);
    expect(expand("operand a;", "item")).toBe("consta=1&&[2,2]");
  });

  test("expands a macro standing in an argument list of a template expression", () => {
    const expand = harness(definitions);
    expect(expand("argument a;", "item")).toBe("consta=wrap([2,2])");
  });

  test("expands a macro standing in the body of a template arrow", () => {
    const expand = harness(definitions);
    expect(expand("arrowBody a;", "item")).toBe("consta=()=>[2,2]");
  });

  test("expands a macro standing in the body of a template function", () => {
    const expand = harness(definitions);
    expect(expand("functionBody a;", "item")).toBe("functiona(){return[2,2];}");
  });

  test("enforestItems hands over one item, not an item wrapped in an item", () => {
    const { syntax } = harness(definitions).run("head a;", "item");
    const root = syntax[0];
    expect(root?.tag).toBe("protected");
    if (root?.tag !== "protected") throw new Error("expected an item");
    expect(root.category).toBe("item");
    expect(
      root.children.some(
        (child) => child.tag === "protected" && child.category === "item",
      ),
    ).toBe(false);
  });

  test("keeps expanding the positions that already worked", () => {
    const expand = harness(definitions);
    expect(expand("head a;", "item")).toBe("consta=[2,2]");
    expect(expand("arrayElement a;", "item")).toBe("consta=[[2,2],[3,3]]");
  });

  test("carries an expression region past several tokens to the end of the statement", () => {
    const expand = harness(`
      export syntax inner:expr {
        rule { inner($value:expr) } => { [$value, $value] }
      }
      export syntax deep:item {
        rule { deep $name:binding; }
        bind $name in following as recursive value;
        => { #core(const $name = a + b * c(d) - inner(2)) }
      }
    `);
    expect(expand("deep a;", "item")).toBe("consta=a+b*c(d)-[2,2]");
  });

  test("leaves the type side of a declaration a type", () => {
    const expand = harness(`
      export syntax list:type {
        rule { list<$element:type> } => { ReadonlyArray<$element> }
      }
      export syntax alias:item {
        rule { alias $name:binding; }
        bind $name in following as recursive type;
        => { #core(type $name = list<string>) }
      }
    `);
    expect(expand("alias Names;", "item")).toBe(
      "typeNames=ReadonlyArray<string>",
    );
  });
});

/**
 * A capture of more than one node arrives protected. Returning it as a
 * complete operand without reading what follows leaves a template's own postfix
 * -- `$value.every(check)`, `$value[0]`, `$value(arg)` -- for a caller with
 * nowhere to put it, and the expansion is reported as not one expression.
 */
describe("postfix written after a captured expression", () => {
  const definitions = `
    export syntax member:expr {
      rule { member($value:expr) } => { $value.every(check) }
    }
    export syntax indexed:expr {
      rule { indexed($value:expr) } => { $value[0] }
    }
    export syntax called:expr {
      rule { called($value:expr) } => { $value(argument) }
    }
  `;

  test("reads a member off a capture that is a single node", () => {
    const expand = harness(definitions);
    expect(expand("member(value)", "expr")).toBe("value.every(check)");
  });

  test("reads a member off a capture that ends in an index", () => {
    const expand = harness(definitions);
    expect(expand(`member(value["key"])`, "expr")).toBe(
      `value["key"].every(check)`,
    );
  });

  test("reads a member off a capture that ends in a cast", () => {
    const expand = harness(definitions);
    expect(
      expand(`member((value as Record<string, unknown>)["key"])`, "expr"),
    ).toBe(`(valueasRecord<string,unknown>)["key"].every(check)`);
  });

  test("indexes and calls a captured expression", () => {
    const expand = harness(definitions);
    expect(expand(`indexed(value["key"])`, "expr")).toBe(`value["key"][0]`);
    expect(expand(`called(value["key"])`, "expr")).toBe(
      `value["key"](argument)`,
    );
  });
});

/**
 * `#name(arguments) { body }` is how a class declares a private method, so a
 * template operation in that shape is left alone. A declaration keyword is
 * followed by the name it declares, though, and `interface #join(...) { ... }`
 * has the same three parts -- name, arguments, body. Read as a method, the
 * operation is emitted verbatim, naming the interface `#join(...)`.
 */
describe("a template operation naming a declaration", () => {
  test("builds an interface name with #join", () => {
    const expand = harness(`
      export syntax table:item {
        rule { table $name:binding; }
        bind #join($name, suffix: "Table") in following as lexical type;
        => {
          #core(export interface #join($name, suffix: "Table") { ok: string; })
        }
      }
    `);
    expect(expand("table Door;", "item")).toBe(
      "exportinterfaceDoorTable{ok:string;}",
    );
  });

  test("builds a class name with #join", () => {
    const expand = harness(`
      export syntax boxed:item {
        rule { boxed $name:binding; }
        bind #join($name, suffix: "Box") in following as lexical value;
        => { #core(export class #join($name, suffix: "Box") { value = 1; }) }
      }
    `);
    expect(expand("boxed Door;", "item")).toBe("exportclassDoorBox{value=1;}");
  });

  test("still leaves a private method in a template alone", () => {
    const expand = harness(`
      export syntax counter:item {
        rule { counter $name:binding; }
        bind $name in following as recursive value;
        => {
          #core(class $name {
            #count(value: number) { return value; }
            read() { return this.#count(1); }
          })
        }
      }
    `);
    expect(expand("counter Tally;", "item")).toBe(
      "classTally{#count(value:number){returnvalue;}read(){returnthis.#count(1);}}",
    );
  });
});

/**
 * A declaration header is scanned up to the brace that opens its body, which
 * is not always the first brace found. A `<...>` region may hold an object
 * type -- `class E extends make()<{ a: string }> {}` is how a tagged error is
 * declared -- and claiming that object type as the body leaves the real body
 * over, so the declaration does not read as one item.
 */
describe("a declaration whose type arguments hold an object type", () => {
  const definitions = `
    export syntax heritage:item {
      rule { heritage $name:binding; }
      bind $name in following as recursive value;
      => { #core(export class $name extends make()<{ a: string }> {}) }
    }
    export syntax parameterized:item {
      rule { parameterized $name:binding; }
      bind $name in following as recursive value;
      => { #core(export class $name<T extends { a: string }> { x: T | undefined; }) }
    }
    export syntax extended:item {
      rule { extended $name:binding; }
      bind $name in following as recursive type;
      => { #core(export interface $name extends Base<{ a: string }> { b: number; }) }
    }
    export syntax plain:item {
      rule { plain $name:binding; }
      bind $name in following as recursive value;
      => { #core(export class $name extends make()<string> {}) }
    }
  `;

  test("reads a class extending a call with an object type argument", () => {
    const expand = harness(definitions);
    expect(expand("heritage Tagged;", "item")).toBe(
      "exportclassTaggedextendsmake()<{a:string}>{}",
    );
  });

  test("reads a class whose own type parameter is constrained by one", () => {
    const expand = harness(definitions);
    expect(expand("parameterized Box;", "item")).toBe(
      "exportclassBox<Textends{a:string}>{x:T|undefined;}",
    );
  });

  test("reads an interface extending one", () => {
    const expand = harness(definitions);
    expect(expand("extended Row;", "item")).toBe(
      "exportinterfaceRowextendsBase<{a:string}>{b:number;}",
    );
  });

  test("still reads the form that already worked", () => {
    const expand = harness(definitions);
    expect(expand("plain Simple;", "item")).toBe(
      "exportclassSimpleextendsmake()<string>{}",
    );
  });
});

/**
 * A macro is invoked by its head, and `xs.map(f)` has no head to invoke: `map`
 * there names a property of `xs`. Dispatching anyway rewrites the property
 * access into whatever the macro produces, so a file that merely has a macro
 * named `map` in scope has every `.map(...)` in it turned into something else,
 * with no diagnostic. A macro's own template is the likeliest victim, since
 * `Effect.gen(...)` in a template would be rewritten by a macro named `gen`.
 */
describe("a macro spelled like a property", () => {
  const definitions = `
    export syntax map:expr {
      rule { map($value:expr) } => { [$value] }
    }
    export syntax wraps:item {
      rule { wraps $name:binding; }
      bind $name in following as recursive value;
      => { #core(export const $name = host.map(1);) }
    }
  `;

  test("is invoked where it heads an expression", () => {
    const expand = harness(definitions);
    expect(expand("const a = map(1);", "item")).toBe("consta=[1];");
  });

  test("is left alone after a dot", () => {
    const expand = harness(definitions);
    expect(expand("const b = xs.map((n) => n);", "item")).toBe(
      "constb=xs.map((n)=>n);",
    );
  });

  test("is left alone after an optional chain", () => {
    const expand = harness(definitions);
    expect(expand("const c = xs?.map(f);", "item")).toBe("constc=xs?.map(f);");
  });

  test("is left alone in a property access written in a template", () => {
    const expand = harness(definitions);
    expect(expand("wraps value;", "item")).toBe(
      "exportconstvalue=host.map(1);",
    );
  });
});

/**
 * Positions a macro is written in, found by putting one in each of them. Every
 * failure here is silent: the invocation keeps its own spelling and the output
 * names a macro that expansion removes.
 */
describe("positions a macro is dispatched in", () => {
  const definitions = `
    export syntax twice:expr { rule { twice($v:expr) } => { [$v, $v] } }
    export syntax list:type { rule { list<$e:type> } => { ReadonlyArray<$e> } }
  `;

  /**
   * A template literal holds expressions; a template literal *type* holds
   * types. Reading every substitution as an expression makes an ordinary
   * `` `a${string}` `` unreadable, and at a use site it escapes as a thrown
   * error rather than a diagnostic, ending the whole compilation.
   */
  test("reads a template literal type", () => {
    const expand = harness(definitions);
    expect(expand("export type A = `x${string}`;", "item")).toBe(
      "exporttypeA=`x${string}`;",
    );
  });

  test("reads a template literal type in a mapped key", () => {
    const expand = harness(definitions);
    expect(
      expand(
        "export type A<B> = { [K in keyof B as `g${string & K}`]: 1 };",
        "item",
      ),
    ).toBe("exporttypeA<B>={[KinkeyofBas`g${string&K}`]:1};");
  });

  test("still reads a template literal expression", () => {
    const expand = harness(definitions);
    expect(expand("export const a = `v${twice(1)}`;", "item")).toBe(
      "exportconsta=`v${[1,1]}`;",
    );
  });

  /** `keyof`, `infer`, `unique`, `asserts` and `is` only ever precede a type. */
  test("dispatches a type macro after keyof", () => {
    const expand = harness(definitions);
    expect(expand("export type A = keyof list<string>;", "item")).toBe(
      "exporttypeA=keyofReadonlyArray<string>;",
    );
  });

  test("dispatches a type macro after infer", () => {
    const expand = harness(definitions);
    expect(
      expand("export type A<T> = T extends list<infer U> ? U : never;", "item"),
    ).toBe("exporttypeA<T>=TextendsReadonlyArray<inferU>?U:never;");
  });

  /**
   * What a class extends is an expression; what an interface extends, or a type
   * parameter is constrained by, is a type. All three are written after
   * `extends`.
   */
  test("dispatches an expression macro in a class heritage clause", () => {
    const expand = harness(definitions);
    expect(expand("export class C extends twice(1) {}", "item")).toBe(
      "exportclassCextends[1,1]{}",
    );
  });

  test("still dispatches a type macro in an interface heritage clause", () => {
    const expand = harness(definitions);
    expect(expand("export interface I extends list<string> {}", "item")).toBe(
      "exportinterfaceIextendsReadonlyArray<string>{}",
    );
  });

  test("still dispatches a type macro in a type-parameter constraint", () => {
    const expand = harness(definitions);
    expect(expand("export type A<T extends list<string>> = T;", "item")).toBe(
      "exporttypeA<TextendsReadonlyArray<string>>=T;",
    );
  });

  /** A bracket inside a member list holds a type, not another member. */
  test("dispatches a type macro in a mapped type's key", () => {
    const expand = harness(definitions);
    expect(
      expand("export type A = { [K in keyof list<string>]: 1 };", "item"),
    ).toBe("exporttypeA={[KinkeyofReadonlyArray<string>]:1};");
  });

  test("dispatches a type macro in an index signature", () => {
    const expand = harness(definitions);
    expect(
      expand("export interface I { [k: string]: list<string>; }", "item"),
    ).toBe("exportinterfaceI{[k:string]:ReadonlyArray<string>;}");
  });
});

/**
 * A macro's name is not reserved.
 *
 * Racket resolves an identifier and only then asks whether the binding it found
 * is a transformer, so a nearer ordinary binding shadows a macro rather than
 * sitting in a space where the two never compete: `(let ([or 5]) or)` is `5`,
 * and the same holds for core forms. Rhombus says it of its expression space --
 * a binding there "hides any binding for another space in an enclosing scope".
 *
 * Every binding form has to shadow the same way, or `const map = 5; return
 * map;` is dispatched as the macro and reported against the macro's own
 * definition.
 *
 * Value and type stay apart because TypeScript keeps them apart, which is the
 * one place this cannot follow Rhombus: `const list` and `type list` are both
 * legal and neither shadows the other's macro.
 */
describe("an ordinary binding shadows a macro", () => {
  const definitions = `
    export syntax twice:expr { rule { twice($v:expr) } => { [$v, $v] } }
    export syntax list:type { rule { list<$e:type> } => { ReadonlyArray<$e> } }
  `;

  test("expands where nothing binds the name", () => {
    const expand = harness(definitions);
    expect(expand("export const a = twice(1);", "item")).toBe(
      "exportconsta=[1,1];",
    );
  });

  test.each([
    [
      "a const in the same block",
      "export function f() { const twice = 2; return twice; }",
      "exportfunctionf(){consttwice=2;returntwice;}",
    ],
    [
      "a let",
      "export function f() { let twice = 2; return twice; }",
      "exportfunctionf(){lettwice=2;returntwice;}",
    ],
    [
      "a module-level const",
      "const twice = 2; export const a = twice;",
      "consttwice=2;exportconsta=twice;",
    ],
    [
      "a parameter",
      "export const h = (twice: number) => twice;",
      "exportconsth=(twice:number)=>twice;",
    ],
    [
      "an arrow's bare parameter",
      "export const h = twice => twice;",
      "exportconsth=twice=>twice;",
    ],
    [
      "a destructured parameter",
      "export function f({ twice }: { twice: number }) { return twice; }",
      "exportfunctionf({twice}:{twice:number}){returntwice;}",
    ],
    [
      "an array-destructured parameter",
      "export function f([twice]: number[]) { return twice; }",
      "exportfunctionf([twice]:number[]){returntwice;}",
    ],
    [
      "a method parameter",
      "export class C { m(twice: number) { return twice; } }",
      "exportclassC{m(twice:number){returntwice;}}",
    ],
    [
      "a catch binder",
      "export function f() { try {} catch (twice) { return twice; } }",
      "exportfunctionf(){try{}catch(twice){returntwice;}}",
    ],
    [
      "a for-of binding",
      "export function f() { for (const twice of [1]) { return twice; } }",
      "exportfunctionf(){for(consttwiceof[1]){returntwice;}}",
    ],
    [
      "a shorthand property's name",
      "export function f() { const twice = 2; return { twice }; }",
      "exportfunctionf(){consttwice=2;return{twice};}",
    ],
    [
      "an import specifier",
      'import { twice } from "./other.js"; export const a = twice;',
      'import{twice}from"./other.js";exportconsta=twice;',
    ],
    [
      "a default import",
      'import twice from "./other.js"; export const a = twice;',
      'importtwicefrom"./other.js";exportconsta=twice;',
    ],
    [
      "a renamed import specifier",
      'import { other as twice } from "./other.js"; export const a = twice;',
      'import{otherastwice}from"./other.js";exportconsta=twice;',
    ],
    [
      "a namespace import",
      'import * as twice from "./other.js"; export const a = twice;',
      'import*astwicefrom"./other.js";exportconsta=twice;',
    ],
    [
      "a default import written beside a specifier list",
      'import twice, { other } from "./other.js"; export const a = twice;',
      'importtwice,{other}from"./other.js";exportconsta=twice;',
    ],
    [
      "a `using` declaration",
      "export function f() { using twice = open(); return twice; }",
      "exportfunctionf(){usingtwice=open();returntwice;}",
    ],
    [
      "an `await using` declaration",
      "export async function f() { await using twice = open(); return twice; }",
      "exportasyncfunctionf(){awaitusingtwice=open();returntwice;}",
    ],
  ])("is shadowed by %s", (_, source, expected) => {
    const expand = harness(definitions);
    expect(expand(source, "item")).toBe(expected);
  });

  /**
   * An import declaration binds the local names its clause writes, and the
   * clause is read as a clause: which names those are is a question about the
   * shape of the declaration, not about a flag that stays on once an `import`
   * has been seen.
   *
   * `using` names a declaration everywhere else. Read as one inside a clause,
   * `import using from "./other.js"` bound nothing at all -- it took `from
   * "./other.js"` for the binders of a `using` declaration -- and a macro
   * spelled `using` went on expanding where the file had imported its own.
   */
  describe("an import declaration is read as a clause", () => {
    const withUsing = `${definitions}
      export syntax using:expr { rule { using($v:expr) } => { [$v, $v] } }`;

    test.each([
      [
        "a default import spelled `using`",
        'import using from "./other.js"; export const a = using(1);',
        'importusingfrom"./other.js";exportconsta=using(1);',
      ],
      [
        "a type-only default import spelled `using`",
        'import type using from "./other.js"; export const a = using(1);',
        'importtypeusingfrom"./other.js";exportconsta=using(1);',
      ],
      [
        "a `using` written beside a specifier list",
        'import using, { other } from "./other.js"; export const a = using(1);',
        'importusing,{other}from"./other.js";exportconsta=using(1);',
      ],
      [
        "a `using` an import-equals binds",
        'import using = require("./other.js"); export const a = using(1);',
        'importusing=require("./other.js");exportconsta=using(1);',
      ],
    ])("binds %s", (_, source, expected) => {
      expect(harness(withUsing)(source, "item")).toBe(expected);
    });

    test.each([
      [
        "an import of another name leaves a macro dispatching",
        'import using from "./other.js"; export const a = twice(1);',
        'importusingfrom"./other.js";exportconsta=[1,1];',
      ],
      [
        "a const declared after an import still binds",
        'import other from "./other.js"; const twice = 2; export const a = twice;',
        'importotherfrom"./other.js";consttwice=2;exportconsta=twice;',
      ],
      [
        "a function declared after an import still binds",
        'import other from "./other.js"; function twice() { return 1; } export const a = twice;',
        'importotherfrom"./other.js";functiontwice(){return1;}exportconsta=twice;',
      ],
      [
        "a side-effect import binds nothing",
        'import "./other.js"; export const a = twice(1);',
        'import"./other.js";exportconsta=[1,1];',
      ],
    ])("%s", (_, source, expected) => {
      expect(harness(withUsing)(source, "item")).toBe(expected);
    });
  });

  /** A parameter belongs to the region its function opens, not the one around it. */
  test("a parameter does not reach the rest of the file", () => {
    const expand = harness(definitions);
    expect(
      expand(
        "export const h = (twice: number) => twice;\nexport const a = twice(1);",
        "item",
      ),
    ).toBe("exportconsth=(twice:number)=>twice;exportconsta=[1,1];");
  });

  test("a binding in one block does not reach a sibling", () => {
    const expand = harness(definitions);
    expect(
      expand(
        "export function f() { const twice = 2; return twice; }\nexport function g() { return twice(1); }",
        "item",
      ),
    ).toBe(
      "exportfunctionf(){consttwice=2;returntwice;}exportfunctiong(){return[1,1];}",
    );
  });

  /**
   * Rhombus's rule reaches across spaces: a binding in the expression space
   * "hides any binding for another space in an enclosing scope". A statement,
   * item or member macro is hidden by a value binding for the same reason an
   * expression macro is.
   */
  test.each([
    [
      "a statement macro",
      "export function f(c: boolean) { guard(c); return 1; }",
      "exportfunctionf(c:boolean){if(!c){return;}return1;}",
      "export function f(c: boolean) { const guard = 1; return guard; }",
      "exportfunctionf(c:boolean){constguard=1;returnguard;}",
    ],
    [
      "an item macro",
      "mkconst x;",
      "exportconstx=1;",
      "const mkconst = 1; export const y = mkconst;",
      "constmkconst=1;exportconsty=mkconst;",
    ],
    [
      "a type-member macro",
      "export interface I { a: string; fields }",
      "exportinterfaceI{a:string;extra:string;}",
      "const fields = 1; export interface I { a: string; fields }",
      "constfields=1;exportinterfaceI{a:string;fields}",
    ],
  ])(
    "hides %s from an enclosing value binding",
    (_, open, openExpected, shadowed, shadowedExpected) => {
      const expand = harness(`
        export syntax guard:stmt {
          rule { guard($c:expr); } => { if (!$c) { return; } }
        }
        export syntax fields:typeMember { rule { fields } => { extra: string; } }
        export syntax mkconst:item {
          rule { mkconst $n:binding; }
          bind $n in following as recursive value;
          => { #core(export const $n = 1;) }
        }
      `);
      expect(expand(open, "item")).toBe(openExpected);
      expect(expand(shadowed, "item")).toBe(shadowedExpected);
    },
  );

  test("a value binding does not shadow a type macro", () => {
    const expand = harness(definitions);
    expect(
      expand("const list = 1; export type A = list<string>;", "item"),
    ).toBe("constlist=1;exporttypeA=ReadonlyArray<string>;");
  });

  test("a type binding does not shadow an expression macro", () => {
    const expand = harness(definitions);
    expect(
      expand("type twice = number; export const a = twice(1);", "item"),
    ).toBe("typetwice=number;exportconsta=[1,1];");
  });

  test("a type binding shadows a type macro", () => {
    const expand = harness(definitions);
    expect(expand("type list = number; export type A = list;", "item")).toBe(
      "typelist=number;exporttypeA=list;",
    );
  });

  /**
   * `type A = name;` reads a type, so no expression macro is looked up there.
   * The name is left as written, and what expansion has to say about it -- that
   * a macro of another space is spelled that way -- is held rather than
   * reported: whether `twice` is a type here is TypeScript's to answer, since
   * `lib.d.ts`, an ambient declaration and a `declare global` all declare types
   * expansion cannot see. The sentence is written where TypeScript says it
   * cannot find the name, and nowhere else.
   */
  test("holds an expression macro written in a type alias for TypeScript", () => {
    const expand = harness(definitions);
    const { text, diagnostics, unresolvedNameExplanations } = expand.run(
      "export type A = twice;",
      "item",
    );
    expect(text).toBe("exporttypeA=twice;");
    expect(diagnostics).toEqual([]);
    expect(unresolvedNameExplanations).toHaveLength(1);
    expect(unresolvedNameExplanations[0]?.code).toBe("SWR4013");
    expect(unresolvedNameExplanations[0]?.messageArguments).toEqual([
      "twice",
      "expr",
      "type",
    ]);
  });
});

/**
 * Expansion is bounded so a macro cannot consume the build, and reaching a
 * bound is a diagnostic. Thrown past every caller, a macro that does not
 * terminate ends the run with a stack trace naming no file, no line and no
 * macro -- and it escapes the compiler session too, so every host integration
 * fails the same way.
 */
describe("a macro that does not terminate", () => {
  const run = (definitionText: string, source: string) => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("module", "nonterminating-definitions"),
    );
    const definitions = readSyntax(definitionText, {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    });
    const parsed = parseMacroDefinitions(definitions.root, {
      sourceId: definitionSource,
    });
    const syntaxIds = createIdAllocator<SyntaxId>(60_000);
    const bindingIds = createIdAllocator<BindingId>(60_000);
    const invocationIds = createIdAllocator<InvocationId>(1);
    const phase = createPhase(1);
    const module = compileParsedMacros(parsed, {
      sourceId: definitionSource,
      phase,
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(module.diagnostics).toEqual([]);
    const tracker = new ResourceTracker(createResourceBudget());
    const session = createExpansionFrontendSession({
      module,
      sourceId: invocationSource,
      phase,
      scopeStore: scopes,
      origins,
      environments: new EnvironmentStore(),
      tracker,
      guard: new ExpansionGuard({ tracker }),
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
    });
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "nonterminating")),
      originStore: origins,
    });
    return session.expand(withoutEof(read.root.children), "item");
  };

  test("reports a macro that expands to itself", () => {
    const result = run(
      "export rec syntax loop:expr { rule { loop($v:expr) } => { loop($v) } }",
      "export const a = loop(1);",
    );
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["SWR4014"]);
    expect(result.diagnostics[0]?.messageArguments).toEqual(["loop"]);
  });

  test("reports a macro whose expansion grows without end", () => {
    const result = run(
      "export rec syntax grow:expr { rule { grow($v:expr) } => { grow([$v, $v]) } }",
      "export const a = grow(1);",
    );
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["SWR4015"]);
    expect(result.diagnostics[0]?.messageArguments[0]).toBe("grow");
  });
});

/**
 * Definition contexts are read at module level. One written inside a block is
 * not processed, and carried through into the emitted TypeScript it makes the
 * host compiler report `Unexpected keyword or identifier` on a line of macro
 * language. Local macro scope is a milestone deliverable whose machinery exists
 * but is not wired in; until it is, saying so is better than emitting it.
 */
describe("a definition written inside a block", () => {
  test.each([
    [
      "a syntax definition",
      "export function f() { syntax double:expr { rule { double($v:expr) } => { [$v, $v] } } return 1; }",
      "double",
    ],
    [
      "a syntax class",
      "export function f() { syntax class A { fields { n: ident; } rule { $n:ident } } return 1; }",
      "A",
    ],
  ])("reports %s", (_, source, named) => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("module", "unprocessed-definitions"),
    );
    const definitions = readSyntax(
      "export syntax noop:expr { rule { noop } => { 0 } }",
      {
        sourceId: definitionSource,
        scopes: definitionScopes,
        originStore: origins,
      },
    );
    const parsed = parseMacroDefinitions(definitions.root, {
      sourceId: definitionSource,
    });
    const syntaxIds = createIdAllocator<SyntaxId>(50_000);
    const bindingIds = createIdAllocator<BindingId>(50_000);
    const invocationIds = createIdAllocator<InvocationId>(1);
    const phase = createPhase(1);
    const module = compileParsedMacros(parsed, {
      sourceId: definitionSource,
      phase,
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    const tracker = new ResourceTracker(createResourceBudget());
    const session = createExpansionFrontendSession({
      module,
      sourceId: invocationSource,
      phase,
      scopeStore: scopes,
      origins,
      environments: new EnvironmentStore(),
      tracker,
      guard: new ExpansionGuard({ tracker }),
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
    });
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "unprocessed")),
      originStore: origins,
    });
    const result = session.expand(withoutEof(read.root.children), "item");
    expect(result.diagnostics.map(({ code }) => code)).toContain("SWR4016");
    expect(
      result.diagnostics.find(({ code }) => code === "SWR4016")
        ?.messageArguments,
    ).toEqual([named]);
  });

  test.each([
    [
      "a const named syntax",
      "export function f() { const syntax = 1; return syntax; }",
    ],
    ["a property named syntax", "export const a = { syntax: 1 };"],
    [
      "a const named operator",
      "export function f() { const operator = 2; return operator; }",
    ],
  ])("does not report %s", (_, source) => {
    const expandOne = harness(
      "export syntax noop:expr { rule { noop } => { 0 } }",
    );
    expect(() => expandOne(source, "item")).not.toThrow();
  });
});

/**
 * A block is a definition context of its own, so a macro generated inside one
 * is visible for the rest of that block and no further. Generated definitions
 * live in expansion-wide state, which has to be restored when the block ends.
 * Otherwise a macro a statement macro installs for one body stays visible
 * afterwards, and where two bodies install the same name whichever ran last is
 * the one in scope after them -- the opposite of the hygiene the language
 * promises.
 */
describe("a macro generated inside a block", () => {
  const definitions = `
    export syntax setupWith:stmt {
      rule { setupWith $tag:expr; } => {
        #syntax {
          syntax helper:expr { rule { helper($v:expr) } => { [$tag, $v] } }
        }
      }
    }
    export syntax setupItem:item {
      rule { setupItem; } => {
        #syntax {
          syntax outer:expr { rule { outer($v:expr) } => { [$v] } }
        }
      }
    }
  `;

  test("is visible for the rest of that block", () => {
    const expand = harness(definitions);
    expect(
      expand(
        'export function a() { setupWith "A"; return helper(1); }',
        "item",
      ),
    ).toBe('exportfunctiona(){return["A",1];}');
  });

  test("does not reach past the block", () => {
    const expand = harness(definitions);
    const result = expand(
      'export function a() { setupWith "A"; return helper(1); }\nexport const outside = helper(2);',
      "item",
    );
    expect(result).toContain('return["A",1];');
    // Out of scope afterwards, so the name is left for TypeScript to reject.
    expect(result).toContain("constoutside=helper(2);");
  });

  test("does not reach a sibling block", () => {
    const expand = harness(definitions);
    const result = expand(
      'export function a() { setupWith "A"; return helper(1); }\nexport function b() { setupWith "B"; return helper(2); }',
      "item",
    );
    expect(result).toContain('return["A",1];');
    expect(result).toContain('return["B",2];');
  });

  test("still reaches the items that follow when generated at module level", () => {
    const expand = harness(definitions);
    expect(expand("setupItem;\nexport const a = outer(1);", "item")).toBe(
      "exportconsta=[1];",
    );
  });
});

/**
 * A macro is visible to what follows its definition, the way a `const` is, so a
 * name used above its definition is not a macro there. Unsaid, the invocation
 * is emitted as a call to a name the output does not define, and only
 * TypeScript reports it -- as a missing name, saying nothing about the
 * definition below.
 *
 * Whether the output defines it, though, is TypeScript's to answer and not
 * expansion's: a macro spelled `Event` leaves a DOM global standing above its
 * definition. So the sentence is held for the side that resolves names, to be
 * written where that side says the name is missing.
 * `packages/cli/test/macro-name-resolution.test.ts` is where both directions
 * are checked, against a whole program.
 */
describe("a macro used above its definition", () => {
  const definitions = "export syntax noop:expr { rule { noop } => { 0 } }";

  test("is held against the use, for TypeScript to speak", () => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("module", "order-definitions"),
    );
    const read = readSyntax(definitions, {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    });
    const parsed = parseMacroDefinitions(read.root, {
      sourceId: definitionSource,
    });
    const phase = createPhase(1);
    const bindingIds = createIdAllocator<BindingId>(40_000);
    const module = compileParsedMacros(parsed, {
      sourceId: definitionSource,
      phase,
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    const tracker = new ResourceTracker(createResourceBudget());
    const session = createExpansionFrontendSession({
      module,
      sourceId: invocationSource,
      phase,
      scopeStore: scopes,
      origins,
      environments: new EnvironmentStore(),
      tracker,
      guard: new ExpansionGuard({ tracker }),
      allocateSyntaxId: createIdAllocator<SyntaxId>(40_000).allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: createIdAllocator<InvocationId>(1).allocate,
      isMacroVisible: () => false,
    });
    const use = readSyntax("export const a = noop;", {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "order-use")),
      originStore: origins,
    });
    const result = session.expand(withoutEof(use.root.children), "item");
    expect(result.diagnostics).toEqual([]);
    expect(result.unresolvedNameExplanations.map(({ code }) => code)).toEqual([
      "SWR4017",
    ]);
    expect(result.unresolvedNameExplanations[0]?.messageArguments).toEqual([
      "noop",
    ]);
  });

  test("is not reported where an ordinary binding means the name instead", () => {
    const expand = harness(definitions);
    expect(
      expand("export function f() { const noop = 1; return noop; }", "item"),
    ).toBe("exportfunctionf(){constnoop=1;returnnoop;}");
  });
});
