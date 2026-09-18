import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  createBindingConsumer,
  createItemConsumer,
  createPrattExpressionConsumer,
  createStatementConsumer,
  createTypeConsumer,
  StopSet,
  type ConsumerContext,
  type SyntaxConsumer,
} from "@sweetener/enforestation";
import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { createSyntaxClassConsumer } from "@sweetener/pattern";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type EnvironmentEpoch,
  type InvocationId,
  type SourceId,
  type SyntaxClassId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createSyntaxCursor,
  createSyntaxSequence,
  OriginStore,
  type Syntax,
} from "@sweetener/syntax";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  CoreShadowRegistry,
  expandMacroSyntax,
  ExpansionEnvironmentStore,
  ExpansionGuard,
  resolveCoreDispatch,
} from "../src/index.js";

const fixture = "fixtures/acceptance/playground/core-rewrites";
const definitionSource = 760 as SourceId;
const invocationSource = 761 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(syntax: readonly Syntax[]) {
  return compactText(printLosslessSequence(syntax));
}

function compactText(source: string) {
  return source.replace(/\s+/gu, "").replace(/,\)/gu, ")");
}

function tokens(syntax: readonly Syntax[]): readonly Syntax[] {
  return syntax.flatMap((node) =>
    node.tag === "group" || node.tag === "protected"
      ? tokens(node.children)
      : [node],
  );
}

function createHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "core-rewrites-definition"),
  );
  const read = readSyntax(readFileSync(`${fixture}/declarative.sts`, "utf8"), {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(read.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(140_000);
  const bindingIds = createIdAllocator<BindingId>(140_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const module = compileParsedMacros(parsed, {
    sourceId: definitionSource,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(read.diagnostics).toEqual([]);
  expect(module.diagnostics).toEqual([]);
  expect(module.bindingLiterals).toMatchObject([
    { alias: "NaN", reference: "globalThis.NaN" },
  ]);

  const diagnosticOrigin = (origin: Parameters<OriginStore["get"]>[0]) => {
    const selected = origins.selectPrimarySource(origin);
    return {
      sourceId: selected?.sourceId ?? invocationSource,
      start: selected?.span.start ?? 0,
      end: selected?.span.end ?? 0,
      originId: origin,
    };
  };
  let shadows = new CoreShadowRegistry();
  const expansionStore = new ExpansionEnvironmentStore();
  let expansionEnvironment = expansionStore.createRoot();
  for (const macro of module.macros) {
    const definition = module.definitions.find(
      ({ macro: candidate }) => candidate === macro,
    )!.definition;
    const local = shadows.withLocal({
      binding: macro.binding,
      definition,
      diagnosticOrigin,
    });
    const imported = local.registry.withImport({
      binding: macro.binding,
      exported: local.metadata,
      importOrigin: macro.binding.declaration,
      shadowsCore: true,
      diagnosticOrigin,
    });
    expect([...local.diagnostics, ...imported.diagnostics]).toEqual([]);
    shadows = imported.registry;
    expansionEnvironment = expansionStore.extendBinding(
      expansionEnvironment,
      macro.binding,
    );
  }

  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const expression = createPrattExpressionConsumer(shared);
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const type = createTypeConsumer(shared);
  const item = createItemConsumer(shared);
  const consumers = new Map<SyntaxClassId, SyntaxConsumer>([
    [module.classId("expr")!, expression],
    [module.classId("binding")!, binding],
    [module.classId("stmt")!, statement],
    [module.classId("type")!, type],
  ]);
  const context = (category: ConsumerContext["category"]): ConsumerContext => ({
    category,
    phase,
    environmentEpoch: 0 as EnvironmentEpoch,
    stopSet: StopSet.empty,
    tracker,
    cancellation: guard.cancellation,
    allowYield: false,
    allowAwait: false,
  });
  const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
    builtins: {
      token: module.classId("token")!,
      tt: module.classId("tt")!,
      ident: module.classId("ident")!,
    },
    tracker,
    environmentEpoch: 0,
    externalConsumer: (classId, cursor) => {
      const consumer = consumers.get(classId);
      if (consumer === undefined) return undefined;
      const category =
        classId === module.classId("expr")
          ? "expr"
          : classId === module.classId("binding")
            ? "binding"
            : classId === module.classId("stmt")
              ? "stmt"
              : "type";
      const start = cursor.index;
      const result = consumer.consume(cursor, context(category));
      if (!result.matched) return undefined;
      const syntax = cursor
        .remainingRange()
        .sequence.slice(start, result.cursor.index);
      return {
        cursor: result.cursor,
        syntax: createSyntaxSequence(syntax),
        origin: syntax[0]!.origin,
      };
    },
  });
  const environments = new EnvironmentStore();
  const environment = environments.createRoot();

  const expand = (
    source: string,
    category: "expr" | "item",
    globalNaN = true,
  ) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(
        scopes.freshScope("lexical", "core-rewrites-callsite"),
      ),
      originStore: origins,
    });
    const macro = module.get(
      category === "expr" ? "typeof" : "function",
      category,
    )!;
    const dispatch = resolveCoreDispatch({
      environments: expansionStore,
      environment: expansionEnvironment,
      shadows,
      spelling: macro.binding.spelling,
      category,
      phase,
      origin: macro.binding.declaration,
      diagnosticOrigin,
    });
    if (dispatch.kind !== "shadow-macro")
      throw new Error("core interception was not authorized");
    return expandMacroSyntax({
      module,
      syntax: withoutEof(invocation.root.children),
      category,
      consumeClass,
      phase,
      environmentEpoch: environment.epoch,
      expansionStore,
      expansionEnvironment,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      coreInterception: dispatch.trace,
      matchesBindingLiteral: (token, literal) =>
        globalNaN &&
        token.raw === literal.spelling &&
        literal.binding === module.bindingLiterals[0]?.binding,
      extractBindings: (syntax) => {
        const result = binding.consumeBinding(
          createSyntaxCursor(syntax),
          context("binding"),
        );
        return result.matched
          ? result.skeleton.names.map((name) => ({
              spelling: name.spelling,
              origin: name.origin,
              scopes: name.scopes,
            }))
          : [];
      },
      enforest: ({ syntax }) => {
        const consumer = category === "expr" ? expression : item;
        const result = consumer.consume(
          createSyntaxCursor(syntax),
          context(category),
        );
        if (!result.matched || !result.cursor.atEnd)
          throw new TypeError(
            `expanded core rewrite is not ${category}: ${printLosslessSequence(syntax)}`,
          );
        return result.syntax;
      },
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: () => true,
      diagnosticOrigin,
    });
  };
  return { expand, scopes, definitionScopes };
}

describe("core-rewrites acceptance", () => {
  test("uses binding identity for the NaN specialization and a protected fallback", () => {
    const harness = createHarness();
    const specialized = harness.expand("typeof NaN", "expr");
    expect(specialized.diagnostics).toEqual([]);
    expect(compact(specialized.syntax)).toBe('"NaN"');
    expect(specialized.traces[0]?.selectedRule).toBeDefined();
    const shadowed = harness.expand("typeof NaN", "expr", false);
    expect(shadowed.diagnostics).toEqual([]);
    expect(compact(shadowed.syntax)).toBe("typeofNaN");
    expect(
      shadowed.traces[0]?.attemptedRules.map(({ status }) => status),
    ).toEqual(["no-match", "selected"]);
  });

  test("generates a counted arity check without recursively re-entering function", () => {
    const result = createHarness().expand(
      "export function exact(value: number): number { return value; }",
      "item",
    );
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe(
      compactText(
        readFileSync(`${fixture}/expected.ts`, "utf8").split(
          "export const nanKind",
        )[0]!,
      ),
    );
    expect(compact(result.syntax)).toContain(
      "arguments.length!==globalThis.Number(1)",
    );
    expect(compact(result.syntax)).toContain(
      '"exact"+"requires"+globalThis.Number(1)+"argument(s)"',
    );
    expect(compact(result.syntax)).toContain("newglobalThis.Error(");
    expect(result.traces).toHaveLength(1);
    expect(
      result.traces[0]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["exact", "value"]);
    expect(
      result.traces[0]?.operations.map(({ operation }) => operation),
    ).toEqual(["count", "text", "count"]);
  });

  test("keeps the generated Error reference at definition scope", () => {
    const { expand, scopes, definitionScopes } = createHarness();
    const result = expand(
      "export function exact(value: number): number { return value; }",
      "item",
    );
    const error = tokens(result.syntax).find(
      (node) => node.tag === "token" && node.raw === "Error",
    );
    expect(error).toBeDefined();
    expect(
      error === undefined
        ? false
        : scopes.subset(definitionScopes, error.scopes),
    ).toBe(true);
  });

  test("reports the exact missing-body diagnostic", () => {
    const result = createHarness().expand(
      "export function exact(value: number): number;",
      "item",
    );
    expect(
      result.diagnostics.map(({ code, stage, severity, messageArguments }) => ({
        code,
        stage,
        severity,
        messageArguments,
      })),
    ).toEqual(
      JSON.parse(
        readFileSync(`${fixture}/expected.malformed.diagnostics.json`, "utf8"),
      ),
    );
  });

  test("emits strict TypeScript and rejects an extra runtime argument", () => {
    const result = createHarness().expand(
      "export function exact(value: number): number { return value; }",
      "item",
    );
    const source = `${printLosslessSequence(result.syntax)}
      let rejected = false;
      try { (exact as (...values: number[]) => number)(1, 2); } catch { rejected = true; }
      const result = [exact(2), rejected];`;
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        strict: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.CommonJS,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
    expect(
      runInNewContext(`${transpiled.outputText}\nresult`, { exports: {} }),
    ).toEqual([2, true]);
  });
});
