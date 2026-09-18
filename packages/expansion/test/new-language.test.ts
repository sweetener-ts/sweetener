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
import {
  createPhase,
  EnvironmentStore,
  resolveBinding,
  ScopeStore,
} from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import {
  createSyntaxClassConsumer,
  type SyntaxClassConsumer,
} from "@sweetener/pattern";
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
import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import {
  compileParsedMacros,
  createMacroExtentResolver,
  expandMacroSyntax,
  ExpansionEnvironmentStore,
  ExpansionGuard,
  invokeMacro,
  processDefinitionContext,
} from "../src/index.js";

const fixture = "fixtures/acceptance/playground/new-language";
const sourceId = 810 as SourceId;
const invocationSource = 811 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function compact(value: string | readonly Syntax[]) {
  return (typeof value === "string" ? value : printLosslessSequence(value))
    .replace(/\s+/gu, "")
    .replace(/,\)/gu, ")");
}

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/new-language.generated.ts";
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
    scopes.freshScope("lexical", "new-language-definition"),
  );
  const read = readSyntax(readFileSync(`${fixture}/declarative.sts`, "utf8"), {
    sourceId,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(read.root, { sourceId });
  const syntaxIds = createIdAllocator<SyntaxId>(190_000);
  const bindingIds = createIdAllocator<BindingId>(190_000);
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

  const expansionStore = new ExpansionEnvironmentStore();
  const expansionEnvironment = processDefinitionContext({
    store: expansionStore,
    environment: expansionStore.createRoot(),
    items: module.definitions.map(({ definition, macro, operator }) => ({
      kind: "macro-definition" as const,
      definition,
      binding: macro.binding,
      operator,
    })),
    validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
  }).environment;
  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const shared = { origins, allocateSyntaxId: syntaxIds.allocate };
  const expression = createPrattExpressionConsumer(shared);
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const type = createTypeConsumer(shared);
  const activeClassConsumer: { current?: SyntaxClassConsumer } = {};
  const item = createItemConsumer({
    ...shared,
    resolveMacro: createMacroExtentResolver({
      resolve: (spelling, category) => module.get(spelling, category),
      consumeClass: () => {
        if (activeClassConsumer.current === undefined)
          throw new Error("syntax-class consumer is not initialized");
        return activeClassConsumer.current;
      },
      origins,
      allocateSyntaxId: syntaxIds.allocate,
    }),
  });
  const consumers = new Map<SyntaxClassId, SyntaxConsumer>([
    [module.classId("expr")!, expression],
    [module.classId("binding")!, binding],
    [module.classId("stmt")!, statement],
    [module.classId("type")!, type],
    [module.classId("item")!, item],
  ]);
  const context = (category: ConsumerContext["category"]): ConsumerContext => ({
    category,
    phase,
    environmentEpoch: expansionEnvironment.epoch as EnvironmentEpoch,
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
    environmentEpoch: expansionEnvironment.epoch,
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
              : classId === module.classId("type")
                ? "type"
                : "item";
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
  activeClassConsumer.current = consumeClass;
  const environments = new EnvironmentStore();
  const rootEnvironment = environments.createRoot();
  const expandItem = (source: string, environment = rootEnvironment) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(
        scopes.freshScope("lexical", "new-language-call"),
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
        const cursor = createSyntaxCursor(syntax);
        const items: Syntax[] = [];
        while (!cursor.atEnd) {
          const start = cursor.index;
          const result = item.consume(cursor, context("item"));
          if (!result.matched || result.cursor.index === start)
            throw new TypeError(
              `expanded new-language syntax contains an invalid item: ${printLosslessSequence(syntax)}`,
            );
          items.push(result.syntax);
        }
        return createProtectedSyntax({
          id: syntaxIds.allocate(),
          span: spanEnvelope(syntax.map(({ span }) => span)),
          origin: origins.composed(syntax.map(({ origin }) => origin)),
          scopes: syntax[0]!.scopes,
          category: "item",
          children: createSyntaxSequence(items),
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
  const expandDispatch = (source: string, environment = rootEnvironment) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "dispatch-call")),
      originStore: origins,
    });
    return invokeMacro({
      macro: module.get("::", "expr")!,
      cursor: createSyntaxCursor(withoutEof(invocation.root.children)),
      category: "expr",
      phase,
      environmentEpoch: environment.epoch,
      consumeClass,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: ({ cursor }) => cursor.atEnd,
      expandReplacement: ({ syntax, category }) =>
        createProtectedSyntax({
          id: syntaxIds.allocate(),
          span: spanEnvelope(syntax.map(({ span }) => span)),
          origin: origins.composed(syntax.map(({ origin }) => origin)),
          scopes: syntax[0]!.scopes,
          category,
          children: syntax,
        }),
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
  const expandType = (source: string, environment = rootEnvironment) => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "type-call")),
      originStore: origins,
    });
    return invokeMacro({
      macro: module.get("optional", "type")!,
      cursor: createSyntaxCursor(withoutEof(invocation.root.children)),
      category: "type",
      phase,
      environmentEpoch: environment.epoch,
      consumeClass,
      scopeStore: scopes,
      origins,
      environments,
      environment,
      tracker,
      guard,
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      admit: ({ cursor }) => cursor.atEnd,
      expandReplacement: ({ syntax, category }) =>
        createProtectedSyntax({
          id: syntaxIds.allocate(),
          span: spanEnvelope(syntax.map(({ span }) => span)),
          origin: origins.composed(syntax.map(({ origin }) => origin)),
          scopes: syntax[0]!.scopes,
          category,
          children: syntax,
        }),
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
  return {
    module,
    expandItem,
    expandDispatch,
    expandType,
    environments,
    scopes,
  };
}

describe("combined new-language acceptance", () => {
  test("compiles every cooperating declarative definition", () => {
    const { module } = createHarness();
    expect(module.macros.map(({ binding }) => binding.spelling)).toEqual([
      "module",
      "record",
      "extend",
      "optional",
      "::",
    ]);
    expect(module.operators).toMatchObject([
      { spelling: "::", category: "expr", fixity: "infix" },
    ]);
  });

  test("expands a declarative macro in TypeScript type position", () => {
    const result = createHarness().expandType("optional<Array<number>>");
    expect(result.expanded).toBe(true);
    if (!result.expanded) return;
    expect(compact(result.syntax.children)).toBe("Array<number>|undefined");
    expect(
      semanticDiagnostics(
        `const values: ${printLosslessSequence(result.syntax.children)} = [1];`,
      ),
    ).toEqual([]);
  });

  test("uses the type macro's declared diagnostic for malformed input", () => {
    const result = createHarness().expandType("optional<>");
    expect(result.expanded).toBe(false);
    if (result.expanded) return;
    expect({
      code: result.diagnostic.code,
      stage: result.diagnostic.stage,
      severity: result.diagnostic.severity,
      messageArguments: result.diagnostic.messageArguments,
    }).toEqual({
      code: "SWR4001",
      stage: "expansion",
      severity: "error",
      messageArguments: ["optional", "type inside optional angle brackets"],
    });
  });

  test("recursively expands records nested inside a module item", () => {
    const harness = createHarness();
    const result = harness.expandItem(`module List {
      record Empty();
      record Cons(head: number, tail: Empty | Cons);
    }`);
    expect(result.diagnostics).toEqual([]);
    expect(compact(result.syntax)).toBe(
      compact(`namespace List {
        export class Empty {}
        export class Cons {
          head: number;
          tail: Empty | Cons;
          constructor(head: number, tail: Empty | Cons) {
            this.head = head;
            this.tail = tail;
          }
        }
      }`),
    );
    expect(result.traces.map(({ binding }) => binding)).toHaveLength(3);

    const extension = harness.expandItem(
      `extend List.Cons {
        last(self: List.Cons): number {
          return self.tail instanceof List.Empty ? self.head : last(self.tail);
        }
      }`,
      result.environment,
    );
    expect(extension.diagnostics).toEqual([]);
    expect(compact(extension.syntax)).toBe(
      compact(`function last(self: List.Cons): number {
        return self.tail instanceof List.Empty ? self.head : last(self.tail);
      }`),
    );
    expect(extension.traces).toHaveLength(1);
  });

  test("applies declaration scopes to syntax following an item macro", () => {
    const harness = createHarness();
    const source = "record Entry(); record Container(value: Entry);";
    const result = harness.expandItem(source);
    expect(result.diagnostics).toEqual([]);
    const followingStart = source.indexOf("record Container");
    const pending = [...result.syntax].reverse();
    const references = [];
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node.tag === "token") {
        if (node.raw === "Entry" && node.span.start >= followingStart)
          references.push(node);
      } else pending.push(...[...node.children].reverse());
    }
    expect(references).toHaveLength(2);
    expect(
      references.every(
        (reference) =>
          resolveBinding(
            harness.environments,
            result.environment,
            harness.scopes,
            {
              spelling: "Entry",
              scopes: reference.scopes,
              phase,
              space: "type",
              position: reference.span.start,
            },
          ).kind === "resolved",
      ),
    ).toBe(true);
  });

  test("type-checks and executes the complete composed language fragment", () => {
    const harness = createHarness();
    const records = harness.expandItem(`module List {
      record Empty();
      record Cons(head: number, tail: Empty | Cons);
    }`);
    const extension = harness.expandItem(
      `extend List.Cons {
        last(self: List.Cons): number {
          return self.tail instanceof List.Empty ? self.head : last(self.tail);
        }
      }`,
      records.environment,
    );
    const dispatch = harness.expandDispatch(
      "last() :: list",
      extension.environment,
    );
    expect(dispatch.expanded).toBe(true);
    if (!dispatch.expanded) return;
    const optional = harness.expandType("optional<List.Cons>");
    expect(optional.expanded).toBe(true);
    if (!optional.expanded) return;
    expect(compact(dispatch.syntax.children)).toBe("last(list)");
    const source = `${printLosslessSequence(records.syntax)}
      ${printLosslessSequence(extension.syntax)}
      const list: ${printLosslessSequence(optional.syntax.children)} = new List.Cons(1, new List.Cons(3, new List.Empty()));
      const result = ${printLosslessSequence(dispatch.syntax.children)};`;
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

  test("reports the nested record's exact malformed-field diagnostic", () => {
    const result = createHarness().expandItem(`module List {
      record Cons(head:, tail: Cons);
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
        readFileSync(`${fixture}/expected.malformed.diagnostics.json`, "utf8"),
      ),
    );
  });

  test("keeps the extension receiver hygienic against outer names", () => {
    const harness = createHarness();
    const result = harness.expandItem(`extend List.Cons {
      last(self: List.Cons): number {
        return self.head;
      }
    }`);
    expect(result.diagnostics).toEqual([]);
    const bindings = result.traces.flatMap(({ bindingsIntroduced }) =>
      bindingsIntroduced.flatMap((introduced) =>
        introduced.spelling === "self"
          ? harness.environments
              .candidates(result.environment, {
                spelling: "self",
                phase,
                space: "value",
                position: Number.MAX_SAFE_INTEGER,
              })
              .filter(({ id }) => id === introduced.binding)
          : [],
      ),
    );
    const plan = createHygienicNamePlan({
      syntax: result.syntax,
      bindings,
      environments: harness.environments,
      environment: result.environment,
      scopes: harness.scopes,
      phase,
      unavailableNames: ["self", "body"],
    });
    expect([...plan.names.values()]).toContain("self_1");
    expect(printWithAssignedNames(result.syntax[0]!, plan)).toContain("self_1");
  });
});
