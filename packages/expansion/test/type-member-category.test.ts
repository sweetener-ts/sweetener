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
  ): { text: string; diagnostics: readonly Diagnostic[] } => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "type-member-use")),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    const result = session.expand(withoutEof(read.root.children), "item");
    return { text: compact(result.syntax), diagnostics: result.diagnostics };
  };
  return {
    expand: (source: string) => {
      const result = run(source);
      expect(result.diagnostics).toEqual([]);
      return result.text;
    },
    diagnose: (source: string) => run(source).diagnostics,
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
   * own. Reading the member up to the first comma cut the invocation in half
   * and emitted the remainder verbatim.
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
   * meaning it. Dispatching there rewrote the declaration of a property whose
   * name simply collided.
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
   * Without the category a macro written here was dispatched as an item and
   * blamed for expanding to something that is not one item. With it, a name
   * that resolves in no member space but does resolve elsewhere is reported
   * against the category it was declared for, rather than left to become an
   * implicitly-typed member TypeScript may not even complain about.
   */
  test("reports a macro declared for another category", () => {
    const { diagnose } = harness(definitions);
    const diagnostics = diagnose("interface Row { nowhere }");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe("SWR4013");
    expect(diagnostics[0]?.messageArguments).toEqual([
      "nowhere",
      "item",
      "typeMember",
    ]);
  });

  test("does not report an ordinary member that shares a macro name", () => {
    const { diagnose } = harness(definitions);
    expect(diagnose("interface Row { nowhere: string; }")).toEqual([]);
  });
});
