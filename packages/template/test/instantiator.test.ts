import { createInvocationScopes, ScopeStore } from "@sweetener/hygiene";
import {
  CaptureRecord,
  createCaptureLeaf,
  createLeafShape,
  type CaptureShapeBinding,
} from "@sweetener/pattern";
import { readSyntax } from "@sweetener/reader";
import {
  CancellationError,
  CancellationSource,
  createIdAllocator,
  ResourceLimitError,
  type BindingId,
  type CaptureId,
  type OriginId,
  type SourceId,
  type SyntaxClassId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  OriginStore,
  type GroupSyntax,
  type Span,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  evaluateTemplate,
  instantiateTemplate,
  parseTemplate,
  type EvaluatedTemplate,
} from "../src/index.js";

const definitionSource = 91 as SourceId;
const invocationSource = 92 as SourceId;
const nameCapture = 1 as CaptureId;
const exprCapture = 2 as CaptureId;
const identClass = 1 as SyntaxClassId;
const exprClass = 2 as SyntaxClassId;

function binding(
  name: string,
  capture: CaptureId,
  classId: SyntaxClassId,
): CaptureShapeBinding {
  return Object.freeze({
    name,
    capture,
    origin: 1 as OriginId,
    shape: createLeafShape(classId),
  });
}

function setup(templateSource: string) {
  const scopeStore = new ScopeStore();
  const definitionLexical = scopeStore.freshScope("lexical", "definition");
  const callerLexical = scopeStore.freshScope("lexical", "caller");
  const definitionScopes = scopeStore.singleton(definitionLexical);
  const callsiteScopes = scopeStore.singleton(callerLexical);
  const origins = new OriginStore();
  const definitionRead = readSyntax(templateSource, {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const templateGroup = definitionRead.root.children.find(
    (syntax): syntax is GroupSyntax => syntax.tag === "group",
  );
  if (templateGroup === undefined) throw new Error("missing template group");
  const invocationRead = readSyntax("caller(a + b)", {
    sourceId: invocationSource,
    scopes: callsiteScopes,
    originStore: origins,
  });
  const caller = invocationRead.root.children[0]!;
  const expression = invocationRead.root.children[1]!;
  const captures = new CaptureRecord([
    [
      nameCapture,
      createCaptureLeaf({
        id: nameCapture,
        classId: identClass,
        syntax: [caller],
        origin: caller.origin,
      }),
    ],
    [
      exprCapture,
      createCaptureLeaf({
        id: exprCapture,
        classId: exprClass,
        syntax: [expression],
        origin: expression.origin,
      }),
    ],
  ]);
  const spans = new Map<OriginId, Span>();
  const pending: Syntax[] = [
    ...definitionRead.root.children,
    ...invocationRead.root.children,
  ];
  while (pending.length > 0) {
    const syntax = pending.pop()!;
    spans.set(syntax.origin, syntax.span);
    if (syntax.tag === "group" || syntax.tag === "protected") {
      pending.push(...syntax.children);
    }
  }
  const parsed = parseTemplate(templateGroup, {
    sourceId: definitionSource,
    captures: [
      binding("name", nameCapture, identClass),
      binding("expr", exprCapture, exprClass),
    ],
    identifierClassIds: [identClass],
    spanForOrigin: (origin) => spans.get(origin) ?? { start: 0, end: 0 },
  });
  expect(parsed.diagnostics).toEqual([]);
  const evaluated = evaluateTemplate(parsed.template, { captures });
  const invocationOrigin = caller.origin;
  const invocationScopes = createInvocationScopes(scopeStore);
  const syntaxIds = createIdAllocator<SyntaxId>(1_000);
  const bindingIds = createIdAllocator<BindingId>(1_000);
  const instantiate = (
    overrides: Partial<Parameters<typeof instantiateTemplate>[1]> = {},
    output: readonly EvaluatedTemplate[] = evaluated.output,
  ) =>
    instantiateTemplate(output, {
      scopeStore,
      origins,
      invocationScopes,
      invocationOrigin,
      definitionScopes,
      callsiteScopes,
      anchor: { start: caller.span.start, end: caller.span.start },
      allocateSyntaxId: () => syntaxIds.allocate(),
      allocateBindingId: () => bindingIds.allocate(),
      category: "expr",
      ...overrides,
    });
  return {
    scopeStore,
    origins,
    invocationScopes,
    definitionLexical,
    callerLexical,
    definitionScopes,
    callsiteScopes,
    caller,
    expression,
    evaluated,
    instantiate,
  };
}

describe("template instantiator", () => {
  test("normalizes a captured value to one inline leading space", () => {
    const context = setup("{ return #trim($expr) }");
    const result = context.instantiate();
    const expression = result.syntax[1];
    if (expression?.tag !== "group")
      throw new Error("expected expression group");
    expect(expression.open.leadingTrivia.map(({ raw }) => raw)).toEqual([" "]);
    expect(context.evaluated.trace).toMatchObject([{ operation: "trim" }]);
  });

  test("applies introduction scopes to literals and use-site scopes to captures", () => {
    const context = setup("{ helper($name) }");
    const result = context.instantiate();
    expect(result.syntax).toHaveLength(2);
    const helper = result.syntax[0]!;
    const call = result.syntax[1];
    expect(helper.tag).toBe("token");
    expect(
      context.scopeStore.has(helper.scopes, context.definitionLexical),
    ).toBe(true);
    expect(
      context.scopeStore.has(
        helper.scopes,
        context.invocationScopes.introduction,
      ),
    ).toBe(true);
    if (call?.tag !== "group") throw new Error("expected call group");
    const copied = call.children[0]!;
    expect(context.scopeStore.has(copied.scopes, context.callerLexical)).toBe(
      true,
    );
    expect(
      context.scopeStore.has(copied.scopes, context.invocationScopes.useSite),
    ).toBe(true);
    expect(
      context.scopeStore.has(
        copied.scopes,
        context.invocationScopes.introduction,
      ),
    ).toBe(false);
    expect(context.origins.get(helper.origin)?.kind).toBe("introduced");
    expect(context.origins.get(copied.origin)).toMatchObject({
      kind: "copied",
      capture: nameCapture,
      parent: context.caller.origin,
    });
    expect(call.close.tag).toBe("token");
    expect(Object.isFrozen(result.syntax)).toBe(true);
  });

  test("materializes explicit scope operations with distinct policies", () => {
    const context = setup(
      "{ #callsite($name) #definition($name) #capture($name) }",
    );
    const result = context.instantiate();
    const [callsite, definition, captured] = result.syntax;
    if (
      callsite?.tag !== "token" ||
      definition?.tag !== "token" ||
      captured?.tag !== "token"
    ) {
      throw new Error("expected identifier tokens");
    }
    expect(
      context.scopeStore.has(callsite.scopes, context.invocationScopes.useSite),
    ).toBe(true);
    expect(
      context.scopeStore.has(
        callsite.scopes,
        context.invocationScopes.introduction,
      ),
    ).toBe(false);
    expect(
      context.scopeStore.has(definition.scopes, context.definitionLexical),
    ).toBe(true);
    expect(
      context.scopeStore.has(
        definition.scopes,
        context.invocationScopes.introduction,
      ),
    ).toBe(true);
    expect(
      context.scopeStore.has(
        captured.scopes,
        context.invocationScopes.introduction,
      ),
    ).toBe(true);
    expect(
      result.syntax.map((syntax) => context.origins.get(syntax.origin)?.kind),
    ).toEqual(["composed", "composed", "composed"]);
  });

  test("materializes fresh, stable text, and indices with identities", () => {
    const context = setup(
      '{ #fresh("tmp") #text($expr) #join($name, prefix: "set", casing: "upper-first") }',
    );
    const result = context.instantiate();
    expect(result.syntax).toMatchObject([
      { tag: "token", kind: "identifier", raw: "tmp" },
      {
        tag: "token",
        kind: "string-literal",
        raw: '"(a + b)"',
        value: "(a + b)",
      },
      { tag: "token", kind: "identifier", raw: "setCaller" },
    ]);
    expect(
      result.syntax[2]?.tag === "token" && result.syntax[2].leadingTrivia,
    ).toMatchObject([{ kind: "whitespace", raw: " " }]);
    // A replacement carries no leading whitespace of its own; the invocation
    // it stands in for supplies the spacing.
    expect(
      result.syntax[0]?.tag === "token" && result.syntax[0].leadingTrivia,
    ).toEqual([]);
    expect(
      result.syntax[1]?.tag === "token" && result.syntax[1].leadingTrivia,
    ).toMatchObject([{ kind: "whitespace", raw: " " }]);
    expect(result.freshBindings).toEqual([
      {
        binding: 1_000,
        syntax: result.syntax[0]!.id,
        hint: "tmp",
        ordinal: 0,
        origin: result.syntax[0]!.origin,
      },
    ]);
    expect(context.origins.get(result.syntax[0]!.origin)?.kind).toBe(
      "synthesized",
    );
    const indexOrigin = context.evaluated.output[0]!.origin;
    const indexed = context.instantiate({}, [
      Object.freeze({
        kind: "operation",
        operation: "index",
        value: 7,
        origin: indexOrigin,
      }),
    ]);
    expect(indexed.syntax).toMatchObject([
      { tag: "token", kind: "numeric-literal", raw: "7", value: 7 },
    ]);
    const counted = context.instantiate({}, [
      Object.freeze({
        kind: "operation",
        operation: "count",
        value: 3,
        origin: indexOrigin,
      }),
    ]);
    expect(counted.syntax).toMatchObject([
      { tag: "token", kind: "numeric-literal", raw: "3", value: 3 },
    ]);
  });

  test("materializes generated metavariables without allocating runtime bindings", () => {
    const context = setup('{ #fresh("tmp") }');
    const origin = context.evaluated.output[0]!.origin;
    const result = context.instantiate({}, [
      Object.freeze({
        kind: "operation",
        operation: "metavar",
        hint: "argument",
        indices: Object.freeze([2, 1]),
        origin,
      }),
    ]);
    expect(result.syntax).toMatchObject([
      { tag: "token", kind: "identifier", raw: "$argument_2_1" },
    ]);
    expect(result.freshBindings).toEqual([]);
  });

  test("constructs balanced groups when no delimiter prototype is available", () => {
    const context = setup("{ value }");
    const origin = context.evaluated.output[0]!.origin;
    const result = context.instantiate({}, [
      Object.freeze({
        kind: "group",
        origin,
        delimiter: "bracket",
        open: undefined,
        close: undefined,
        scopes: undefined,
        body: Object.freeze(context.evaluated.output),
      }),
    ]);
    const group = result.syntax[0];
    expect(group).toMatchObject({
      tag: "group",
      delimiter: "bracket",
      open: { raw: "[" },
      close: { tag: "token", raw: "]" },
    });
  });

  test("enforces output limits and cancellation without returning partial syntax", () => {
    const limited = setup("{ one two }");
    expect(() =>
      limited.instantiate({ budget: { maxOutputTokens: 1 } }),
    ).toThrowError(new ResourceLimitError("output-tokens", 1, 2));
    const cancelled = setup("{ one }");
    const source = new CancellationSource();
    source.cancel();
    expect(() => cancelled.instantiate({ cancellation: source.token })).toThrow(
      CancellationError,
    );
  });
});
