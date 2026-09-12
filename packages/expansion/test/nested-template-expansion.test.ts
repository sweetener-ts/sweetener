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
  return (source: string, category: "expr" | "stmt" | "item" | "type") => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "nested-use")),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    const result = session.expand(withoutEof(read.root.children), category);
    expect(result.diagnostics).toEqual([]);
    return compact(result.syntax);
  };
}

/**
 * A macro written in another macro's template has to expand wherever it
 * stands. A replacement is walked before it is parsed, so the category of a
 * position in it was read from the single token in front of it. That found the
 * head of an emitted expression and the elements of an array literal and
 * nothing else: a macro in an argument list, an operand, an arrow body or a
 * function body resolved in the category of the declaration around it, found
 * no macro, and was emitted verbatim as a call to a function that does not
 * exist -- with no diagnostic to say so.
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
 * complete operand without reading what follows left a template's own postfix
 * -- `$value.every(check)`, `$value[0]`, `$value(arg)` -- for a caller with
 * nowhere to put it, and the expansion was reported as not one expression.
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
