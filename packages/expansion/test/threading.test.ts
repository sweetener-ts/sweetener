import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  createPrattExpressionConsumer,
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

const definitionSource = 720 as SourceId;
const invocationSource = 721 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(source: string) {
  return source.replace(/\s+/gu, "").replace(/,\)/gu, ")");
}

function expectedInitializer(
  file: "expected.ts" | "expected.hygiene.ts",
  name: string,
) {
  const source = readFileSync(
    `fixtures/acceptance/playground/threading/${file}`,
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
    scopes.freshScope("lexical", "thread-definition"),
  );
  const definitionRead = readSyntax(
    readFileSync(
      "fixtures/acceptance/playground/threading/declarative.sts",
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
  const bindingIds = createIdAllocator<BindingId>(100_000);
  const syntaxIds = createIdAllocator<SyntaxId>(100_000);
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

  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const expression = createPrattExpressionConsumer({
    origins,
    allocateSyntaxId: syntaxIds.allocate,
  });
  const context: ConsumerContext = {
    category: "expr",
    phase,
    environmentEpoch: 0 as EnvironmentEpoch,
    stopSet: StopSet.empty,
    tracker,
    cancellation: guard.cancellation,
    allowYield: false,
  };
  const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
    builtins: {
      token: module.classId("token")!,
      tt: module.classId("tt")!,
      ident: module.classId("ident")!,
    },
    tracker,
    environmentEpoch: context.environmentEpoch,
    externalConsumer: (classId, cursor) => {
      if (classId !== module.classId("expr")) return undefined;
      const start = cursor.index;
      const attempt = expression.consume(cursor, context);
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

  return (source: string) => {
    const read = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "thread-callsite")),
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
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      enforest: ({ syntax }) => {
        const attempt = expression.consume(createSyntaxCursor(syntax), context);
        if (!attempt.matched || !attempt.cursor.atEnd)
          throw new TypeError(
            `expanded threading syntax is not one expression: ${printLosslessSequence(syntax)}`,
          );
        return attempt.syntax;
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
}

function semanticDiagnostics(source: string) {
  const fileName = "/thread.generated.ts";
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
  host.getSourceFile = (requested, languageVersion, onError, fresh) =>
    requested === fileName
      ? sourceFile
      : original(requested, languageVersion, onError, fresh);
  return ts.getPreEmitDiagnostics(ts.createProgram([fileName], options, host));
}

describe("threading acceptance", () => {
  test("recursively expands every call step to the exact expected initializer", () => {
    const result = createHarness()(`(->
      [1, 2, 3],
      map((value) => value + 1),
      filter((value) => value > 2),
    )`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      compact(expectedInitializer("expected.ts", "threadFirst")),
    );
    expect(result.traces).toHaveLength(2);
    expect(result.traces.map(({ parent }) => parent)).toEqual([undefined, 1]);
    expect(
      result.traces.flatMap(({ bindingsIntroduced }) => bindingsIntroduced),
    ).toEqual([]);
  });

  test("retains the exact declarative malformed-step diagnostic", () => {
    const result = createHarness()(
      "(-> [1, 2, 3], map((value) => value), , filter(Boolean))",
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
          "fixtures/acceptance/playground/threading/expected.malformed.diagnostics.json",
          "utf8",
        ),
      ),
    );
  });

  test("preserves call-site identifiers without introducing bindings", () => {
    const result = createHarness()("(-> 2, add(argument))");
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      compact(
        expectedInitializer("expected.hygiene.ts", "hygieneResult").match(
          /threaded:\s*([\s\S]*),\s*\}/u,
        )![1]!,
      ),
    );
    expect(
      result.traces.flatMap(({ bindingsIntroduced }) => bindingsIntroduced),
    ).toEqual([]);
  });

  test("passes strict TypeScript inference and produces the expected runtime export", () => {
    const first = createHarness()(`(->
      [1, 2, 3],
      map((value) => value + 1),
      filter((value) => value > 2),
    )`);
    const last = createHarness()(`(->>
      [1, 2, 3],
      mapLast((value) => value + 1),
      filterLast((value) => value > 2),
      append([5]),
    )`);
    expect(first.diagnostics).toEqual([]);
    expect(last.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(last.syntax))).toBe(
      compact(expectedInitializer("expected.ts", "threadLast")),
    );
    const firstExpression = printLosslessSequence(first.syntax);
    const lastExpression = printLosslessSequence(last.syntax);
    const source = `
      const map = <A, B>(values: readonly A[], fn: (value: A) => B): B[] => values.map(fn);
      const filter = <A>(values: readonly A[], predicate: (value: A) => boolean): A[] => values.filter(predicate);
      const mapLast = <A, B>(fn: (value: A) => B, values: readonly A[]): B[] => values.map(fn);
      const filterLast = <A>(predicate: (value: A) => boolean, values: readonly A[]): A[] => values.filter(predicate);
      const append = <A>(suffix: readonly A[], values: readonly A[]): A[] => [...values, ...suffix];
      export const threadFirst = ${firstExpression};
      export const threadLast = ${lastExpression};
      threadFirst satisfies number[];
      threadLast satisfies number[];
    `;
    expect(semanticDiagnostics(source)).toEqual([]);
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        strict: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.CommonJS,
      },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
    const exports: Record<string, unknown> = {};
    runInNewContext(transpiled.outputText, { exports });
    const expected = JSON.parse(
      readFileSync(
        "fixtures/acceptance/playground/threading/expected.runtime.json",
        "utf8",
      ),
    ) as { exports: Record<string, unknown> };
    expect(exports["threadFirst"]).toEqual(expected.exports["threadFirst"]);
    expect(exports["threadLast"]).toEqual(expected.exports["threadLast"]);
  });
});
