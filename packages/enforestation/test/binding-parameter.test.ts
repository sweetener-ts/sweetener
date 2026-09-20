import { createPhase, EnvironmentStore } from "@sweetener/hygiene";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type EnvironmentEpoch,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import { createSyntaxCursor, OriginStore } from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  consumeParameterList,
  createConsumerSuite,
  registerBindingSkeleton,
  StopSet,
} from "../src/index.js";

const sourceId = 109 as SourceId;

function setup(source: string) {
  const origins = new OriginStore();
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
  });
  expect(read.diagnostics).toEqual([]);
  const syntax = read.root.children.filter(
    (node) => node.tag !== "token" || node.kind !== "end-of-file",
  );
  const ids = createIdAllocator<SyntaxId>(50_000);
  const tracker = new ResourceTracker(createResourceBudget());
  const context = Object.freeze({
    category: "binding" as const,
    phase: createPhase(0),
    environmentEpoch: 0 as EnvironmentEpoch,
    stopSet: StopSet.empty,
    tracker,
    allowYield: false,
    allowAwait: false,
    cancellation: Object.freeze({
      isCancellationRequested: false,
      throwIfCancellationRequested() {},
    }),
  });
  const options = { origins, allocateSyntaxId: ids.allocate };
  // Wired as the expander wires it, so the harness and the pipeline cannot
  // read different languages. `consumeParameterList` takes the plain options
  // it is given, which is the surface it exposes.
  const suite = createConsumerSuite(options);
  return { syntax, origins, ids, tracker, context, options, suite };
}

function binding(source: string) {
  const prepared = setup(source);
  const consumer = prepared.suite.binding;
  const registry = prepared.suite.registry;
  const cursor = createSyntaxCursor(prepared.syntax);
  const result = registry.consume("binding", {
    cursor,
    phase: prepared.context.phase,
    environmentEpoch: prepared.context.environmentEpoch,
    tracker: prepared.tracker,
    allowYield: prepared.context.allowYield,
    allowAwait: prepared.context.allowAwait,
  });
  if (!result.matched) throw new Error(result.failure.expectations.join(", "));
  const detailed = consumer.consumeBinding(
    createSyntaxCursor(prepared.syntax),
    prepared.context,
  );
  if (!detailed.matched) throw new Error("missing binding skeleton");
  return { ...prepared, result, skeleton: detailed.skeleton, cursor };
}

describe("binding and parameter consumers", () => {
  test("returns an immutable identifier skeleton", () => {
    const { skeleton, result } = binding("name: Type");
    expect(skeleton.shape).toBe("identifier");
    expect(skeleton.names.map(({ spelling }) => spelling)).toEqual(["name"]);
    expect(skeleton.syntax.category).toBe("binding");
    expect(result.cursor.index).toBe(1);
    expect(Object.isFrozen(skeleton)).toBe(true);
    expect(Object.isFrozen(skeleton.names[0]?.path)).toBe(true);
  });

  test("enumerates nested object names without treating property keys as bindings", () => {
    const { skeleton } = binding(
      "{ short, source: target, [computed]: computedValue, nested: { deep }, defaulted = fallback, ...rest }",
    );
    expect(skeleton.shape).toBe("object");
    expect(skeleton.names.map(({ spelling }) => spelling)).toEqual([
      "short",
      "target",
      "computedValue",
      "deep",
      "defaulted",
      "rest",
    ]);
    expect(skeleton.names.map(({ path }) => path)).toMatchObject([
      [{ kind: "object-property", property: "short" }],
      [{ kind: "object-property", property: "source" }],
      [{ kind: "object-property", property: "[computed]" }],
      [
        { kind: "object-property", property: "nested" },
        { kind: "object-property", property: "deep" },
      ],
      [{ kind: "object-property", property: "defaulted" }],
      [{ kind: "object-property", property: "rest" }, { kind: "rest" }],
    ]);
  });

  test("enumerates holes, nested patterns, defaults, and array rest", () => {
    const { skeleton } = binding(
      "[first, , { nested: renamed = fallback }, ...rest]",
    );
    expect(skeleton.shape).toBe("array");
    expect(skeleton.names.map(({ spelling }) => spelling)).toEqual([
      "first",
      "renamed",
      "rest",
    ]);
    expect(skeleton.names.map(({ path }) => path)).toMatchObject([
      [{ kind: "array-element", index: 0 }],
      [
        { kind: "array-element", index: 2 },
        { kind: "object-property", property: "nested" },
      ],
      [{ kind: "array-element", index: 3 }, { kind: "rest" }],
    ]);
  });

  test("parses parameter modifiers, types, defaults, optionality, and rest", () => {
    const prepared = setup(
      "(public readonly value?: number, { source: renamed, fallback = 1 }: Options = defaults, ...rest: string[]) after",
    );
    const cursor = createSyntaxCursor(prepared.syntax);
    const result = consumeParameterList(
      cursor,
      prepared.context,
      prepared.options,
    );
    expect(result).toBeDefined();
    expect(result?.cursor.index).toBe(1);
    expect(result?.skeleton.parameters).toHaveLength(3);
    expect(result?.skeleton.names.map(({ spelling }) => spelling)).toEqual([
      "value",
      "renamed",
      "fallback",
      "rest",
    ]);
    expect(result?.skeleton.parameters[0]).toMatchObject({
      optional: true,
      rest: false,
      modifiers: [{ raw: "public" }, { raw: "readonly" }],
      typeSyntax: [{ raw: "number" }],
    });
    expect(
      printLosslessSequence(
        result?.skeleton.parameters[1]?.initializerSyntax ?? [],
      ).trim(),
    ).toBe("defaults");
    expect(result?.skeleton.parameters[2]).toMatchObject({ rest: true });
  });

  test("rejects malformed patterns and parameter combinations transactionally", () => {
    for (const source of [
      "{ key: }",
      "{ ...{ nested } }",
      "[...rest = value]",
    ]) {
      const prepared = setup(source);
      const cursor = createSyntaxCursor(prepared.syntax);
      const registry = prepared.suite.registry;
      const result = registry.consume("binding", {
        cursor,
        phase: prepared.context.phase,
        environmentEpoch: prepared.context.environmentEpoch,
        tracker: prepared.tracker,
        allowYield: prepared.context.allowYield,
        allowAwait: prepared.context.allowAwait,
      });
      expect(result.matched).toBe(false);
      expect(cursor.index).toBe(0);
    }
    const invalidParameters = setup("(optional?: Type = value, ...rest = [])");
    expect(
      consumeParameterList(
        createSyntaxCursor(invalidParameters.syntax),
        invalidParameters.context,
        invalidParameters.options,
      ),
    ).toBeUndefined();
  });

  test("registers every destructured name in hygiene without reparsing text", () => {
    const { skeleton } = binding("{ left, source: right }");
    const store = new EnvironmentStore();
    const phase = createPhase(0);
    const result = registerBindingSkeleton({
      store,
      environment: store.createRoot(),
      skeleton,
      phase,
      space: "value",
      kind: "parameter",
    });
    expect(result.bindings.map(({ spelling }) => spelling)).toEqual([
      "left",
      "right",
    ]);
    expect(result.bindings[0]?.declarationGroup).toBe(
      result.bindings[1]?.declarationGroup,
    );
    expect(
      store.candidates(result.environment, {
        spelling: "right",
        phase,
        space: "value",
        position: 0,
      }),
    ).toEqual([result.bindings[1]]);
  });

  test("accepts trailing commas, computed keys, and typed this parameters", () => {
    const computed = binding("{ [key]: value, }").skeleton;
    expect(computed.names).toMatchObject([
      {
        spelling: "value",
        path: [{ kind: "object-property", property: "[computed]" }],
      },
    ]);
    const prepared = setup("(this: Context, value: number,)");
    const result = consumeParameterList(
      createSyntaxCursor(prepared.syntax),
      prepared.context,
      prepared.options,
    );
    expect(result?.skeleton.parameters).toMatchObject([
      { thisParameter: true, binding: undefined },
      { thisParameter: false, binding: { shape: "identifier" } },
    ]);
    expect(result?.skeleton.names.map(({ spelling }) => spelling)).toEqual([
      "value",
    ]);
  });

  test.each([
    "[...rest, after]",
    "[value =]",
    "{ first,, second }",
    "{ ...rest: renamed }",
  ])("rejects invalid binding edge %s", (source) => {
    const prepared = setup(source);
    const result = prepared.suite.binding.consumeBinding(
      createSyntaxCursor(prepared.syntax),
      prepared.context,
    );
    expect(result.matched).toBe(false);
  });

  test.each(["(...rest: string[], after: string)", "(value?: T = fallback)"])(
    "rejects invalid parameter edge %s",
    (source) => {
      const prepared = setup(source);
      expect(
        consumeParameterList(
          createSyntaxCursor(prepared.syntax),
          prepared.context,
          prepared.options,
        ),
      ).toBeUndefined();
    },
  );

  test("representative bindings and parameters parse under pinned TypeScript", () => {
    const sources = [
      "const { short, source: target, nested: { deep }, ...rest } = value;",
      "const [first, , nested = fallback, ...rest] = values;",
      "function run(value?: number, { source: renamed }: Options = defaults, ...rest: string[]) {}",
    ];
    for (const source of sources) {
      const parsed = ts.createSourceFile(
        "binding.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ) as ts.SourceFile & {
        readonly parseDiagnostics: readonly ts.Diagnostic[];
      };
      expect(parsed.parseDiagnostics, source).toEqual([]);
    }
  });

  /**
   * A binder is named by any word TypeScript does not reserve, in a parameter
   * list as in a declarator.
   *
   * The reader labels a contextual keyword a keyword token, as TypeScript's
   * scanner does, and this consumer had asked for the `identifier` label.
   * Every parameter named for one was refused, and with it the whole parameter
   * list -- so a method written `render(type: Kind)` left its class body
   * unread and the macros among its members unexpanded.
   */
  test.each([
    ["(type)", ["type"]],
    ["(from, of)", ["from", "of"]],
    ["({ type })", ["type"]],
    ["([type])", ["type"]],
    ["(...type)", ["type"]],
    ["(public type: Kind)", ["type"]],
    ["(type?: Kind)", ["type"]],
    ["(type: Kind = fallback)", ["type"]],
    // A modifier word names a parameter where no binder follows it, and
    // TypeScript reads `function f(readonly) {}` as a parameter so named.
    ["(readonly)", ["readonly"]],
    ["(readonly: Kind)", ["readonly"]],
    ["(readonly?: Kind)", ["readonly"]],
    ["(readonly = 1)", ["readonly"]],
    ["(out, override)", ["out", "override"]],
    ["(readonly readonly: Kind)", ["readonly"]],
  ])("names the parameters of %s", (source, names) => {
    const prepared = setup(source);
    const result = consumeParameterList(
      createSyntaxCursor(prepared.syntax),
      prepared.context,
      prepared.options,
    );
    expect(result, source).toBeDefined();
    expect(result?.skeleton.names.map(({ spelling }) => spelling)).toEqual(
      names,
    );
    const parsed = ts.createSourceFile(
      "binding.ts",
      `function run${source} {}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ) as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    };
    expect(parsed.parseDiagnostics, source).toEqual([]);
  });

  test.each([
    ["type", ["type"]],
    ["{ type }", ["type"]],
    ["{ source: type }", ["type"]],
    ["{ ...type }", ["type"]],
    ["[type, from]", ["type", "from"]],
    ["{ type = 1 }", ["type"]],
  ])("names the binding %s", (source, names) => {
    const prepared = setup(source);
    const result = prepared.suite.binding.consumeBinding(
      createSyntaxCursor(prepared.syntax),
      prepared.context,
    );
    expect(result.matched, source).toBe(true);
    if (!result.matched) throw new Error("expected a binding");
    expect(result.skeleton.names.map(({ spelling }) => spelling)).toEqual(
      names,
    );
  });

  /**
   * A reserved word names no binding. The strict-mode reservations are among
   * them because every module is strict: TypeScript answers `let interface`
   * with "Identifier expected. 'interface' is a reserved word in strict mode.
   * Modules are automatically in strict mode."
   */
  test.each([
    "in",
    "class",
    "function",
    "this",
    "typeof",
    "interface",
    "package",
    "static",
    "yield",
    "implements",
  ])("refuses the reserved binder %s", (word) => {
    const prepared = setup(word);
    const result = prepared.suite.binding.consumeBinding(
      createSyntaxCursor(prepared.syntax),
      prepared.context,
    );
    expect(result.matched, word).toBe(false);
  });
});
