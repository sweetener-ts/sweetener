import {
  createPhase,
  definitionContextScope,
  EnvironmentStore,
  ScopeStore,
} from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { createSyntaxClassConsumer } from "@sweetener/pattern";
import { readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type InvocationId,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createSyntaxSequence,
  createProtectedSyntax,
  createSyntaxCursor,
  OriginStore,
  spanEnvelope,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  ExpansionEnvironmentStore,
  compileParsedMacros,
  ExpansionGuard,
  invokeMacro,
  processGeneratedDefinitions,
  resolveCompiledMacro,
  type ValidatePreparedDefinition,
} from "../src/index.js";

const sourceId = 601 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]) {
  return createSyntaxSequence(
    syntax.filter(
      (node) => node.tag !== "token" || node.kind !== "end-of-file",
    ),
  );
}

function setup(
  source: string,
  validation?:
    | ((store: ExpansionEnvironmentStore) => ValidatePreparedDefinition)
    | undefined,
) {
  const origins = new OriginStore();
  const scopes = new ScopeStore();
  const definitionScopes = scopes.singleton(
    scopes.freshScope("lexical", "generated-definition"),
  );
  const read = readSyntax(source, {
    sourceId,
    scopes: definitionScopes,
    originStore: origins,
  });
  expect(read.diagnostics).toEqual([]);
  const store = new ExpansionEnvironmentStore();
  const environment = store.createRoot();
  const syntaxIds = createIdAllocator<SyntaxId>(60_000);
  const bindingIds = createIdAllocator<BindingId>(60_000);
  const result = processGeneratedDefinitions({
    syntax: withoutEof(read.root.children),
    sourceId,
    phase,
    definitionScopes,
    origins,
    store,
    environment,
    allocateSyntaxId: syntaxIds.allocate,
    allocateBindingId: bindingIds.allocate,
    diagnosticOrigin: (origin) => {
      const selected = origins.selectPrimarySource(origin)!;
      return {
        sourceId: selected.sourceId,
        start: selected.span.start,
        end: selected.span.end,
        originId: origin,
      };
    },
    validate: validation?.(store),
  });
  return { result, store, environment };
}

describe("generated declarative definitions", () => {
  test("re-enters parsing, compilation, and source-ordered registration", () => {
    const { result, store, environment } = setup(`
      #syntax {
        rec syntax generated:expr {
          rule { generated($value:expr) } => { $value }
        }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.accepted).toBe(true);
    expect(result.environment).not.toBe(environment);
    expect(result.context?.steps).toMatchObject([
      { generated: true, registeredBinding: 60_000 },
    ]);
    expect(result.trace).toMatchObject({
      markerOrigin: expect.any(Number),
      bodyOrigin: expect.any(Number),
      definitionOrigins: [expect.any(Number)],
      registeredBindings: [60_000],
      environmentBefore: environment.epoch,
      environmentAfter: result.environment.epoch,
      accepted: true,
    });
    expect(
      store
        .lookupBindings(result.environment, {
          spelling: "generated",
          phase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([60_000]);
    expect(
      resolveCompiledMacro({
        module: result.compiled!,
        store,
        environment: result.environment,
        spelling: "generated",
        category: "expr",
        phase,
      }),
    ).toBe(result.compiled?.get("generated", "expr"));
  });

  test("rejects malformed generated definitions without leaking bindings", () => {
    const { result, store, environment } = setup(
      "#syntax { syntax broken syntax after:expr { rule { after } => { 1 } } }",
    );
    expect(result.accepted).toBe(false);
    expect(result.environment).toBe(environment);
    expect(result.trace).toMatchObject({
      accepted: false,
      registeredBindings: [],
      environmentBefore: environment.epoch,
      environmentAfter: environment.epoch,
    });
    expect(
      result.diagnostics.some(({ severity }) => severity === "error"),
    ).toBe(true);
    expect(
      store.lookupBindings(environment, {
        spelling: "after",
        phase,
        category: "expr",
      }),
    ).toEqual([]);
  });

  test("requires the explicit generated-definition marker", () => {
    const { result, environment } = setup(
      "syntax unmarked:expr { rule { unmarked } => { 1 } }",
    );
    expect(result.accepted).toBe(false);
    expect(result.environment).toBe(environment);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["SWR4005"]);
    expect(result.trace).toMatchObject({
      accepted: false,
      bodyOrigin: undefined,
      definitionOrigins: [],
      registeredBindings: [],
    });
  });

  test("registers accepted definitions in source order around a rejected one", () => {
    const rejection = parseMacroDefinitions(
      readSyntax("syntax", { sourceId, scopes: 0 as ScopeSetId }).root,
      { sourceId },
    ).diagnostics;
    const observations: { good: number[]; bad: number[] }[] = [];
    const { result, store } = setup(
      `#syntax {
        syntax good:expr { rule { good } => { 1 } }
        syntax bad:expr { rule { bad } => { 2 } }
        syntax after:expr { rule { after } => { good } }
      }`,
      (environmentStore) => (item, environment) => {
        if (item.binding.spelling === "bad")
          return Object.freeze({ diagnostics: rejection });
        if (item.binding.spelling === "after") {
          observations.push({
            good: environmentStore
              .lookupBindings(environment, {
                spelling: "good",
                phase,
                category: "expr",
              })
              .map(({ id }) => id),
            bad: environmentStore
              .lookupBindings(environment, {
                spelling: "bad",
                phase,
                category: "expr",
              })
              .map(({ id }) => id),
          });
        }
        return Object.freeze({ diagnostics: Object.freeze([]) });
      },
    );
    expect(result.accepted).toBe(false);
    expect(observations).toEqual([{ good: [60_000], bad: [] }]);
    expect(result.trace.registeredBindings).toEqual([60_000, 60_002]);
    expect(
      store
        .lookupBindings(result.environment, {
          spelling: "after",
          phase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([60_002]);
  });

  test("accepts a definition name spliced by hygienic template instantiation", () => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("lexical", "definition-emitter"),
    );
    const definitionRead = readSyntax(
      `syntax emit:item {
        rule { emit($name:ident) } => {
          #syntax {
            syntax $name:expr { rule { $name } => { 1 } }
          }
        }
      }`,
      { sourceId, scopes: definitionScopes, originStore: origins },
    );
    const parsed = parseMacroDefinitions(definitionRead.root, { sourceId });
    const syntaxIds = createIdAllocator<SyntaxId>(70_000);
    const bindingIds = createIdAllocator<BindingId>(70_000);
    const invocationIds = createIdAllocator<InvocationId>(70_000);
    const module = compileParsedMacros(parsed, {
      sourceId,
      phase,
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(module.diagnostics).toEqual([]);
    const token = module.classId("token")!;
    const tt = module.classId("tt")!;
    const ident = module.classId("ident")!;
    const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
      builtins: { token, tt, ident },
    });
    const invocation = readSyntax("emit(made)", {
      sourceId,
      scopes: scopes.singleton(scopes.freshScope("lexical", "emitter-call")),
      originStore: origins,
    });
    const tracker = new ResourceTracker(createResourceBudget());
    const guard = new ExpansionGuard({ tracker });
    const hygieneEnvironments = new EnvironmentStore();
    const expansionStore = new ExpansionEnvironmentStore();
    let generated: ReturnType<typeof processGeneratedDefinitions> | undefined;
    const diagnosticOrigin = (origin: Parameters<OriginStore["get"]>[0]) => {
      const selected = origins.selectPrimarySource(origin)!;
      return {
        sourceId: selected.sourceId,
        start: selected.span.start,
        end: selected.span.end,
        originId: origin,
      };
    };
    const result = invokeMacro({
      macro: module.get("emit", "item")!,
      cursor: createSyntaxCursor(withoutEof(invocation.root.children)),
      category: "item",
      phase,
      environmentEpoch: 0 as Parameters<
        typeof invokeMacro
      >[0]["environmentEpoch"],
      consumeClass,
      scopeStore: scopes,
      origins,
      environments: hygieneEnvironments,
      environment: hygieneEnvironments.createRoot(),
      tracker,
      guard,
      allocateSyntaxId: syntaxIds.allocate,
      allocateBindingId: bindingIds.allocate,
      allocateInvocationId: invocationIds.allocate,
      position: 0,
      followingScope: definitionContextScope(scopes),
      admit: () => true,
      diagnosticOrigin,
      expandReplacement: (request) => {
        generated = processGeneratedDefinitions({
          syntax: createSyntaxSequence(request.syntax),
          sourceId,
          phase,
          definitionScopes,
          origins,
          store: expansionStore,
          environment: expansionStore.createRoot(),
          allocateSyntaxId: syntaxIds.allocate,
          allocateBindingId: bindingIds.allocate,
          diagnosticOrigin,
        });
        return createProtectedSyntax({
          id: syntaxIds.allocate(),
          span: spanEnvelope(request.syntax.map(({ span }) => span)),
          origin: request.syntax[0]!.origin,
          scopes: request.syntax[0]!.scopes,
          category: "item",
          children: request.syntax,
        });
      },
    });
    expect(result.expanded).toBe(true);
    expect(generated?.diagnostics).toEqual([]);
    expect(generated?.accepted).toBe(true);
    expect(generated?.compiled?.get("made", "expr")).toBeDefined();
    expect(generated?.trace.registeredBindings).toEqual([70_001]);
    expect(generated?.trace.definitionOrigins).toHaveLength(1);
    const generatedOrigin = generated!.trace.definitionOrigins[0]!;
    expect(origins.get(generatedOrigin)?.kind).toBe("introduced");
    expect(origins.collectSourceOrigins(generatedOrigin)).toHaveLength(2);
  });
});
