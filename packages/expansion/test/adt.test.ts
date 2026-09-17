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
} from "@sweetener/syntax";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  compileParsedMacros,
  expandMacroSyntax,
  ExpansionEnvironmentStore,
  ExpansionGuard,
} from "../src/index.js";

const fixture = "fixtures/acceptance/playground/adt";
const definitionSource = 770 as SourceId;
const invocationSource = 771 as SourceId;
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

function semanticDiagnostics(source: string): readonly string[] {
  const fileName = "/adt.generated.ts";
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
  return ts
    .getPreEmitDiagnostics(ts.createProgram([fileName], options, host))
    .map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    );
}

function createHarness(fixturePath = fixture) {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "adt-definition"),
  );
  const read = readSyntax(
    readFileSync(`${fixturePath}/declarative.sts`, "utf8"),
    {
      sourceId: definitionSource,
      scopes: definitionScopes,
      originStore: origins,
    },
  );
  const parsed = parseMacroDefinitions(read.root, {
    sourceId: definitionSource,
  });
  const syntaxIds = createIdAllocator<SyntaxId>(150_000);
  const bindingIds = createIdAllocator<BindingId>(150_000);
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
  const binding = createBindingConsumer(shared);
  const statement = createStatementConsumer(shared);
  const type = createTypeConsumer(shared);
  const item = createItemConsumer(shared);
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
  const expansionStore = new ExpansionEnvironmentStore();
  let expansionEnvironment = expansionStore.createRoot();
  for (const macro of module.macros)
    expansionEnvironment = expansionStore.extendBinding(
      expansionEnvironment,
      macro.binding,
    );

  const expand = (source: string, category: "expr" | "item") => {
    const invocation = readSyntax(source, {
      sourceId: invocationSource,
      scopes: scopes.singleton(scopes.freshScope("lexical", "adt-callsite")),
      originStore: origins,
    });
    return expandMacroSyntax({
      module,
      syntax: withoutEof(invocation.root.children),
      category,
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
        const consumer = category === "expr" ? expression : item;
        const result = consumer.consume(
          createSyntaxCursor(syntax),
          context(category),
        );
        if (!result.matched || !result.cursor.atEnd)
          throw new TypeError(
            `expanded ADT syntax is not ${category}: ${printLosslessSequence(syntax)}`,
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
  return { expand, environments, scopes, module };
}

describe("adt acceptance", () => {
  test("expands nested constructor dimensions and branch-local pattern bindings", () => {
    const harness = createHarness();
    const declaration = harness.expand(
      "data Option<T> = None() | Some(value: T);",
      "item",
    );
    expect(declaration.diagnostics).toEqual([]);
    const match = harness.expand(
      "match (Some(3)) { Some(value) => value + 1; None() => 0; }",
      "expr",
    );
    expect(match.diagnostics).toEqual([]);
    const source = `${printLosslessSequence(declaration.syntax)}\nconst result = ${printLosslessSequence(match.syntax)};`;
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
    expect(runInNewContext(`${transpiled.outputText}\nresult`)).toBe(4);
    expect(
      declaration.traces[0]?.operations.map(({ operation }) => operation),
    ).toEqual(["text", "text", "text", "text"]);
    expect(
      match.traces[0]?.bindingsIntroduced.map(({ spelling }) => spelling),
    ).toEqual(["value"]);
  });

  test("rejects a match that leaves a constructor unhandled", () => {
    const harness = createHarness();
    const declaration = harness.expand(
      "data Option<T> = None() | Some(value: T);",
      "item",
    );
    const expand = (arms: string) => {
      const match = harness.expand(`match (Some(3)) { ${arms} }`, "expr");
      expect(match.diagnostics).toEqual([]);
      return semanticDiagnostics(
        `${printLosslessSequence(declaration.syntax)}\nconst result = ${printLosslessSequence(match.syntax)};`,
      );
    };
    expect(expand("Some(value) => value + 1; None() => 0;")).toEqual([]);
    expect(expand("Some(value) => value + 1;")).toEqual([
      `Type '{ readonly tag: "None"; }' is not assignable to type 'never'.`,
    ]);
  });

  test("reports the declared malformed-field diagnostic", () => {
    const result = createHarness().expand(
      "data Option<T> = None() | Some(value:);",
      "item",
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

  test("assigns a distinct printed constructor field at a colliding call site", () => {
    const { expand, environments, scopes } = createHarness();
    const result = expand("data Option<T> = None() | Some(value: T);", "item");
    const introducedIds = new Set(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ binding }) => binding),
      ),
    );
    const bindings = ["Option", "T", "None", "Some", "value"].flatMap(
      (spelling) =>
        (["value", "type"] as const).flatMap((space) =>
          environments
            .candidates(result.environment, {
              spelling,
              phase,
              space,
              position: Number.MAX_SAFE_INTEGER,
            })
            .filter(({ id }) => introducedIds.has(id)),
        ),
    );
    const plan = createHygienicNamePlan({
      syntax: result.syntax,
      bindings,
      environments,
      environment: result.environment,
      scopes,
      phase,
      unavailableNames: ["value"],
    });
    expect([...plan.names.values()]).toContain("value_1");
    expect(printWithAssignedNames(result.syntax[0]!, plan)).toContain(
      "value_1",
    );
  });

  test("emits the intended TypeScript structures", () => {
    const declaration = createHarness().expand(
      "data Option<T> = None() | Some(value: T);",
      "item",
    );
    expect(compact(printLosslessSequence(declaration.syntax))).toContain(
      compact(
        'type Option<T> = { readonly tag: "None"; } | { readonly tag: "Some"; value: T; };',
      ),
    );
    expect(compact(printLosslessSequence(declaration.syntax))).toContain(
      compact(
        'const Some = <T>(value: T): Option<T> => ({ tag: "Some", value });',
      ),
    );
  });
});

const protocolFixture = "fixtures/acceptance/playground/protocols";

describe("protocol acceptance", () => {
  const protocol = `protocol Equal<T> {
    equals(left: T, right: T): boolean;
  }`;
  const implementation = `User implements Equal<User> {
    equals(left: User, right: User): boolean {
      return left.id === right.id;
    }
  }`;

  test("expands a protocol and its item-position infix implementation", () => {
    const harness = createHarness(protocolFixture);
    const declaration = harness.expand(protocol, "item");
    expect(declaration.diagnostics).toEqual([]);
    const registered = harness.expand(implementation, "item");
    expect(registered.diagnostics).toEqual([]);
    expect(declaration.traces.map(({ binding }) => binding)).toEqual([
      harness.module.get("protocol", "item")!.binding.id,
    ]);
    expect(registered.traces.map(({ binding }) => binding)).toEqual([
      harness.module.get("implements", "item")!.binding.id,
    ]);
    expect(
      declaration.traces[0]?.bindingsIntroduced.map(({ spelling, space }) => ({
        spelling,
        space,
      })),
    ).toEqual([
      { spelling: "Equal", space: "type" },
      { spelling: "Equal", space: "value" },
      { spelling: "T", space: "type" },
      { spelling: "left", space: "value" },
      { spelling: "right", space: "value" },
    ]);
    const source = `${printLosslessSequence(declaration.syntax)}
      class User { constructor(readonly id: number) {} }
      ${printLosslessSequence(registered.syntax)}
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

  test("keeps repeated method parameters correlated in declarations and implementations", () => {
    const harness = createHarness(protocolFixture);
    const declaration = harness.expand(protocol, "item");
    const registered = harness.expand(implementation, "item");
    const declarationText = compact(printLosslessSequence(declaration.syntax));
    const implementationText = compact(
      printLosslessSequence(registered.syntax),
    );
    expect(declarationText).toContain(
      compact("equals(left: T, right: T): boolean;"),
    );
    expect(declarationText).toContain(
      compact("return implementation.equals(left, right);"),
    );
    expect(implementationText).toContain(
      compact("Equal.register(User.prototype, {"),
    );
    expect(implementationText).toContain(
      compact("equals(left: User, right: User): boolean"),
    );
  });

  test("reports the declared missing-return-type diagnostic", () => {
    const result = createHarness(protocolFixture).expand(
      `protocol Equal<T> {
        equals(left: T, right: T) boolean;
      }`,
      "item",
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
          `${protocolFixture}/expected.malformed.diagnostics.json`,
          "utf8",
        ),
      ),
    );
  });

  test("hygienically renames colliding implementation parameters", () => {
    const { expand, environments, scopes } = createHarness(protocolFixture);
    const result = expand(implementation, "item");
    const introducedIds = new Set(
      result.traces.flatMap(({ bindingsIntroduced }) =>
        bindingsIntroduced.map(({ binding }) => binding),
      ),
    );
    const bindings = ["left", "right"].flatMap((spelling) =>
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
      unavailableNames: ["left"],
    });
    expect([...plan.names.values()]).toContain("left_1");
    expect(printWithAssignedNames(result.syntax[0]!, plan)).toContain("left_1");
  });
});
