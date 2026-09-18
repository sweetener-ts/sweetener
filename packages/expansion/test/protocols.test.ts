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
  expandMacroSyntax,
  ExpansionGuard,
} from "../src/index.js";

const fixture = "fixtures/acceptance/playground/protocols";
const definitionSource = 780 as SourceId;
const invocationSource = 781 as SourceId;
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
  return source.replace(/\s+/gu, "").replace(/,([)}])/gu, "$1");
}

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/protocol.generated.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, target, onError, shouldCreate) =>
    name === fileName
      ? ts.createSourceFile(name, source, target, true, ts.ScriptKind.TS)
      : original(name, target, onError, shouldCreate);
  host.readFile = (name) =>
    name === fileName ? source : ts.sys.readFile(name);
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  return ts
    .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );
}

function createHarness() {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "protocol-definition"),
  );
  const read = readSyntax(readFileSync(`${fixture}/declarative.sts`, "utf8"), {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(read.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(160_000);
  const bindingIds = createIdAllocator<BindingId>(160_000);
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
    { spelling: "implements", category: "item", fixity: "infix" },
  ]);

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
        scopes.freshScope("lexical", "protocol-callsite"),
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
      enforest: ({ syntax }) => {
        const result = item.consume(
          createSyntaxCursor(syntax),
          context("item"),
        );
        if (!result.matched || !result.cursor.atEnd)
          throw new TypeError(
            `expanded protocol syntax is not item output: ${printLosslessSequence(syntax)}`,
          );
        return result.syntax;
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
  return { expand };
}

const protocol = `protocol Equal<T> {
  equals(left: T, right: T): boolean;
}`;
const implementation = `User implements Equal<User> {
  equals(left: User, right: User): boolean {
    return left.id === right.id;
  }
}`;
const runtime = `function protocolRuntime<Shape extends object>() {
  const implementations = new WeakMap<object, Shape>();
  return {
    register(prototype: object, implementation: Shape): void {
      implementations.set(prototype, implementation);
    },
    equals<T extends object>(left: T, right: T): boolean {
      const found = implementations.get(Object.getPrototypeOf(left)) as
        { equals(left: T, right: T): boolean } | undefined;
      if (found === undefined) throw new Error("Missing Equal implementation");
      return found.equals(left, right);
    },
  };
}`;

describe("protocols acceptance", () => {
  test("generates correlated interface and runtime value bindings", () => {
    const result = createHarness().expand(protocol);
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toContain(
      compact("interface Equal<T> { equals(left: T, right: T): boolean; }"),
    );
    expect(compact(result.syntax)).toContain(compact("const Equal = (() => {"));
    expect(
      result.traces[0]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["Equal", "Equal", "T", "left", "right"]);
  });

  test("dispatches an infix item operator from the left operand boundary", () => {
    const result = createHarness().expand(implementation);
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toContain("Equal.register(User.prototype");
    expect(compact(result.syntax)).toContain(
      compact(
        "equals(left: User, right: User): boolean { return left.id === right.id; }",
      ),
    );
    expect(result.traces).toHaveLength(1);
    expect(
      result.traces[0]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["left", "right"]);
  });

  test("reports the exact malformed method diagnostic", () => {
    const result = createHarness().expand(
      "protocol Equal<T> { equals(left: T, right: T) boolean; }",
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

  test("emits strict TypeScript and executes registered dispatch", () => {
    const harness = createHarness();
    const declared = harness.expand(protocol);
    const implemented = harness.expand(implementation);
    const source = `${runtime}
      ${printLosslessSequence(declared.syntax)}
      class User { constructor(readonly id: number) {} }
      ${printLosslessSequence(implemented.syntax)}
      const result = Equal.equals(new User(1), new User(1));`;
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
