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
    scopes.freshScope("module", "type-capture-definitions"),
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
      scopes: scopes.singleton(
        scopes.freshScope("lexical", "type-capture-use"),
      ),
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
  export syntax wrap:type {
    rule { wrap { $element:type } } => { [$element] }
  }
  export syntax list:type {
    rule { list<$element:type> } => { ReadonlyArray<$element> }
  }
  export syntax class TypeArm {
    fields { pattern: type; result: type; }
    rule { $pattern:type => $result:type; }
  }
  export syntax match:type {
    rule { match $subject:type { _ => $fallback:type; } } => { $fallback }
    rule {
      match $subject:type { $first:TypeArm $($rest:TypeArm)* _ => $fallback:type; }
    } => {
      $subject extends $first.pattern
        ? $first.result
        : match $subject { $($rest.pattern => $rest.result;)* _ => $fallback; }
    }
  }
`;

/**
 * A typed capture has to recognize a type macro standing in it. Without that,
 * only a macro shaped like an ordinary generic type (\`list<string>\`) survives:
 * one written with a brace (\`wrap { string }\`) reads its name as a type
 * reference, stops at the brace, and the enclosing rule refuses its input.
 */
describe("type macros inside type captures", () => {
  test("expands a brace-shaped type macro captured as a type", () => {
    const { expand } = harness(definitions);
    expect(expand("type A = list<wrap { string }>;")).toBe(
      "typeA=ReadonlyArray<[string]>;",
    );
  });

  test("expands a type macro in a syntax-class field followed by a separator", () => {
    const { expand } = harness(definitions);
    expect(
      expand("type A<T> = match T { string => match T { _ => 1; }; _ => 2; };"),
    ).toBe("typeA<T>=Textendsstring?1:2;");
  });

  test("expands a type macro as the fallback of the macro that captured it", () => {
    const { expand } = harness(definitions);
    expect(expand("type A<T> = match T { _ => wrap { T }; };")).toBe(
      "typeA<T>=[T];",
    );
  });
});
