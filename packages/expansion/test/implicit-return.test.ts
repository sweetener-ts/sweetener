import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  createBindingConsumer,
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

const definitionSource = 730 as SourceId;
const invocationSource = 731 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(source: string) {
  return source
    .replace(/\s+/gu, "")
    .replace(/return\(([^;]+)\);/gu, "return$1;");
}

function expectedFunction(
  file: "expected.ts" | "expected.hygiene.ts",
  name: string,
) {
  const source = readFileSync(
    `fixtures/acceptance/playground/implicit-return/${file}`,
    "utf8",
  );
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap(({ declarationList }) => [...declarationList.declarations])
    .find(
      ({ name: binding }) => ts.isIdentifier(binding) && binding.text === name,
    );
  if (declaration?.initializer === undefined)
    throw new Error(`missing ${name}`);
  return declaration.initializer.getText(parsed);
}

function createHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "implicit-return-definition"),
  );
  const definitionRead = readSyntax(
    readFileSync(
      "fixtures/acceptance/playground/implicit-return/declarative.sts",
      "utf8",
    ),
    {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    },
  );
  const parsed = parseMacroDefinitions(definitionRead.root, {
    sourceId: definitionSource,
  });
  expect(parsed.definitions[0]?.rules).toHaveLength(2);
  const bindingIds = createIdAllocator<BindingId>(110_000);
  const syntaxIds = createIdAllocator<SyntaxId>(110_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const module = compileParsedMacros(parsed, {
    sourceId: definitionSource,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(definitionRead.diagnostics).toEqual([]);
  expect(module.diagnostics).toEqual([]);
  expect(
    module
      .get("function", "expr")
      ?.rules.map(({ contracts }) => contracts.length),
  ).toEqual([1]);
  const macro = module.get("function", "expr")!;
  const diagnosticOrigin = (origin: Parameters<OriginStore["get"]>[0]) => {
    const selected = origins.selectPrimarySource(origin);
    return {
      sourceId: selected?.sourceId ?? invocationSource,
      start: selected?.span.start ?? 0,
      end: selected?.span.end ?? 0,
      originId: origin,
    };
  };
  const localShadow = new CoreShadowRegistry().withLocal({
    binding: macro.binding,
    definition: module.definitions.find(
      ({ definition }) => definition.kind === "syntax",
    )!.definition,
    diagnosticOrigin,
  });
  const importedShadow = localShadow.registry.withImport({
    binding: macro.binding,
    exported: localShadow.metadata,
    importOrigin: macro.binding.declaration,
    shadowsCore: true,
    diagnosticOrigin,
  });
  expect([...localShadow.diagnostics, ...importedShadow.diagnostics]).toEqual(
    [],
  );
  const expansionStore = new ExpansionEnvironmentStore();
  const expansionEnvironment = expansionStore.extendBinding(
    expansionStore.createRoot(),
    macro.binding,
  );
  const dispatch = resolveCoreDispatch({
    environments: expansionStore,
    environment: expansionEnvironment,
    shadows: importedShadow.registry,
    spelling: "function",
    category: "expr",
    phase,
    origin: macro.binding.declaration,
    diagnosticOrigin,
  });
  if (dispatch.kind !== "shadow-macro")
    throw new Error("function core interception was not authorized");

  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const expression = createPrattExpressionConsumer(shared);
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const type = createTypeConsumer(shared);
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
      const attempt = consumer.consume(cursor, context(category));
      if (!attempt.matched) return undefined;
      const syntax = cursor
        .remainingRange()
        .sequence.slice(start, attempt.cursor.index);
      return {
        cursor: attempt.cursor,
        syntax: createSyntaxSequence(syntax),
        origin: syntax[0]!.origin,
      };
    },
  });
  const environments = new EnvironmentStore();
  const environment = environments.createRoot();

  const expand = (source: string) => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(
        scopes.freshScope("lexical", "implicit-return-callsite"),
      ),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    return expandMacroSyntax({
      module,
      syntax: withoutEof(read.root.children),
      category: "expr",
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
        const attempt = binding.consumeBinding(
          createSyntaxCursor(syntax),
          context("binding"),
        );
        return attempt.matched
          ? attempt.skeleton.names.map((name) => ({
              spelling: name.spelling,
              origin: name.origin,
              scopes: name.scopes,
            }))
          : [];
      },
      enforest: ({ syntax }) => {
        const attempt = expression.consume(
          createSyntaxCursor(syntax),
          context("expr"),
        );
        if (!attempt.matched || !attempt.cursor.atEnd)
          throw new TypeError(
            `expanded implicit-return syntax is not one expression: ${printLosslessSequence(syntax)}`,
          );
        return attempt.syntax;
      },
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: () => true,
      diagnosticOrigin,
    });
  };
  return { expand };
}

describe("implicit-return acceptance", () => {
  test("lowers a statement prefix and final expression through #core", () => {
    const result = createHarness().expand(`function(value: number) {
      const doubled = value * 2;
      doubled + 1
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      compact(expectedFunction("expected.ts", "calculate")),
    );
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.coreInterception).toMatchObject({
      decision: "shadow-macro",
      selected: 110_000,
    });
    expect(
      result.traces[0]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["value"]);
  });

  test("preserves an explicit final return without recursive core dispatch", () => {
    const result = createHarness().expand(`function(value: number) {
      const doubled = value * 2;
      return doubled + 1;
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      compact(expectedFunction("expected.ts", "calculate")),
    );
  });

  test("reports the exact missing-final-value diagnostic", () => {
    const result = createHarness().expand(`function(value: number) {
      const doubled = value * 2;
    }`);
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
          "fixtures/acceptance/playground/implicit-return/expected.malformed.diagnostics.json",
          "utf8",
        ),
      ),
    );
  });

  test("emits strict TypeScript and executes the expected result", () => {
    const result = createHarness().expand(`function(value: number) {
      const doubled = value * 2;
      doubled + 1
    }`);
    const source = `const calculate = ${printLosslessSequence(result.syntax)}; const result = calculate(3); result satisfies number;`;
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        strict: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.CommonJS,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
    expect(runInNewContext(`${transpiled.outputText}\nresult`)).toBe(7);
  });
});
