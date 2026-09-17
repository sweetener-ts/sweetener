import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  createPrattExpressionConsumer,
  createStatementConsumer,
  StopSet,
  type ConsumerContext,
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
  expandMacroSyntax,
  ExpansionGuard,
} from "../src/index.js";

const definitionSource = 740 as SourceId;
const invocationSource = 741 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(syntax: readonly Syntax[]) {
  return printLosslessSequence(syntax)
    .replace(/\s+/gu, "")
    .replace(/,\)/gu, ")");
}

function tokens(syntax: readonly Syntax[]): Syntax[] {
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
    scopes.freshScope("lexical", "rewritten-if-definition"),
  );
  const read = readSyntax(
    readFileSync(
      "fixtures/acceptance/playground/rewritten-if/declarative.sts",
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
  const syntaxIds = createIdAllocator<SyntaxId>(120_000);
  const bindingIds = createIdAllocator<BindingId>(120_000);
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
  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const expression = createPrattExpressionConsumer(shared);
  const statement = createStatementConsumer(shared);
  const context = (category: "expr" | "stmt"): ConsumerContext => ({
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
      if (classId !== module.classId("expr")) return undefined;
      const start = cursor.index;
      const result = expression.consume(cursor, context("expr"));
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
    const callsiteScope = scopes.freshScope("lexical", "rewritten-if-callsite");
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(callsiteScope),
      originStore: origins,
    });
    const result = expandMacroSyntax({
      module,
      syntax: withoutEof(invocation.root.children),
      category: "stmt",
      consumeClass,
      phase,
      environmentEpoch: environment.epoch,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      enforest: ({ syntax }) => {
        const parsedStatement = statement.consume(
          createSyntaxCursor(syntax),
          context("stmt"),
        );
        if (!parsedStatement.matched || !parsedStatement.cursor.atEnd)
          throw new TypeError(
            `expanded syntax is not one statement: ${printLosslessSequence(syntax)}`,
          );
        return parsedStatement.syntax;
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
    return { result, callsiteScope, definitionScopes, scopes };
  };
  return { expand };
}

describe("rewritten-if acceptance", () => {
  test("rewrites the complete block structure to one return statement", () => {
    const { result } = createHarness().expand(
      "if (predicate) { return 3; } else { return 2; }",
    );
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe("returnIF(predicate,()=>3,()=>2)();");
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]?.bindingsIntroduced).toEqual([]);
  });

  test("retains the definition scope on IF despite a call-site collision", () => {
    const { result, callsiteScope, definitionScopes, scopes } =
      createHarness().expand("if (predicate) { return 3; } else { return 2; }");
    const reference = tokens(result.syntax).find(
      (node) => node.tag === "token" && node.raw === "IF",
    );
    expect(reference).toBeDefined();
    expect(
      reference === undefined
        ? false
        : scopes.subset(definitionScopes, reference.scopes),
    ).toBe(true);
    expect(
      reference === undefined
        ? true
        : scopes.has(reference.scopes, callsiteScope),
    ).toBe(false);
  });

  test("reports the exact missing else-return diagnostic", () => {
    const { result } = createHarness().expand(
      "if (predicate) { return 3; } else { 2; }",
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
          "fixtures/acceptance/playground/rewritten-if/expected.malformed.diagnostics.json",
          "utf8",
        ),
      ),
    );
  });

  test("emits TypeScript that executes the expected branch", () => {
    const { result } = createHarness().expand(
      "if (predicate) { return 3; } else { return 2; }",
    );
    const source = `
      const IF = <A>(predicate: boolean, yes: () => A, no: () => A) =>
        () => predicate ? yes() : no();
      function choose(predicate: boolean): number { ${printLosslessSequence(result.syntax)} }
      const result = choose(true);
      result satisfies number;
    `;
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
