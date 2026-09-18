import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type Diagnostic,
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

const definitionSource = 971 as SourceId;
const invocationSource = 972 as SourceId;

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
    scopes.freshScope("module", "type-member-definitions"),
  );
  const definitions = readSyntax(definitionText, {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(definitions.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(90_000);
  const bindingIds = createIdAllocator<BindingId>(90_000);
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
  const run = (
    source: string,
  ): {
    text: string;
    diagnostics: readonly Diagnostic[];
    unresolvedNameExplanations: readonly Diagnostic[];
  } => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "type-member-use")),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    const result = session.expand(withoutEof(read.root.children), "item");
    return {
      text: compact(result.syntax),
      diagnostics: result.diagnostics,
      unresolvedNameExplanations: result.unresolvedNameExplanations,
    };
  };
  return {
    expand: (source: string) => {
      const result = run(source);
      expect(result.diagnostics).toEqual([]);
      return result.text;
    },
    diagnose: (source: string) => run(source).diagnostics,
    explain: (source: string) => run(source).unresolvedNameExplanations,
  };
}

const definitions = `
  export syntax timestamps:typeMember {
    rule { timestamps } => {
      readonly createdAt: string;
      readonly updatedAt: string;
    }
  }
  export syntax list:type {
    rule { list<$element:type> } => { ReadonlyArray<$element> }
  }
  export syntax class Field {
    fields { name: ident; kind: type; }
    rule { $name:ident : $kind:type }
  }
  export syntax accessors:typeMember {
    rule { accessors { $($field:Field);* } } => {
      $(
        get $field.name(): $field.kind;
        set $field.name(value: $field.kind);
      )*
    }
  }
  export syntax overloaded:typeMember {
    rule { overloaded $name:ident over $($kind:type),* } => {
      $($name(value: $kind): $kind;)*
    }
  }
  export syntax nowhere:item {
    rule { nowhere } => { const generated = 1; }
  }
  export syntax only:typeMember {
    rule { only } => { readonly only: string }
  }
  export syntax logit:stmt {
    rule { logit } => { console.log(1); }
  }
  export syntax logat:stmt {
    rule { logat($value:expr); } => { console.log($value); }
  }
  export syntax loosely:stmt {
    rule { loosely } => { console.log(2) }
  }
  export syntax fieldy:classElement {
    rule { fieldy } => { readonly name: string; }
  }
  export syntax loosefield:classElement {
    rule { loosefield } => { readonly other: string }
  }
`;

describe("the typeMember category", () => {
  test("expands a member macro in an interface body", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Post { title: string; timestamps }")).toBe(
      "interfacePost{title:string;readonlycreatedAt:string;readonlyupdatedAt:string;}",
    );
  });

  test("keeps the members written around the macro", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Post { a: string; timestamps b: number; }")).toBe(
      "interfacePost{a:string;readonlycreatedAt:string;readonlyupdatedAt:string;b:number;}",
    );
  });

  test("expands a member macro in an object type", () => {
    const { expand } = harness(definitions);
    expect(expand("type Row = { id: string; timestamps };")).toBe(
      "typeRow={id:string;readonlycreatedAt:string;readonlyupdatedAt:string;};",
    );
  });

  test("expands a member macro in an object type nested in a member", () => {
    const { expand } = harness(definitions);
    expect(
      expand("interface Outer { meta: { label: string; timestamps }; }"),
    ).toBe(
      "interfaceOuter{meta:{label:string;readonlycreatedAt:string;readonlyupdatedAt:string;};}",
    );
  });

  test("emits several members from one repetition", () => {
    const { expand } = harness(definitions);
    expect(
      expand("interface Model { accessors { title: string; count: number } }"),
    ).toBe(
      "interfaceModel{gettitle():string;settitle(value:string);getcount():number;setcount(value:number);}",
    );
  });

  test("emits overloads, which a mapped type cannot express", () => {
    const { expand } = harness(definitions);
    expect(
      expand("interface Parser { overloaded parse over string, number }"),
    ).toBe(
      "interfaceParser{parse(value:string):string;parse(value:number):number;}",
    );
  });

  /**
   * A member list separates on `,`, and an invocation may contain one of its
   * own. Reading the member up to the first comma cuts the invocation in half
   * and emits the remainder verbatim.
   */
  test("keeps an invocation that contains a comma whole", () => {
    const { expand } = harness(definitions);
    expect(
      expand(
        "interface Parser {\n  overloaded parse over string, number\n  tail: string;\n}",
      ),
    ).toBe(
      "interfaceParser{parse(value:string):string;parse(value:number):number;tail:string;}",
    );
  });

  test("keeps such an invocation whole between two members", () => {
    const { expand } = harness(definitions);
    expect(
      expand(
        "interface Parser {\n  head: string;\n  overloaded parse over string, number\n  tail: string;\n}",
      ),
    ).toBe(
      "interfaceParser{head:string;parse(value:string):string;parse(value:number):number;tail:string;}",
    );
  });

  test("keeps two member macros in one body apart", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Both {\n  timestamps\n  timestamps\n}")).toBe(
      "interfaceBoth{readonlycreatedAt:string;readonlyupdatedAt:string;readonlycreatedAt:string;readonlyupdatedAt:string;}",
    );
  });

  /**
   * A member's key is ordinary syntax that may be spelled like a macro without
   * meaning it. Dispatching there would rewrite the declaration of a property
   * whose name simply collides.
   */
  test("leaves a member whose name collides with a macro alone", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Names { timestamps: number; }")).toBe(
      "interfaceNames{timestamps:number;}",
    );
  });

  test("leaves a colliding name alone after an earlier member", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Names { x: string; timestamps: number; }")).toBe(
      "interfaceNames{x:string;timestamps:number;}",
    );
  });

  test("leaves a colliding name alone in a method signature", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Names { timestamps(value: string): void; }")).toBe(
      "interfaceNames{timestamps(value:string):void;}",
    );
  });

  test("still expands a type macro in a member's own type", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Post { tags: list<string>; }")).toBe(
      "interfacePost{tags:ReadonlyArray<string>;}",
    );
  });

  test("expands a type macro in the type of a member that follows a macro", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Post { timestamps tags: list<string>; }")).toBe(
      "interfacePost{readonlycreatedAt:string;readonlyupdatedAt:string;tags:ReadonlyArray<string>;}",
    );
  });

  /**
   * Without the category a macro written here is dispatched as an item and
   * blamed for expanding to something that is not one item. With it, a name
   * that resolves in no member space but does resolve elsewhere is answered
   * for by the category it was declared for.
   *
   * Held rather than reported, because a bare name in a member list is a
   * member of its own: `interface Row { nowhere }` declares an implicitly
   * typed member, which TypeScript accepts outright unless `noImplicitAny` is
   * on. So the sentence goes to TypeScript, to be written where TypeScript
   * says there is something to write it about.
   */
  test("holds a macro declared for another category for TypeScript", () => {
    const { diagnose, explain } = harness(definitions);
    expect(diagnose("interface Row { nowhere }")).toEqual([]);
    const explanations = explain("interface Row { nowhere }");
    expect(explanations).toHaveLength(1);
    expect(explanations[0]?.code).toBe("SWR4013");
    expect(explanations[0]?.messageArguments).toEqual([
      "nowhere",
      "item",
      "typeMember",
    ]);
  });

  test("does not report an ordinary member that shares a macro name", () => {
    const { diagnose, explain } = harness(definitions);
    expect(diagnose("interface Row { nowhere: string; }")).toEqual([]);
    expect(explain("interface Row { nowhere: string; }")).toEqual([]);
  });
});

/**
 * An interface body is a member list wherever the interface is declared. Only
 * a module-level one is read by the item consumer, so below that the expander
 * has to recognize the body from the `interface` that heads it; otherwise the
 * members are walked under whatever category encloses the declaration and no
 * member macro in them is ever dispatched.
 */
describe("an interface body below the top level", () => {
  test("expands a member macro inside a namespace", () => {
    const { expand } = harness(definitions);
    expect(
      expand(
        "export namespace Inner { export interface Nested { timestamps } }",
      ),
    ).toBe(
      "exportnamespaceInner{exportinterfaceNested{readonlycreatedAt:string;readonlyupdatedAt:string;}}",
    );
  });

  test("expands a member macro inside a declared namespace", () => {
    const { expand } = harness(definitions);
    expect(
      expand("declare namespace Inner { interface Nested { timestamps } }"),
    ).toBe(
      "declarenamespaceInner{interfaceNested{readonlycreatedAt:string;readonlyupdatedAt:string;}}",
    );
  });

  test("expands a member macro inside declare global", () => {
    const { expand } = harness(definitions);
    expect(expand("declare global { interface Window { timestamps } }")).toBe(
      "declareglobal{interfaceWindow{readonlycreatedAt:string;readonlyupdatedAt:string;}}",
    );
  });

  test("expands a member macro inside a declared module", () => {
    const { expand } = harness(definitions);
    expect(
      expand('declare module "x" { interface Nested { timestamps } }'),
    ).toBe(
      'declaremodule"x"{interfaceNested{readonlycreatedAt:string;readonlyupdatedAt:string;}}',
    );
  });

  test("expands a member macro in an interface declared in a function body", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { interface Local { timestamps } }")).toBe(
      "functionf(){interfaceLocal{readonlycreatedAt:string;readonlyupdatedAt:string;}}",
    );
  });

  test("expands a member macro two namespaces down", () => {
    const { expand } = harness(definitions);
    expect(
      expand("namespace A { namespace B { interface C { timestamps } } }"),
    ).toBe(
      "namespaceA{namespaceB{interfaceC{readonlycreatedAt:string;readonlyupdatedAt:string;}}}",
    );
  });

  test("still expands a type alias body in the same namespace", () => {
    const { expand } = harness(definitions);
    expect(expand("namespace Inner { type Row = { timestamps }; }")).toBe(
      "namespaceInner{typeRow={readonlycreatedAt:string;readonlyupdatedAt:string;};}",
    );
  });
});

/**
 * A member is written with the separator that ends it, so the invocation of a
 * member macro spans that separator too. A macro that ends its own last member
 * leaves the written separator with nothing to terminate, and it stood in the
 * output as a member of its own -- which TypeScript reports as a missing
 * property or signature.
 */
describe("the separator after a member macro", () => {
  test("consumes a `;` written after the macro in an object type", () => {
    const { expand } = harness(definitions);
    expect(expand("type Separated = { timestamps; };")).toBe(
      "typeSeparated={readonlycreatedAt:string;readonlyupdatedAt:string;};",
    );
  });

  test("consumes a `,` written after the macro in an object type", () => {
    const { expand } = harness(definitions);
    expect(expand("type Commas = { timestamps, id: string };")).toBe(
      "typeCommas={readonlycreatedAt:string;readonlyupdatedAt:string;id:string};",
    );
  });

  test("consumes a `;` written after the macro in an interface", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Separated { timestamps; }")).toBe(
      "interfaceSeparated{readonlycreatedAt:string;readonlyupdatedAt:string;}",
    );
  });

  test("consumes a `,` written after the macro in an interface", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Commas { timestamps, id: string }")).toBe(
      "interfaceCommas{readonlycreatedAt:string;readonlyupdatedAt:string;id:string}",
    );
  });

  test("puts the member after a terminated macro in its own member", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Two { timestamps; id: string }")).toBe(
      "interfaceTwo{readonlycreatedAt:string;readonlyupdatedAt:string;id:string}",
    );
  });

  test("keeps a macro whose single member is unterminated", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Single { only }")).toBe(
      "interfaceSingle{readonlyonly:string}",
    );
  });

  test("keeps the `;` that terminates such a macro's member", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Single { only; id: string }")).toBe(
      "interfaceSingle{readonlyonly:string;id:string}",
    );
  });

  test("keeps the `,` that terminates such a macro's member", () => {
    const { expand } = harness(definitions);
    expect(expand("type Single = { only, id: string };")).toBe(
      "typeSingle={readonlyonly:string,id:string};",
    );
  });

  test("leaves a newline-separated member list alone", () => {
    const { expand } = harness(definitions);
    expect(expand("interface Lines {\n  timestamps\n  id: string\n}")).toBe(
      "interfaceLines{readonlycreatedAt:string;readonlyupdatedAt:string;id:string}",
    );
  });
});

/**
 * The `=` of a type alias opens a type that runs to the end of the
 * declaration. A function type written in it spells its arrow `=>`, the same
 * token that opens an arrow function's body, so without the region the brace
 * after the arrow was read as an expression -- and a member macro written in
 * it was reported as being written where an expression is read.
 */
describe("an object type after the arrow of a function type", () => {
  test("expands a member macro in a function type's return type", () => {
    const { expand } = harness(definitions);
    expect(expand("type Returned = () => { timestamps };")).toBe(
      "typeReturned=()=>{readonlycreatedAt:string;readonlyupdatedAt:string;};",
    );
  });

  test("expands a member macro in a constructor type's return type", () => {
    const { expand } = harness(definitions);
    expect(expand("type Ctor = new () => { timestamps };")).toBe(
      "typeCtor=new()=>{readonlycreatedAt:string;readonlyupdatedAt:string;};",
    );
  });

  test("expands a member macro nested in a return type's type argument", () => {
    const { expand } = harness(definitions);
    expect(expand("type Nested = () => Array<{ timestamps }>;")).toBe(
      "typeNested=()=>Array<{readonlycreatedAt:string;readonlyupdatedAt:string;}>;",
    );
  });

  test("still expands a member macro in a parameter's object type", () => {
    const { expand } = harness(definitions);
    expect(expand("type Param = (a: { timestamps }) => void;")).toBe(
      "typeParam=(a:{readonlycreatedAt:string;readonlyupdatedAt:string;})=>void;",
    );
  });

  test("still expands a member macro in a function's return type", () => {
    const { expand } = harness(definitions);
    expect(
      expand("function fn(): { timestamps } | null { return null; }"),
    ).toBe(
      "functionfn():{readonlycreatedAt:string;readonlyupdatedAt:string;}|null{returnnull;}",
    );
  });

  test("still reads an arrow function's body as statements", () => {
    const { expand } = harness(definitions);
    expect(expand("const f = () => { return 1; };")).toBe(
      "constf=()=>{return1;};",
    );
  });

  /**
   * An alias names itself, so the `type` of one never stands directly in front
   * of its `=`. A class field or a variable spelled `type` does, and reading
   * back from the `=` for the keyword took one for an alias -- which put the
   * body of the arrow it was assigned inside a type.
   */
  test("still reads the body of an arrow a `type` field is assigned", () => {
    const { expand } = harness(definitions);
    expect(expand("class C { type = () => { logit }; }")).toBe(
      "classC{type=()=>{console.log(1);};}",
    );
  });

  test("still reads the body of an arrow a `type` variable is assigned", () => {
    const { expand } = harness(definitions);
    expect(expand("const type = () => { logit };")).toBe(
      "consttype=()=>{console.log(1);};",
    );
  });
});

/**
 * A brace written inside a type argument list is an object type, so its body
 * is a member list. The header before it belongs to the type argument's own
 * head, not to the brace: reading back over an unmatched `<` reached the
 * `class` of `class C extends make<{ timestamps }>() {}` and took the object
 * type for a class body.
 */
describe("an object type in a type argument list", () => {
  test("expands a member macro in what a class extends", () => {
    const { expand } = harness(definitions);
    expect(expand("class C extends make<{ timestamps }>() {}")).toBe(
      "classCextendsmake<{readonlycreatedAt:string;readonlyupdatedAt:string;}>(){}",
    );
  });

  test("expands a member macro in what a class implements", () => {
    const { expand } = harness(definitions);
    expect(expand('class C implements Pick<{ timestamps }, "a"> {}')).toBe(
      'classCimplementsPick<{readonlycreatedAt:string;readonlyupdatedAt:string;},"a">{}',
    );
  });

  test("expands a member macro in what a class expression extends", () => {
    const { expand } = harness(definitions);
    expect(expand("const K = class extends make<{ timestamps }>() {};")).toBe(
      "constK=classextendsmake<{readonlycreatedAt:string;readonlyupdatedAt:string;}>(){};",
    );
  });

  test("expands a member macro in a class type parameter's constraint", () => {
    const { expand } = harness(definitions);
    expect(expand("class C<T extends { timestamps }> {}")).toBe(
      "classC<Textends{readonlycreatedAt:string;readonlyupdatedAt:string;}>{}",
    );
  });

  test("expands a member macro in a call's type arguments", () => {
    const { expand } = harness(definitions);
    expect(expand("const row = make<{ timestamps }>();")).toBe(
      "constrow=make<{readonlycreatedAt:string;readonlyupdatedAt:string;}>();",
    );
  });

  test("expands a type macro in what a class extends", () => {
    const { expand } = harness(definitions);
    expect(expand("class C extends make<list<string>>() {}")).toBe(
      "classCextendsmake<ReadonlyArray<string>>(){}",
    );
  });

  test("still expands a member macro in what an interface extends", () => {
    const { expand } = harness(definitions);
    expect(expand('interface I extends Pick<{ timestamps }, "a"> {}')).toBe(
      'interfaceIextendsPick<{readonlycreatedAt:string;readonlyupdatedAt:string;},"a">{}',
    );
  });

  test("still reads the class body after such a heritage clause", () => {
    const { expand } = harness(definitions);
    expect(
      expand("class C extends make<{ timestamps }>() { m() { logit } }"),
    ).toBe(
      "classCextendsmake<{readonlycreatedAt:string;readonlyupdatedAt:string;}>(){m(){console.log(1);}}",
    );
  });
});

/**
 * The same rule holds wherever a list is written with the separator that ends
 * each unit: an item list, a statement list and a class body separate on `;`,
 * and a macro that terminates what it emits leaves the written `;` with
 * nothing to terminate. It stood in the output as an empty statement or an
 * empty class member -- legal TypeScript, but not what was written.
 */
describe("the separator after an item, statement or class member macro", () => {
  test("consumes a `;` written after a statement macro", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { logit; }")).toBe(
      "functionf(){console.log(1);}",
    );
  });

  test("leaves an unseparated statement macro alone", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { logit }")).toBe(
      "functionf(){console.log(1);}",
    );
  });

  test("keeps the statement written after a terminated macro", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { logit; return 1; }")).toBe(
      "functionf(){console.log(1);return1;}",
    );
  });

  test("keeps the `;` that terminates an unterminated statement macro", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { loosely; }")).toBe(
      "functionf(){console.log(2);}",
    );
  });

  test("neither loses nor doubles a `;` the rule itself matched", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { logat(1); }")).toBe(
      "functionf(){console.log(1);}",
    );
  });

  test("keeps what follows a `;` the rule itself matched", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { logat(1); return 2; }")).toBe(
      "functionf(){console.log(1);return2;}",
    );
  });

  test("consumes a `;` written after a class member macro", () => {
    const { expand } = harness(definitions);
    expect(expand("class C { fieldy; other = 1; }")).toBe(
      "classC{readonlyname:string;other=1;}",
    );
  });

  test("leaves an unseparated class member macro alone", () => {
    const { expand } = harness(definitions);
    expect(expand("class C { fieldy other = 1; }")).toBe(
      "classC{readonlyname:string;other=1;}",
    );
  });

  test("keeps the `;` that terminates an unterminated class member macro", () => {
    const { expand } = harness(definitions);
    expect(expand("class C { loosefield; }")).toBe(
      "classC{readonlyother:string;}",
    );
  });

  test("consumes a `;` written after an item macro", () => {
    const { expand } = harness(definitions);
    expect(expand("nowhere;")).toBe("constgenerated=1;");
  });

  /**
   * A class, enum or interface body written at statement level is a member
   * list, and the members in it are reached.
   *
   * Only a function, namespace or module body was enforested there, so a class
   * declared inside a function body stayed an opaque token tree: a member
   * macro written among its members was never dispatched, and the expander
   * walked its tokens under the statement category instead. The same class one
   * line further out, at a module's top level, expanded.
   */
  test("keeps an invocation that contains a comma whole in a function body", () => {
    const { expand } = harness(definitions);
    expect(
      expand(
        "function f() { interface Parser {\n  head: string;\n  overloaded parse over string, number\n  tail: string;\n} }",
      ),
    ).toBe(
      "functionf(){interfaceParser{head:string;parse(value:string):string;parse(value:number):number;tail:string;}}",
    );
  });

  test("expands a class member macro in a class inside a function body", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { class C { fieldy; } }")).toBe(
      "functionf(){classC{readonlyname:string;}}",
    );
  });

  test("expands a member macro in an interface inside a function body", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { interface I { timestamps } }")).toBe(
      "functionf(){interfaceI{readonlycreatedAt:string;readonlyupdatedAt:string;}}",
    );
  });

  test("expands a class member macro in a class inside a block", () => {
    const { expand } = harness(definitions);
    expect(expand("function f() { { class C { fieldy; } } }")).toBe(
      "functionf(){{classC{readonlyname:string;}}}",
    );
  });

  test("expands a class member macro in a class inside a namespace body", () => {
    const { expand } = harness(definitions);
    expect(expand("namespace N { class C { fieldy; } }")).toBe(
      "namespaceN{classC{readonlyname:string;}}",
    );
  });
});
