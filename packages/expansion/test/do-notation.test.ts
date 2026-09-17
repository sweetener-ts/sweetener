import {
  createBindingConsumer,
  createPrattExpressionConsumer,
  StopSet,
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
  neverCancelled,
  ResourceTracker,
  type BindingId,
  type EnvironmentEpoch,
  type InvocationId,
  type SourceId,
  type SyntaxId,
  type SyntaxClassId,
} from "@sweetener/shared";
import {
  createSyntaxSequence,
  createSyntaxCursor,
  OriginStore,
  type Syntax,
} from "@sweetener/syntax";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  expandMacroSyntax,
  ExpansionGuard,
} from "../src/index.js";

const definitionSource = 94 as SourceId;
const invocationSource = 95 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (item) => item.tag !== "token" || item.kind !== "end-of-file",
    ),
  );
}

function createDoHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScope = scopes.freshScope("lexical", "do-definition");
  const definitionScopes = scopes.singleton(definitionScope);
  const source = readFileSync(
    "fixtures/acceptance/playground/do-notation/declarative.sts",
    "utf8",
  );
  const definitionRead = readSyntax(source, {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(definitionRead.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(20_000);
  const bindingIds = createIdAllocator<BindingId>(20_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const compiled = compileParsedMacros(parsed, {
    sourceId: definitionSource,
    phase,
    definitionScopes,
    allocateBindingId: () => bindingIds.allocate(),
    spanForOrigin: (origin) =>
      origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
  });
  expect(definitionRead.diagnostics).toEqual([]);
  expect(compiled.diagnostics).toEqual([]);

  const tracker = new ResourceTracker(createResourceBudget());
  const context = Object.freeze({
    category: "expr" as const,
    phase,
    environmentEpoch: 0 as EnvironmentEpoch,
    stopSet: StopSet.empty,
    tracker,
    cancellation: neverCancelled,
    allowYield: false,
  });
  const expression = createPrattExpressionConsumer({
    origins,
    allocateSyntaxId: () => syntaxIds.allocate(),
  });
  const binding = createBindingConsumer({
    origins,
    allocateSyntaxId: () => syntaxIds.allocate(),
  });
  const consumers = new Map<SyntaxClassId, SyntaxConsumer>();
  const exprId = compiled.classId("expr");
  const bindingId = compiled.classId("binding");
  if (exprId === undefined || bindingId === undefined)
    throw new Error("missing external syntax classes");
  consumers.set(exprId, expression);
  consumers.set(bindingId, binding);
  const token = compiled.classId("token");
  const tt = compiled.classId("tt");
  const ident = compiled.classId("ident");
  if (token === undefined || tt === undefined || ident === undefined)
    throw new Error("missing builtin syntax classes");
  const consumeClass = createSyntaxClassConsumer(compiled.syntaxClasses, {
    builtins: { token, tt, ident },
    externalConsumer: (classId, cursor) => {
      const consumer = consumers.get(classId);
      if (consumer === undefined) return undefined;
      const start = cursor.index;
      const attempted = consumer.consume(cursor, context);
      if (!attempted.matched) return undefined;
      const syntax = cursor
        .remainingRange()
        .sequence.slice(start, attempted.cursor.index);
      return Object.freeze({
        cursor: attempted.cursor,
        syntax: createSyntaxSequence(syntax),
        origin: syntax[0]!.origin,
      });
    },
  });
  const environments = new EnvironmentStore();
  const environment = environments.createRoot();
  const guard = new ExpansionGuard({ tracker });

  const expand = (sourceText: string) => {
    const invocationScope = scopes.freshScope("lexical", "do-callsite");
    const read = readSyntax(sourceText, {
      sourceId: invocationSource,
      scopes: scopes.singleton(invocationScope),
      originStore: origins,
    });
    expect(read.diagnostics).toEqual([]);
    return expandMacroSyntax({
      module: compiled,
      syntax: withoutEof(read.root.children),
      category: "expr",
      phase,
      environmentEpoch: 0 as EnvironmentEpoch,
      consumeClass,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      extractBindings: (syntax) => {
        const attempted = binding.consumeBinding(createSyntaxCursor(syntax), {
          ...context,
          category: "binding",
        });
        return attempted.matched
          ? attempted.skeleton.names.map((name) => ({
              spelling: name.spelling,
              origin: name.origin,
              scopes: name.scopes,
            }))
          : [];
      },
      enforest: ({ syntax, category }) => {
        if (category !== "expr")
          throw new TypeError(`unsupported test category ${category}`);
        const attempted = expression.consume(createSyntaxCursor(syntax), {
          ...context,
          category,
        });
        if (!attempted.matched || !attempted.cursor.atEnd) {
          throw new TypeError("expanded do syntax is not one expression");
        }
        return attempted.syntax;
      },
      allocateSyntaxId: () => syntaxIds.allocate(),
      allocateBindingId: () => bindingIds.allocate(),
      allocateInvocationId: () => invocationIds.allocate(),
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
  return { expand, scopes, environments };
}

function compact(source: string): string {
  return source.replace(/\s+/gu, "").replace(/,\)/gu, ")");
}

function expectedInitializer(
  file: "expected.ts" | "expected.hygiene.ts",
  variable: string,
  property?: string,
): string {
  const source = readFileSync(
    `fixtures/acceptance/playground/do-notation/${file}`,
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
    .find(({ name }) => ts.isIdentifier(name) && name.text === variable);
  if (declaration?.initializer === undefined)
    throw new Error(`missing ${variable} initializer in ${file}`);
  if (property === undefined) return declaration.initializer.getText(parsed);
  if (!ts.isObjectLiteralExpression(declaration.initializer))
    throw new Error(`${variable} is not an object literal`);
  const member = declaration.initializer.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ((ts.isIdentifier(candidate.name) && candidate.name.text === property) ||
        (ts.isStringLiteral(candidate.name) &&
          candidate.name.text === property)),
  );
  if (member === undefined) throw new Error(`missing ${property} in ${file}`);
  return member.initializer.getText(parsed);
}

function generatedProgram(expression: string): string {
  return `
    type Box<A> = { readonly value: A };
    const box = {
      of: <A>(value: A): Box<A> => ({ value }),
      flatMap: <A, B>(source: Box<A>, next: (value: A) => Box<B>): Box<B> =>
        next(source.value),
      all: <T extends readonly unknown[]>(sources: { readonly [K in keyof T]: Box<T[K]> }): Box<T> =>
        ({ value: sources.map(({ value }) => value) as unknown as T }),
    };
    export const result = ${expression};
    result satisfies Box<number>;
    const inferred: number = result.value;
    void inferred;
  `;
}

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/do.generated.ts";
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
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (requested) =>
    requested === fileName || ts.sys.fileExists(requested);
  host.readFile = (requested) =>
    requested === fileName ? source : ts.sys.readFile(requested);
  host.getSourceFile = (
    requested,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    requested === fileName
      ? sourceFile
      : originalGetSourceFile(
          requested,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );
  return ts
    .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    );
}

describe("do-notation vertical slice", () => {
  test("recursively expands sequential bindings and the final expression", () => {
    const { expand } = createDoHarness();
    const result = expand(`doSteps(box) {
      left <- box.of(2);
      right <- box.of(3);
      return left + right;
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      compact(expectedInitializer("expected.ts", "result")),
    );
    expect(result.traces).toHaveLength(3);
    expect(result.traces.map(({ parent }) => parent)).toEqual([
      undefined,
      1,
      2,
    ]);
    expect(
      result.traces.every(({ selectedRule }) => selectedRule !== undefined),
    ).toBe(true);
  });

  test("retains a structured no-match diagnostic for malformed bind clauses", () => {
    const { expand } = createDoHarness();
    const result = expand(`doSteps(box) {
      value <-;
      return value;
    }`);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["SWR4001"]);
    expect(result.diagnostics[0]?.messageArguments).toEqual([
      "doSteps",
      "expression after <-",
    ]);
    const expected = JSON.parse(
      readFileSync(
        "fixtures/acceptance/playground/do-notation/expected.malformed.diagnostics.json",
        "utf8",
      ),
    ) as readonly {
      readonly code: string;
      readonly stage: string;
      readonly severity: string;
      readonly messageArguments: readonly unknown[];
    }[];
    expect(
      result.diagnostics.map(({ code, stage, severity, messageArguments }) => ({
        code,
        stage,
        severity,
        messageArguments,
      })),
    ).toEqual(expected);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]!.selectedRule).toBeUndefined();
  });

  test("expands destructuring and records every introduced binding", () => {
    const { expand } = createDoHarness();
    const result = expand(`doSteps(box) {
      [left, right] <- box.of([2, 3] as const);
      return left + right;
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      "box.flatMap(box.of([2,3]asconst),([left,right])=>box.of(left+right))",
    );
    expect(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ spelling }) => spelling),
      ),
    ).toEqual(["left", "right"]);
    expect(
      new Set(
        result.traces.flatMap(({ bindingsIntroduced }) =>
          bindingsIntroduced.map(({ binding }) => binding),
        ),
      ).size,
    ).toBe(2);
  });

  test(
    "emits TypeScript with the expected inferred type and runtime value",
    { timeout: 30_000 },
    () => {
      const { expand } = createDoHarness();
      const result = expand(`doSteps(box) {
      left <- box.of(2);
      right <- box.of(3);
      return left + right;
    }`);
      const program = generatedProgram(printLosslessSequence(result.syntax));
      expect(semanticDiagnostics(program)).toEqual([]);

      const transpiled = ts.transpileModule(program, {
        compilerOptions: {
          strict: true,
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.CommonJS,
        },
        reportDiagnostics: true,
      });
      expect(
        transpiled.diagnostics?.map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, "\n"),
        ) ?? [],
      ).toEqual([]);
      const exports: Record<string, unknown> = {};
      runInNewContext(transpiled.outputText, { exports });
      const runtime = JSON.parse(
        readFileSync(
          "fixtures/acceptance/playground/do-notation/expected.runtime.json",
          "utf8",
        ),
      ) as { readonly exports: Record<string, unknown> };
      expect(exports["result"]).toEqual(runtime.exports["result"]);
    },
  );

  test("expands correlated BindAll captures with optional semicolons", () => {
    const { expand } = createDoHarness();
    const result = expand(`doSteps(box) {
      [left, right] <- [box.of(2), box.of(3)]
      return left + right;
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(printLosslessSequence(result.syntax))).toBe(
      "box.flatMap(box.all([box.of(2),box.of(3)]),([left,right])=>box.of(left+right))",
    );
    expect(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ spelling }) => spelling),
      ),
    ).toEqual(["left", "right"]);
    expect(
      semanticDiagnostics(
        generatedProgram(printLosslessSequence(result.syntax)),
      ),
    ).toEqual([]);
  });

  test("prints hygienically distinct names when call-site bindings collide", () => {
    const { expand, scopes, environments } = createDoHarness();
    const result = expand(`doSteps(box) {
      left <- box.of(4);
      source <- box.of(6);
      return left + source;
    }`);
    expect(result.diagnostics).toEqual([]);
    const introducedIds = new Set(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ binding }) => binding),
      ),
    );
    const introduced = ["left", "source"].flatMap((spelling) =>
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
      bindings: introduced,
      environments,
      environment: result.environment,
      scopes,
      phase,
      unavailableNames: ["left", "source"],
    });
    expect([...plan.names.values()]).toEqual(["left_1", "source_1"]);
    expect(compact(printWithAssignedNames(result.syntax[0]!, plan))).toBe(
      compact(
        expectedInitializer("expected.hygiene.ts", "hygieneResult", "nested"),
      ),
    );
  });
});
