import {
  createBinding,
  createPhase,
  EnvironmentStore,
  ScopeStore,
} from "@sweetener/hygiene";
import {
  compileParsedBindingContracts,
  compileParsedSyntaxClasses,
  compileParsedTemplates,
  parseMacroDefinitions,
} from "@sweetener/macro-language";
import {
  compileMatcherProgram,
  createSyntaxClassConsumer,
  inferCaptureShapes,
} from "@sweetener/pattern";
import { readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceLimitError,
  ResourceTracker,
  type BindingId,
  type InvocationId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createProtectedSyntax,
  createSyntaxCursor,
  OriginStore,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  invokeMacro,
  type CompiledMacroBinding,
  type CompiledMacroRule,
  ExpansionGuard,
  ExpansionCycleError,
  type ExpandReplacementRequest,
} from "../src/index.js";

const definitionSource = 301 as SourceId;
const invocationSource = 302 as SourceId;
const phase = createPhase(1);

function withoutEof(syntax: readonly Syntax[]): readonly Syntax[] {
  return syntax.filter(
    (item) => item.tag !== "token" || item.kind !== "end-of-file",
  );
}

function compileMacro(source: string, scopeStore: ScopeStore) {
  const origins = new OriginStore();
  const definitionScope = scopeStore.freshScope("lexical", "definition");
  const definitionScopes = scopeStore.singleton(definitionScope);
  const read = readSyntax(source, {
    sourceId: definitionSource,
    scopes: definitionScopes,
    originStore: origins,
  });
  const parsed = parseMacroDefinitions(read.root, {
    sourceId: definitionSource,
  });
  expect(read.diagnostics).toEqual([]);
  expect(parsed.diagnostics).toEqual([]);
  const definition = parsed.definitions.find(
    (candidate) => candidate.kind === "syntax",
  );
  if (definition?.kind !== "syntax") throw new Error("missing syntax macro");
  const spanForOrigin = (origin: Parameters<OriginStore["get"]>[0]) =>
    origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 };
  const classes = compileParsedSyntaxClasses(parsed, {
    sourceId: definitionSource,
    spanForOrigin,
  });
  const templates = compileParsedTemplates(parsed, {
    sourceId: definitionSource,
    spanForOrigin,
    syntaxClasses: classes.registry,
  });
  const contracts = compileParsedBindingContracts(parsed, {
    sourceId: definitionSource,
    spanForOrigin,
    syntaxClasses: classes.registry,
  });
  expect(classes.diagnostics).toEqual([]);
  expect(templates.diagnostics).toEqual([]);
  expect(contracts.diagnostics).toEqual([]);
  const templateByRule = new Map(
    templates.templates.map((compiled) => [compiled.rule, compiled.template]),
  );
  const contractsByRule = new Map(
    contracts.rules.map((compiled) => [compiled.rule, compiled.contracts]),
  );
  const rules: CompiledMacroRule[] = definition.rules.map((rule) => {
    const inference = inferCaptureShapes(rule.pattern, {
      sourceId: definitionSource,
      spanForOrigin,
      fieldsForClass: (classId) => classes.registry.shapeForClass(classId),
    });
    expect(inference.diagnostics).toEqual([]);
    const template = templateByRule.get(rule.id);
    if (template === undefined) throw new Error("missing compiled template");
    return Object.freeze({
      rule: rule.id,
      origin: rule.origin,
      fallback: rule.fallback,
      matcher: compileMatcherProgram(rule.pattern, {
        rule: rule.id,
        inference,
      }),
      template,
      contracts: contractsByRule.get(rule.id) ?? Object.freeze([]),
      refinements: Object.freeze([]),
      requiredContexts: Object.freeze([]),
    });
  });
  const bindings = new Map(
    parsed.classBindings.map((binding) => [binding.name, binding.classId]),
  );
  const token = bindings.get("token");
  const tt = bindings.get("tt");
  const ident = bindings.get("ident");
  if (token === undefined || tt === undefined || ident === undefined) {
    throw new Error("missing builtin syntax classes");
  }
  const consumeClass = createSyntaxClassConsumer(classes.registry, {
    builtins: { token, tt, ident },
    externalConsumer: (_classId, cursor) => {
      const syntax = cursor.consume();
      return syntax === undefined
        ? undefined
        : { cursor, syntax: Object.freeze([syntax]), origin: syntax.origin };
    },
  });
  const macro: CompiledMacroBinding = Object.freeze({
    binding: createBinding({
      id: 50 as BindingId,
      spelling: definition.name,
      scopes: definitionScopes,
      phase,
      space: "syntax-expr",
      declaration: definition.origin,
      kind: "macro",
    }),
    category: definition.category,
    definitionScopes,
    rules: Object.freeze(rules),
    parameter: false,
  });
  return { origins, macro, consumeClass };
}

function invoke(
  source: string,
  compiled: ReturnType<typeof compileMacro>,
  scopeStore: ScopeStore,
  overrides: Partial<Parameters<typeof invokeMacro>[0]> = {},
) {
  const callsiteScope = scopeStore.freshScope("lexical", "callsite");
  const callsiteScopes = scopeStore.singleton(callsiteScope);
  const read = readSyntax(source, {
    sourceId: invocationSource,
    scopes: callsiteScopes,
    originStore: compiled.origins,
  });
  expect(read.diagnostics).toEqual([]);
  const input = withoutEof(read.root.children);
  const environments = new EnvironmentStore();
  const environment = environments.createRoot();
  const syntaxIds = createIdAllocator<SyntaxId>(10_000);
  const bindingIds = createIdAllocator<BindingId>(10_000);
  const invocationIds = createIdAllocator<InvocationId>(1);
  const tracker = new ResourceTracker(createResourceBudget());
  const guard = new ExpansionGuard({ tracker });
  const requests: ExpandReplacementRequest[] = [];
  const result = invokeMacro({
    macro: compiled.macro,
    cursor: createSyntaxCursor(input),
    category: "expr",
    phase,
    environmentEpoch: environment.epoch,
    consumeClass: compiled.consumeClass,
    scopeStore,
    origins: compiled.origins,
    environments,
    environment,
    tracker,
    guard,
    allocateSyntaxId: syntaxIds.allocate,
    allocateBindingId: bindingIds.allocate,
    allocateInvocationId: invocationIds.allocate,
    position: 0,
    admit: () => true,
    expandReplacement: (request) => {
      requests.push(request);
      const first = request.syntax[0];
      if (first === undefined) throw new Error("empty replacement");
      return createProtectedSyntax({
        id: syntaxIds.allocate(),
        span: {
          start: Math.min(...request.syntax.map(({ span }) => span.start)),
          end: Math.max(...request.syntax.map(({ span }) => span.end)),
        },
        origin: first.origin,
        scopes: first.scopes,
        category: request.category,
        children: request.syntax,
      });
    },
    diagnosticOrigin: (origin) => {
      const selected = compiled.origins.selectPrimarySource(origin);
      if (selected === undefined) throw new Error("missing source origin");
      return {
        sourceId: selected.sourceId,
        start: selected.span.start,
        end: selected.span.end,
        originId: origin,
      };
    },
    ...overrides,
  });
  return { result, requests, tracker, input };
}

describe("transactional macro invocation", () => {
  test("tries ordinary rules in source order before fallback rules", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax choose:expr {
        fallback rule { choose $x:tt } => { fallback($x) }
        rule { choose first $x:tt } => { first($x) }
        rule { choose second $x:tt } => { second($x) }
      }`,
      scopes,
    );
    const { result, requests, tracker } = invoke(
      "choose second value",
      compiled,
      scopes,
    );
    expect(result.expanded).toBe(true);
    if (!result.expanded) throw new Error("expected expansion");
    expect(result.trace.attemptedRules.map(({ status }) => status)).toEqual([
      "no-match",
      "selected",
    ]);
    expect(result.trace.selectedRule).toBe(compiled.macro.rules[2]!.rule);
    expect(result.cursor.atEnd).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ category: "expr", phase: 1 });
    expect(tracker.usage.matcherSteps).toBeGreaterThan(0);
    expect(tracker.usage.expansionSteps).toBeGreaterThanOrEqual(1);
    expect(tracker.usage.nestingDepth).toBe(0);
    expect(
      result.trace.attemptedRules.reduce(
        (total, attempt) => total + attempt.matcherSteps,
        0,
      ),
    ).toBe(tracker.usage.matcherSteps);
  });

  test("carries an authorized core interception into the invocation trace", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax choose:expr { rule { choose $x:tt } => { $x } }`,
      scopes,
    );
    const coreInterception = Object.freeze({
      spelling: "choose",
      category: "expr" as const,
      phase,
      environmentEpoch: 0 as Parameters<
        typeof invokeMacro
      >[0]["environmentEpoch"],
      candidates: Object.freeze([compiled.macro.binding.id]),
      authorized: Object.freeze([compiled.macro.binding.id]),
      selected: compiled.macro.binding.id,
      decision: "shadow-macro" as const,
      definitionOrigin: compiled.macro.binding.declaration,
      importOrigin: undefined,
    });
    const { result } = invoke("choose value", compiled, scopes, {
      coreInterception,
    });
    expect(result.trace.coreInterception).toBe(coreInterception);
  });

  test("rejects a core interception trace for another binding", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax choose:expr { rule { choose } => { ok } }`,
      scopes,
    );
    expect(() =>
      invoke("choose", compiled, scopes, {
        coreInterception: {
          spelling: "choose",
          category: "expr",
          phase,
          environmentEpoch: 0 as Parameters<
            typeof invokeMacro
          >[0]["environmentEpoch"],
          candidates: Object.freeze([51 as BindingId]),
          authorized: Object.freeze([51 as BindingId]),
          selected: 51 as BindingId,
          decision: "shadow-macro",
          definitionOrigin: compiled.macro.binding.declaration,
          importOrigin: undefined,
        },
      }),
    ).toThrow(/does not select this macro/);
  });

  test("does not allocate invocation scopes for a boundary-rejected rule", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax choose:expr {
        rule { choose $x:tt } => { first($x) }
        rule { choose $x:tt } => { second($x) }
      }`,
      scopes,
    );
    const before = scopes.stats.allocatedScopes;
    let admissions = 0;
    const { result } = invoke("choose value", compiled, scopes, {
      admit: () => ++admissions === 2,
    });
    expect(result.expanded).toBe(true);
    if (!result.expanded) throw new Error("expected expansion");
    expect(result.trace.attemptedRules.map(({ status }) => status)).toEqual([
      "boundary-rejected",
      "selected",
    ]);
    // One call-site scope plus the selected invocation's two hygiene scopes.
    expect(scopes.stats.allocatedScopes - before).toBe(3);
    expect(result.trace.scopesIntroduced).toHaveLength(2);
  });

  test("runs binding contracts, template operations, and recursive expansion", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax scoped:expr {
        rule { scoped $name:binding $body:tt }
        bind $name in $body as lexical value
        => { $name $body #fresh("temporary") #capture($name) }
      }`,
      scopes,
    );
    const { result, requests } = invoke("scoped name body", compiled, scopes);
    expect(result.expanded).toBe(true);
    if (!result.expanded) throw new Error("expected expansion");
    expect(result.environment).not.toBeUndefined();
    expect(result.freshBindings).toHaveLength(1);
    expect(result.trace.scopesIntroduced).toHaveLength(3);
    expect(
      result.trace.captures.map(({ name, values }) => [name, values]),
    ).toEqual([
      ["name", 1],
      ["body", 1],
    ]);
    expect(result.trace.operations.map(({ operation }) => operation)).toEqual([
      "fresh",
      "capture",
    ]);
    expect(result.trace.outputOrigins.length).toBeGreaterThan(0);
    expect(requests[0]?.followingScopes).toBe(result.followingScopes);
    expect(requests[0]?.invocationId).toBe(result.trace.invocationId);
  });

  test("returns the original position and a stable diagnostic when no rule matches", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax choose:expr {
        rule { choose first } => { first }
        fallback rule { choose last } => { last }
      }`,
      scopes,
    );
    const { result, input } = invoke("choose neither", compiled, scopes);
    expect(result.expanded).toBe(false);
    if (result.expanded) throw new Error("expected failed expansion");
    expect(result.cursor.index).toBe(0);
    expect(result.cursor.remainingRange().toArray()).toEqual(input);
    expect(result.diagnostic.code).toBe("SWR4001");
    expect(result.trace.selectedRule).toBeUndefined();
    expect(result.trace.attemptedRules.map(({ status }) => status)).toEqual([
      "no-match",
      "no-match",
    ]);
    expect(result.trace.scopesIntroduced).toEqual([]);
  });

  test("rejects a recursive expansion result in the wrong category", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax choose:expr { rule { choose } => { value } }`,
      scopes,
    );
    expect(() =>
      invoke("choose", compiled, scopes, {
        expandReplacement: (request) => {
          const child = request.syntax[0]!;
          return createProtectedSyntax({
            id: 99_999 as SyntaxId,
            span: child.span,
            origin: child.origin,
            scopes: child.scopes,
            category: "stmt",
            children: request.syntax,
          });
        },
      }),
    ).toThrow("Recursive expansion returned stmt for expr");
  });

  test("rejects direct recursive re-entry with the same structural input", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax loop:expr { rule { loop } => { loop } }`,
      scopes,
    );
    const tracker = new ResourceTracker(createResourceBudget());
    const guard = new ExpansionGuard({ tracker });
    const recurse: Parameters<
      typeof invokeMacro
    >[0]["expandReplacement"] = () => {
      const nested = invoke("loop", compiled, scopes, {
        tracker,
        guard,
        expandReplacement: recurse,
      }).result;
      if (!nested.expanded) throw new Error("recursive rule stopped matching");
      return nested.syntax;
    };
    expect(() =>
      invoke("loop", compiled, scopes, {
        tracker,
        guard,
        expandReplacement: recurse,
      }),
    ).toThrow(ExpansionCycleError);
    expect(guard.depth).toBe(0);
    expect(tracker.usage.nestingDepth).toBe(0);
  });

  test("rejects output growth without returning partial expansion", () => {
    const scopes = new ScopeStore();
    const compiled = compileMacro(
      `syntax grow:expr { rule { grow } => { one two three } }`,
      scopes,
    );
    const tracker = new ResourceTracker(
      createResourceBudget({ maxOutputTokens: 1 }),
    );
    const guard = new ExpansionGuard({ tracker });
    expect(() => invoke("grow", compiled, scopes, { tracker, guard })).toThrow(
      ResourceLimitError,
    );
    expect(guard.depth).toBe(0);
    expect(tracker.usage.nestingDepth).toBe(0);
  });
});
