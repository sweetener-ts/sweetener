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
  type SyntaxCategory,
} from "@sweetener/syntax";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  expandMacroSyntax,
  ExpansionEnvironmentStore,
  ExpansionGuard,
  type CompileParsedMacrosResult,
} from "../src/index.js";

const fixture = "fixtures/acceptance/playground/multi-part-methods";
const sourceId = 800 as SourceId;
const invocationSource = 801 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(value: string | readonly Syntax[]) {
  const source =
    typeof value === "string" ? value : printLosslessSequence(value);
  return source.replace(/\s+/gu, "").replace(/,\)/gu, ")");
}

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/multi-part.generated.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.CommonJS,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, target, onError, fresh) =>
    name === fileName
      ? ts.createSourceFile(name, source, target, true, ts.ScriptKind.TS)
      : original(name, target, onError, fresh);
  host.readFile = (name) =>
    name === fileName ? source : ts.sys.readFile(name);
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    );
}

function createHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "multi-part-method-definition"),
  );
  const read = readSyntax(readFileSync(`${fixture}/declarative.sts`, "utf8"), {
    sourceId,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(read.root, { sourceId });
  const syntaxIds = createIdAllocator<SyntaxId>(180_000);
  const bindingIds = createIdAllocator<BindingId>(180_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const module = compileParsedMacros(parsed, {
    sourceId,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(read.diagnostics).toEqual([]);
  expect(module.diagnostics).toEqual([]);

  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const expression = createPrattExpressionConsumer(shared);
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const type = createTypeConsumer(shared);
  const item = createItemConsumer(shared);
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
  const consumers = new Map<SyntaxClassId, SyntaxConsumer>([
    [module.classId("expr")!, expression],
    [module.classId("binding")!, binding],
    [module.classId("stmt")!, statement],
    [module.classId("type")!, type],
  ]);
  const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
    builtins: {
      token: module.classId("token")!,
      tt: module.classId("tt")!,
      ident: module.classId("ident")!,
    },
    tracker,
    environmentEpoch: 0,
    externalConsumer: (classId, cursor, boundary) => {
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
      const base = context(category);
      const start = cursor.index;
      const result = consumer.consume(cursor, {
        ...base,
        stopSet: base.stopSet.union(
          new StopSet(
            (boundary?.stopTokens ?? []).map((raw) => ({
              kind: "token" as const,
              raw,
            })),
          ),
        ),
      });
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
  const rootEnvironment = environments.createRoot();
  const expansionStore = new ExpansionEnvironmentStore();
  const rootExpansion = expansionStore.extendBinding(
    expansionStore.createRoot(),
    module.get("method", "item")!.binding,
  );
  const diagnosticOrigin = (origin: Parameters<OriginStore["get"]>[0]) => {
    const selected = origins.selectPrimarySource(origin);
    return {
      sourceId: selected?.sourceId ?? invocationSource,
      start: selected?.span.start ?? 0,
      end: selected?.span.end ?? 0,
      originId: origin,
    };
  };
  const expand = (
    activeModule: CompileParsedMacrosResult,
    source: string,
    category: SyntaxCategory,
    environment = rootEnvironment,
    expansionEnvironment = rootExpansion,
    generated = false,
  ) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(
        scopes.freshScope("lexical", "multi-part-callsite"),
      ),
      originStore: origins,
    });
    return expandMacroSyntax({
      module: activeModule,
      syntax: withoutEof(invocation.root.children),
      category,
      consumeClass,
      phase,
      environmentEpoch: environment.epoch,
      expansionStore,
      expansionEnvironment,
      generatedDefinitions: generated ? { sourceId } : undefined,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
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
      enforest: ({ syntax, category: outputCategory }) => {
        const consumer = outputCategory === "expr" ? expression : item;
        const result = consumer.consume(
          createSyntaxCursor(syntax),
          context(outputCategory),
        );
        if (!result.matched || !result.cursor.atEnd)
          throw new TypeError(
            `expanded multi-part syntax is not ${outputCategory}: ${printLosslessSequence(syntax)}`,
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
  const declare = (source: string) =>
    expand(module, source, "item", rootEnvironment, rootExpansion, true);
  return { declare, expand, environments, scopes };
}

const declaration = `method between(value: number)
  lower(minimum: number)
  upper(maximum: number): boolean {
    return value > minimum && value < maximum;
  }`;
const call = `between(3)
  lower(1)
  upper(5)`;

describe("multi-part method acceptance", () => {
  test("generates a method from a generalised request grammar", () => {
    const harness = createHarness();
    const declared = harness.declare(`method query {
      request {
        query($source:expr)
        $(Where($filter:expr))+
        $(OrderBy($ordering:expr) $(ThenBy($tiebreak:expr))*)?
        Select($projection:expr)
      }
      expect "a query ending in Select(...) or GroupBy(...)";
      => {
        ({
          source: $source,
          filters: [$($filter),*],
          projection: $projection,
        })
      }
      request {
        query($source:expr)
        $(Where($filter:expr))*
        GroupBy($projection:expr)
      }
      expect "a query ending in Select(...) or GroupBy(...)";
      => {
        ({
          source: $source,
          filters: [$($filter),*],
          projection: $projection,
        })
      }
    }`);
    expect(declared.diagnostics).toEqual([]);
    const generated = declared.generatedModules[0]!;

    const result = harness.expand(
      generated,
      `query(students)
        Where(isEnrolled)
        Where(isAdult)
        OrderBy(byGpa)
        ThenBy(byName)
        Select(toName)`,
      "expr",
      declared.environment,
      declared.expansionEnvironment!,
    );

    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe(
      compact(`({
        source: students,
        filters: [isEnrolled, isAdult],
        projection: toName,
      })`),
    );

    const zeroAndOptionalResult = harness.expand(
      generated,
      "query(students) GroupBy(byCourse)",
      "expr",
      result.environment,
      result.expansionEnvironment!,
    );
    expect(zeroAndOptionalResult.diagnostics).toEqual([]);
    expect(compact(zeroAndOptionalResult.syntax)).toBe(
      compact(`({ source: students, filters: [], projection: byCourse, })`),
    );
  });

  test("registers and invokes the generated newline-spanning syntax binding", () => {
    const harness = createHarness();
    const declared = harness.declare(declaration);
    expect(declared.diagnostics).toEqual([]);
    expect(declared.syntax).toEqual([]);
    expect(declared.generatedDefinitionTraces).toMatchObject([
      { accepted: true, registeredBindings: [180_001] },
    ]);
    const generated = declared.generatedModules[0]!;
    expect(generated.get("between", "expr")).toBeDefined();
    const result = harness.expand(
      generated,
      call,
      "expr",
      declared.environment,
      declared.expansionEnvironment!,
    );
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe(
      compact(
        "((value: number, minimum: number, maximum: number): boolean => { return value > minimum && value < maximum; })(3, 1, 5)",
      ),
    );
    expect(result.traces).toHaveLength(1);
  });

  test("reports the generated macro's exact missing-segment diagnostic", () => {
    const harness = createHarness();
    const declared = harness.declare(declaration);
    const result = harness.expand(
      declared.generatedModules[0]!,
      "between(3) lower(1)",
      "expr",
      declared.environment,
      declared.expansionEnvironment!,
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

  test("renames declaration parameters against colliding call-site names", () => {
    const harness = createHarness();
    const declared = harness.declare(declaration);
    const result = harness.expand(
      declared.generatedModules[0]!,
      call,
      "expr",
      declared.environment,
      declared.expansionEnvironment!,
    );
    const introduced = new Set(
      declared.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ binding }) => binding),
      ),
    );
    const bindings = ["value", "minimum", "maximum"].flatMap((spelling) =>
      harness.environments
        .candidates(declared.environment, {
          spelling,
          phase,
          space: "value",
          position: Number.MAX_SAFE_INTEGER,
        })
        .filter(({ id }) => introduced.has(id)),
    );
    const plan = createHygienicNamePlan({
      syntax: result.syntax,
      bindings,
      environments: harness.environments,
      environment: result.environment,
      scopes: harness.scopes,
      phase,
      unavailableNames: ["value", "minimum", "maximum"],
    });
    expect([...plan.names.values()]).toEqual(
      expect.arrayContaining(["value_1", "minimum_1", "maximum_1"]),
    );
    expect(printWithAssignedNames(result.syntax[0]!, plan)).toContain(
      "value_1",
    );
  });

  test("emits strict TypeScript and executes the generated call", () => {
    const harness = createHarness();
    const declared = harness.declare(declaration);
    const result = harness.expand(
      declared.generatedModules[0]!,
      call,
      "expr",
      declared.environment,
      declared.expansionEnvironment!,
    );
    const source = `const result = ${printLosslessSequence(result.syntax)};`;
    expect(semanticDiagnostics(`${source}\nresult satisfies boolean;`)).toEqual(
      [],
    );
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        strict: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.CommonJS,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
    expect(runInNewContext(`${transpiled.outputText}\nresult`)).toBe(true);
  });
});
