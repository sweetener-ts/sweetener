import {
  createPrattExpressionConsumer,
  StopSet,
  type SyntaxConsumer,
} from "@sweetener/enforestation";
import { createPhase, EnvironmentStore, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { createSyntaxClassConsumer } from "@sweetener/pattern";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  neverCancelled,
  ResourceTracker,
  type BindingId,
  type InvocationId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  OriginStore,
  spanEnvelope,
  type ProtectedSyntax,
  type Syntax,
} from "@sweetener/syntax";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  CoreShadowRegistry,
  createLexicalOperatorResolver,
  ExpansionEnvironmentStore,
  ExpansionGuard,
  invokeMacro,
  operatorInvocationSyntax,
  processDefinitionContext,
  registerImportedOperator,
  type MacroTraceEvent,
  type OperatorGroupingTrace,
} from "../src/index.js";

const sourceId = 96 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(source: string): string {
  return source.replace(/\s+/gu, "").replace(/,\)/gu, ")");
}

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/operators.generated.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.CommonJS,
  };
  const host = ts.createCompilerHost(options);
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    options.target!,
    true,
    ts.ScriptKind.TS,
  );
  const original = host.getSourceFile.bind(host);
  host.fileExists = (requested) =>
    requested === fileName || ts.sys.fileExists(requested);
  host.readFile = (requested) =>
    requested === fileName ? source : ts.sys.readFile(requested);
  host.getSourceFile = (requested, version, onError, fresh) =>
    requested === fileName
      ? sourceFile
      : original(requested, version, onError, fresh);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    );
}

function createOperatorHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "operator-definition"),
  );
  const definitionSource = readFileSync(
    "fixtures/acceptance/playground/operators/declarative.sts",
    "utf8",
  );
  const parsed = parseMacroDefinitions(
    readSyntax(definitionSource, {
      sourceId,
      scopes: definitionScopes,
      originStore: origins,
    }).root,
    { sourceId },
  );
  const syntaxIds = createIdAllocator<SyntaxId>(80_000);
  const bindingIds = createIdAllocator<BindingId>(80_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const module = compileParsedMacros(parsed, {
    sourceId,
    phase,
    definitionScopes,
    allocateBindingId: bindingIds.allocate,
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(module.diagnostics).toEqual([]);
  const expansionStore = new ExpansionEnvironmentStore();
  const expansionEnvironment = processDefinitionContext({
    store: expansionStore,
    environment: expansionStore.createRoot(),
    items: Object.freeze(
      module.definitions.map(({ definition, macro, operator }) =>
        Object.freeze({
          kind: "macro-definition" as const,
          definition,
          binding: macro.binding,
          operator,
        }),
      ),
    ),
    validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
  }).environment;
  let coreShadows = new CoreShadowRegistry();
  for (const { definition, macro } of module.definitions) {
    coreShadows = coreShadows.withLocal({
      binding: macro.binding,
      definition,
      diagnosticOrigin: (origin) => {
        const selected = origins.selectPrimarySource(origin)!;
        return {
          sourceId: selected.sourceId,
          start: selected.span.start,
          end: selected.span.end,
          originId: origin,
        };
      },
    }).registry;
  }
  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const hygieneEnvironments = new EnvironmentStore();
  let hygieneEnvironment = hygieneEnvironments.createRoot();
  const traces: MacroTraceEvent[] = [];
  const groups: OperatorGroupingTrace[] = [];
  const diagnostics: unknown[] = [];
  const context = {
    category: "expr" as const,
    phase,
    environmentEpoch: expansionEnvironment.epoch,
    stopSet: StopSet.empty,
    tracker,
    cancellation: neverCancelled,
    allowYield: false,
    allowAwait: false,
  };
  const expression: { current: SyntaxConsumer | undefined } = {
    current: undefined,
  };
  const token = module.classId("token")!;
  const tt = module.classId("tt")!;
  const ident = module.classId("ident")!;
  const expr = module.classId("expr")!;
  const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
    builtins: { token, tt, ident },
    externalConsumer: (classId, cursor) => {
      if (classId !== expr) return undefined;
      const protectedInput = cursor.peek();
      if (
        protectedInput?.tag === "protected" &&
        protectedInput.category === "expr"
      ) {
        cursor.advance();
        return {
          cursor,
          syntax: createSyntaxSequence([protectedInput]),
          origin: protectedInput.origin,
        };
      }
      const start = cursor.index;
      const attempted = expression.current?.consume(cursor, context);
      if (attempted === undefined) return undefined;
      if (!attempted.matched) return undefined;
      const syntax = cursor
        .remainingRange()
        .sequence.slice(start, attempted.cursor.index);
      return {
        cursor: attempted.cursor,
        syntax: createSyntaxSequence(syntax),
        origin: syntax[0]!.origin,
      };
    },
  });
  const protect = (syntax: readonly Syntax[]): ProtectedSyntax =>
    createProtectedSyntax({
      id: syntaxIds.allocate(),
      span: spanEnvelope(syntax.map(({ span }) => span)),
      origin:
        syntax.length === 1
          ? syntax[0]!.origin
          : origins.composed(syntax.map(({ origin }) => origin)),
      scopes: syntax[0]!.scopes,
      category: "expr",
      children: syntax,
    });
  const resolver = createLexicalOperatorResolver({
    module,
    store: expansionStore,
    environment: expansionEnvironment,
    phase,
    category: "expr",
    shadowsCore: ({ binding }) => coreShadows.get(binding)?.authorized === true,
    onGroup: (trace) => groups.push(trace),
    expand: ({ macro, operator, input }) => {
      const invocationSyntax = operatorInvocationSyntax(input, operator.fixity);
      const result = invokeMacro({
        macro,
        cursor: createSyntaxCursor(invocationSyntax),
        category: "expr",
        phase,
        environmentEpoch: expansionEnvironment.epoch,
        consumeClass,
        scopeStore: scopes,
        origins,
        environments: hygieneEnvironments,
        environment: hygieneEnvironment,
        tracker,
        guard,
        allocateSyntaxId: syntaxIds.allocate,
        allocateBindingId: bindingIds.allocate,
        allocateInvocationId: invocationIds.allocate,
        position: 0,
        admit: () => true,
        diagnosticOrigin: (origin) => {
          const selected = origins.selectPrimarySource(origin)!;
          return {
            sourceId: selected.sourceId,
            start: selected.span.start,
            end: selected.span.end,
            originId: origin,
          };
        },
        expandReplacement: ({ syntax }) => protect(syntax),
      });
      traces.push(result.trace);
      if (!result.expanded) {
        diagnostics.push(result.diagnostic);
        throw result.diagnostic;
      }
      hygieneEnvironment = result.environment;
      return result.syntax;
    },
  });
  expression.current = createPrattExpressionConsumer({
    origins,
    allocateSyntaxId: syntaxIds.allocate,
    resolveMacroOperator: resolver,
  });

  const expand = (source: string) => {
    traces.length = 0;
    groups.length = 0;
    diagnostics.length = 0;
    const read = readSyntax(source, {
      sourceId,
      scopes: scopes.singleton(scopes.freshScope("lexical", "operator-call")),
      originStore: origins,
    });
    try {
      const result = expression.current!.consume(
        createSyntaxCursor(withoutEof(read.root.children)),
        context,
      );
      return {
        result,
        traces: [...traces],
        groups: [...groups],
        diagnostics: [...diagnostics],
      };
    } catch {
      return {
        result: undefined,
        traces: [...traces],
        groups: [...groups],
        diagnostics: [...diagnostics],
      };
    }
  };
  return { expand, module, expansionStore, expansionEnvironment, resolver };
}

describe("lexical custom operator dispatch", () => {
  test("composes prefix, infix, precedence, and authorized core interception", () => {
    const { expand } = createOperatorHarness();
    const expanded = expand("#[1, 2, 3] |> sum == 6");
    expect(expanded.diagnostics).toEqual([]);
    if (expanded.result === undefined || !expanded.result.matched)
      throw new Error("operator expression did not match");
    expect(expanded.result.cursor.atEnd).toBe(true);
    const expected = readFileSync(
      "fixtures/acceptance/playground/operators/expected.ts",
      "utf8",
    )
      .match(/globalThis\.Object\.is\([\s\S]*\);/)?.[0]
      .replace(/;$/u, "");
    expect(
      compact(printLosslessSequence(expanded.result.syntax.children)),
    ).toBe(compact(expected!));
    expect(expanded.traces.map(({ binding }) => binding)).toEqual([
      80_000, 80_001, 80_002,
    ]);
    expect(expanded.groups).toMatchObject([
      { spelling: "#", fixity: "prefix", precedence: 90 },
      { spelling: "|>", fixity: "infix", precedence: 40 },
      { spelling: "==", fixity: "infix", precedence: 30 },
    ]);
    expect(
      expanded.groups.every(
        ({ operatorOrigins, resultOrigin }) =>
          operatorOrigins.length > 0 && Number.isSafeInteger(resultOrigin),
      ),
    ).toBe(true);
  });

  test("retains declarative malformed-input diagnostics", () => {
    const { expand } = createOperatorHarness();
    const expanded = expand("#[1, , 3]");
    expect(expanded.diagnostics).toMatchObject([
      {
        code: "SWR4001",
        messageArguments: ["#", "expression after comma"],
      },
    ]);
  });

  test("preserves TypeScript inference and runtime behavior", () => {
    const { expand } = createOperatorHarness();
    const expanded = expand("#[1, 2, 3] |> sum == 6");
    if (expanded.result === undefined || !expanded.result.matched)
      throw new Error("operator expression did not match");
    const output = printLosslessSequence(expanded.result.syntax.children);
    const program = `
      const vector = <T>(...values: T[]): readonly T[] => values;
      const sum = (values: readonly number[]): number =>
        values.reduce((total, value) => total + value, 0);
      export const result = ${output};
      result satisfies boolean;
    `;
    expect(semanticDiagnostics(program)).toEqual([]);
    const transpiled = ts.transpileModule(program, {
      compilerOptions: {
        strict: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.CommonJS,
      },
    });
    const exports: Record<string, unknown> = {};
    runInNewContext(transpiled.outputText, { exports });
    const expected = JSON.parse(
      readFileSync(
        "fixtures/acceptance/playground/operators/expected.runtime.json",
        "utf8",
      ),
    ) as { readonly exports: Record<string, unknown> };
    expect(exports["result"]).toBe(expected.exports["result"]);
  });

  test("keeps the equality helper immune to a call-site Object binding", () => {
    const { expand } = createOperatorHarness();
    const expanded = expand("#[1, 2, 3] |> count == 3");
    if (expanded.result === undefined || !expanded.result.matched)
      throw new Error("operator hygiene expression did not match");
    const output = printLosslessSequence(expanded.result.syntax.children);
    expect(compact(output)).toBe(
      compact("globalThis.Object.is(count(vector(1, 2, 3)), 3)"),
    );
    const program = `
      const Object = "call-site Object";
      const vector = <T>(...values: T[]): readonly T[] => values;
      const count = (values: readonly unknown[]): number => values.length;
      export const hygieneResult = [Object, ${output}];
    `;
    expect(semanticDiagnostics(program)).toEqual([]);
    const runtimeProgram = `(() => {
      const Object = "call-site Object";
      const vector = (...values: unknown[]): readonly unknown[] => values;
      const count = (values: readonly unknown[]): number => values.length;
      return [Object, ${output}];
    })()`;
    const transpiled = ts.transpileModule(runtimeProgram, {
      compilerOptions: {
        strict: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.CommonJS,
      },
    });
    expect(runInNewContext(transpiled.outputText)).toEqual([
      "call-site Object",
      true,
    ]);
  });

  test("rejects nonassociative chains and hides operators outside their frame", () => {
    const { expand, module, expansionStore, resolver } =
      createOperatorHarness();
    const chained = expand("left == middle == right");
    expect(chained.result).toMatchObject({
      matched: false,
      failure: {
        expectations: expect.arrayContaining([
          expect.stringMatching(/nonassociative/u),
        ]),
      },
    });
    const root = expansionStore.createRoot();
    const hidden = createLexicalOperatorResolver({
      module,
      store: expansionStore,
      environment: root,
      phase,
      category: "expr",
      expand: () => {
        throw new Error("hidden operator expanded");
      },
    });
    const read = readSyntax("|>", { sourceId, scopes: 0 as never });
    expect(
      hidden(createSyntaxCursor(withoutEof(read.root.children)), "infix", {
        category: "expr",
      } as never),
    ).toBeUndefined();
    expect(resolver).toBeDefined();
  });

  test("reports imported fixity conflicts without mutating the lexical frame", () => {
    const { module, expansionStore } = createOperatorHarness();
    const root = expansionStore.createRoot();
    const first = registerImportedOperator({
      store: expansionStore,
      environment: root,
      operator: module.operators[1]!,
      importOrigin: module.operators[1]!.origin,
      diagnosticOrigin: (origin) => ({
        sourceId,
        start: Number(origin),
        end: Number(origin) + 1,
        originId: origin,
      }),
    });
    const conflicting = {
      ...module.operators[1]!,
      binding: (module.operators[1]!.binding + 100) as BindingId,
    };
    const second = registerImportedOperator({
      store: expansionStore,
      environment: first.environment,
      operator: conflicting,
      importOrigin: conflicting.origin,
      diagnosticOrigin: (origin) => ({
        sourceId,
        start: Number(origin),
        end: Number(origin) + 1,
        originId: origin,
      }),
    });
    expect(second.environment).toBe(first.environment);
    expect(second.diagnostics).toMatchObject([
      {
        code: "SWR4007",
        messageArguments: ["|>", "infix"],
        relatedOrigins: [{ message: "Existing lexical operator" }],
      },
    ]);
  });
});
