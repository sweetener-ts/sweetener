import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  createBindingConsumer,
  createItemConsumer,
  createStatementConsumer,
  createTypeConsumer,
  StopSet,
  type ConsumerContext,
  type SyntaxConsumer,
} from "@sweetener/enforestation";
import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { createSyntaxClassConsumer } from "@sweetener/pattern";
import {
  createHygienicNamePlan,
  printWithAssignedNames,
} from "@sweetener/printer";
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

const definitionSource = 750 as SourceId;
const invocationSource = 751 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(source: string) {
  return source.replace(/\s+/gu, "");
}

function expectedDeclarations() {
  return readFileSync(
    "fixtures/acceptance/playground/currying/expected.ts",
    "utf8",
  ).split("export const result")[0]!;
}

function createHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "currying-definition"),
  );
  const read = readSyntax(
    readFileSync(
      "fixtures/acceptance/playground/currying/declarative.sts",
      "utf8",
    ),
    {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    },
  );
  const parsed = parseMacroDefinitions(read.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(130_000);
  const bindingIds = createIdAllocator<BindingId>(130_000);
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
  const macro = module.get("function", "item")!;
  const diagnosticOrigin = (origin: Parameters<OriginStore["get"]>[0]) => {
    const selected = origins.selectPrimarySource(origin);
    return {
      sourceId: selected?.sourceId ?? invocationSource,
      start: selected?.span.start ?? 0,
      end: selected?.span.end ?? 0,
      originId: origin,
    };
  };
  const local = new CoreShadowRegistry().withLocal({
    binding: macro.binding,
    definition: module.definitions.find(
      ({ definition }) => definition.kind === "syntax",
    )!.definition,
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
  const expansionStore = new ExpansionEnvironmentStore();
  const expansionEnvironment = expansionStore.extendBinding(
    expansionStore.createRoot(),
    macro.binding,
  );
  const dispatch = resolveCoreDispatch({
    environments: expansionStore,
    environment: expansionEnvironment,
    shadows: imported.registry,
    spelling: "function",
    category: "item",
    phase,
    origin: macro.binding.declaration,
    diagnosticOrigin,
  });
  if (dispatch.kind !== "shadow-macro")
    throw new Error("function core interception was not authorized");
  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const type = createTypeConsumer(shared);
  const item = createItemConsumer(shared);
  const consumers = new Map<SyntaxClassId, SyntaxConsumer>([
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
        classId === module.classId("binding")
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

  const expand = (source: string) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(
        scopes.freshScope("lexical", "currying-callsite"),
      ),
      originStore: origins,
    });
    return expandMacroSyntax({
      module,
      syntax: withoutEof(invocation.root.children),
      category: "item",
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
        const result = item.consume(
          createSyntaxCursor(syntax),
          context("item"),
        );
        if (!result.matched || !result.cursor.atEnd)
          throw new TypeError(
            `expanded currying syntax is not one item sequence: ${printLosslessSequence(syntax)}`,
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
  return { expand, environments, scopes };
}

const declaration = `export function add(
  left: number,
  right: number,
): number {
  return left + right;
}`;

describe("currying acceptance", () => {
  test("dispatches past export and emits the exact overload item sequence", () => {
    const result = createHarness().expand(declaration);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      compact(expectedDeclarations()),
    );
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.coreInterception).toMatchObject({
      decision: "shadow-macro",
      selected: 130_000,
    });
    expect(
      result.traces[0]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["add", "left", "right"]);
  });

  test("reports the exact two-parameter diagnostic", () => {
    const result = createHarness().expand(
      "export function add(value: number): number { return value; }",
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
        readFileSync(
          "fixtures/acceptance/playground/currying/expected.malformed.diagnostics.json",
          "utf8",
        ),
      ),
    );
  });

  test("assigns a distinct printed parameter name at a colliding call site", () => {
    const { expand, environments, scopes } = createHarness();
    const result = expand(declaration);
    const introducedIds = new Set(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ binding }) => binding),
      ),
    );
    const bindings = ["add", "left", "right"].flatMap((spelling) =>
      environments
        .candidates(result.environment, {
          spelling,
          phase,
          space: "value",
          position: Number.MAX_SAFE_INTEGER,
        })
        .filter(({ id }) => introducedIds.has(id)),
    );
    const plan = createHygienicNamePlan({
      syntax: result.syntax,
      bindings,
      environments,
      environment: result.environment,
      scopes,
      phase,
      unavailableNames: ["right"],
    });
    expect([...plan.names.values()]).toContain("right_1");
    expect(printWithAssignedNames(result.syntax[0]!, plan)).toContain(
      "right_1",
    );
  });

  test("emits valid overloads and supports direct and curried runtime calls", () => {
    const result = createHarness().expand(declaration);
    const source = `${printLosslessSequence(result.syntax)}\nconst result = [add(2, 3), add(2)(3)];`;
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
    ).toEqual([5, 5]);
  });
});
