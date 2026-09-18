import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  createBindingConsumer,
  createPrattExpressionConsumer,
  createStatementConsumer,
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
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  OriginStore,
  spanEnvelope,
  type Syntax,
} from "@sweetener/syntax";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  expandMacroSyntax,
  ExpansionGuard,
} from "../src/index.js";

const fixture = "fixtures/acceptance/playground/csp";
const definitionSource = 790 as SourceId;
const invocationSource = 791 as SourceId;
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
  return source.replace(/\s+/gu, "");
}

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/csp.generated.ts";
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
    scopes.freshScope("lexical", "csp-definition"),
  );
  const read = readSyntax(readFileSync(`${fixture}/declarative.sts`, "utf8"), {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(read.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(170_000);
  const bindingIds = createIdAllocator<BindingId>(170_000);
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
  expect(module.operators).toMatchObject([
    { spelling: "->", category: "stmt", fixity: "infix" },
    { spelling: "<-", category: "stmt", fixity: "infix" },
  ]);
  expect(
    module.macros.every(
      ({ rules }) => rules[0]?.requiredContexts[0] === "generator",
    ),
  ).toBe(true);

  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const expression = createPrattExpressionConsumer(shared);
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const consumers = new Map<SyntaxClassId, SyntaxConsumer>([
    [module.classId("expr")!, expression],
    [module.classId("binding")!, binding],
    [module.classId("stmt")!, statement],
  ]);
  const context = (
    category: ConsumerContext["category"],
    generator = true,
  ): ConsumerContext => ({
    category,
    phase,
    environmentEpoch: 0 as EnvironmentEpoch,
    stopSet: StopSet.empty,
    tracker,
    cancellation: guard.cancellation,
    allowYield: generator,
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
    externalConsumer: (classId, cursor, boundary) => {
      const consumer = consumers.get(classId);
      if (consumer === undefined) return undefined;
      const category =
        classId === module.classId("expr")
          ? "expr"
          : classId === module.classId("binding")
            ? "binding"
            : "stmt";
      const start = cursor.index;
      const baseContext = context(category);
      const result = consumer.consume(cursor, {
        ...baseContext,
        stopSet: baseContext.stopSet.union(
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
  const environment = environments.createRoot();

  const expand = (source: string, generator = true) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "csp-callsite")),
      originStore: origins,
    });
    return expandMacroSyntax({
      module,
      syntax: withoutEof(invocation.root.children),
      category: "stmt",
      contexts: generator ? new Set(["generator" as const]) : new Set(),
      consumeClass,
      phase,
      environmentEpoch: environment.epoch,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      extractBindings: (syntax) => {
        const result = binding.consumeBinding(
          createSyntaxCursor(syntax),
          context("binding", generator),
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
        const cursor = createSyntaxCursor(syntax);
        while (!cursor.atEnd) {
          const result = statement.consume(cursor, context("stmt", generator));
          if (!result.matched) break;
          cursor.advance(result.cursor.index - cursor.index);
        }
        return createProtectedSyntax({
          id: syntaxIds.allocate(),
          span: spanEnvelope(syntax.map(({ span }) => span)),
          origin: syntax[0]!.origin,
          scopes: syntax[0]!.scopes,
          category: "stmt",
          children: syntax,
        });
      },
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: () => true,
      diagnosticOrigin: (origin) => {
        const selected = origins.selectPrimarySource(origin);
        return {
          sourceId: selected?.sourceId ?? invocationSource,
          start: selected?.span.start ?? 0,
          end: selected?.span.end ?? 0,
          originId: origin,
        };
      },
    });
  };
  return { expand, environments, scopes };
}

describe("csp acceptance", () => {
  test("dispatches both statement infix operators and scopes the received value", () => {
    const result = createHarness().expand(
      "2 -> table; received <- table; return received + 1;",
    );
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe(
      compact(
        "yield put(table, 2); const received = yield take(table); return received + 1;",
      ),
    );
    expect(result.traces).toHaveLength(2);
    expect(
      result.traces[1]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["received"]);
  });

  test("rejects yield-producing syntax outside a generator context", () => {
    const result = createHarness().expand("2 -> table;", false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SWR4001",
      messageArguments: ["->", "generator context"],
    });
    expect(result.traces[0]?.attemptedRules[0]?.status).toBe(
      "boundary-rejected",
    );
  });

  test("reports the exact missing-channel diagnostic", () => {
    const result = createHarness().expand("received <-;");
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

  test("renames a received binding that collides with an outer name", () => {
    const { expand, environments, scopes } = createHarness();
    const result = expand("received <- table;");
    const introduced = new Set(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ binding }) => binding),
      ),
    );
    const bindings = environments
      .candidates(result.environment, {
        spelling: "received",
        phase,
        space: "value",
        position: Number.MAX_SAFE_INTEGER,
      })
      .filter(({ id }) => introduced.has(id));
    const plan = createHygienicNamePlan({
      syntax: result.syntax,
      bindings,
      environments,
      environment: result.environment,
      scopes,
      phase,
      unavailableNames: ["received"],
    });
    expect([...plan.names.values()]).toContain("received_1");
    expect(printWithAssignedNames(result.syntax[0]!, plan)).toContain(
      "received_1",
    );
  });

  test("emits strict generator TypeScript and executes the exchange", () => {
    const expanded = createHarness().expand(
      "2 -> table; received <- table; return received + 1;",
    );
    const source = `type Effect =
      | { readonly kind: "put"; readonly value: number }
      | { readonly kind: "take" };
      const table = {};
      const put = (_channel: object, value: number): Effect => ({ kind: "put", value });
      const take = (_channel: object): Effect => ({ kind: "take" });
      function* exchange(): Generator<Effect, number, number> {
        ${printLosslessSequence(expanded.syntax)}
      }
      const iterator = exchange();
      iterator.next(); iterator.next(0);
      const final = iterator.next(2);
      if (!final.done) throw new Error("exchange did not finish");
      const result = final.value;`;
    expect(semanticDiagnostics(`${source}\nresult satisfies number;`)).toEqual(
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
    expect(runInNewContext(`${transpiled.outputText}\nresult`)).toBe(3);
  });
});
