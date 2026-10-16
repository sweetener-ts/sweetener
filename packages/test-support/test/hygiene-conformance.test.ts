import {
  ambiguityDiagnostic,
  applyBindingContract,
  createBindingContract,
  createInvocationScopes,
  definitionContextScope,
  EnvironmentStore,
  resolveBinding,
  runtimePhase,
  ScopeStore,
  syntaxPhase,
} from "@sweetener/hygiene";
import {
  CaptureRecord,
  createCaptureLeaf,
  createCapturePath,
  createCaptureSequence,
  type CaptureLeaf,
  type CaptureValue,
} from "@sweetener/pattern";
import { assignPrintedNames } from "@sweetener/printer";
import {
  createIdAllocator,
  type BindingId,
  type CaptureId,
  type CardinalityGroupId,
  type OriginId,
  type ScopeSetId,
  type SourceId,
  type SyntaxClassId,
  type SyntaxId,
} from "@sweetener/shared";
import { createToken, OriginStore, type TokenSyntax } from "@sweetener/syntax";
import {
  createHygieneOperationTemplate,
  createSequenceTemplate,
  evaluateTemplate,
  instantiateTemplate,
  type EvaluatedTemplate,
} from "@sweetener/template";
import { describe, expect, test } from "vitest";

const capture = (value: number) => value as CaptureId;
const group = (value: number) => value as CardinalityGroupId;
const classId = (value: number) => value as SyntaxClassId;
const bindingId = (value: number) => value as BindingId;
const syntaxId = (value: number) => value as SyntaxId;
const originId = (value: number) => value as OriginId;

let nextSyntax = 1;
function identifier(
  spelling: string,
  scopes: ScopeSetId,
  origin = originId(nextSyntax),
): TokenSyntax {
  return createToken({
    id: syntaxId(nextSyntax++),
    span: { start: 0, end: spelling.length },
    origin,
    scopes,
    kind: "identifier",
    raw: spelling,
    value: spelling,
  });
}

function leaf(
  id: CaptureId,
  spelling: string,
  scopes: ScopeSetId,
  fields: CaptureRecord = CaptureRecord.empty,
): CaptureLeaf {
  const syntax = identifier(spelling, scopes);
  return createCaptureLeaf({
    id,
    classId: classId(1),
    syntax: [syntax],
    fields,
    origin: syntax.origin,
  });
}

function sequence(
  cardinalityGroup: CardinalityGroupId,
  elements: readonly CaptureValue[],
) {
  return createCaptureSequence({
    depth: 1,
    cardinalityGroup,
    elements,
  });
}

function onlyScope(value: CaptureValue, scopes: ScopeStore): ScopeSetId {
  if (value.kind !== "leaf") throw new Error("expected capture leaf");
  const set = value.syntax[0]!.scopes;
  expect(scopes.size(set)).toBeGreaterThan(0);
  return set;
}

describe("Phase 3 hygiene semantic conformance", () => {
  test("fresh, capture, and definition operations preserve distinct identities and scopes", () => {
    const scopes = new ScopeStore();
    const callerScope = scopes.freshScope("lexical", "caller");
    const definitionScope = scopes.freshScope("lexical", "definition");
    const callerScopes = scopes.singleton(callerScope);
    const definitionScopes = scopes.singleton(definitionScope);
    const invocationScopes = createInvocationScopes(scopes);
    const origins = new OriginStore();
    const definitionOrigin = origins.source(1 as SourceId, {
      start: 0,
      end: 1,
    });
    const invocationOrigin = origins.source(2 as SourceId, {
      start: 0,
      end: 1,
    });
    const captured = identifier("generated", callerScopes, invocationOrigin);
    const pieces: readonly EvaluatedTemplate[] = Object.freeze([
      Object.freeze({
        kind: "operation",
        operation: "fresh",
        hint: "tmp",
        ordinal: 0,
        origin: definitionOrigin,
      }),
      Object.freeze({
        kind: "operation",
        operation: "capture",
        syntax: Object.freeze([captured]),
        capture: capture(1),
        origin: definitionOrigin,
      }),
      Object.freeze({
        kind: "operation",
        operation: "definition",
        syntax: Object.freeze([captured]),
        capture: capture(1),
        origin: definitionOrigin,
      }),
    ]);
    const ids = createIdAllocator<SyntaxId>(100);
    const bindings = createIdAllocator<BindingId>(100);
    const result = instantiateTemplate(pieces, {
      scopeStore: scopes,
      origins,
      invocationScopes,
      invocationOrigin,
      definitionScopes,
      callsiteScopes: callerScopes,
      anchor: { start: 0, end: 0 },
      allocateSyntaxId: () => ids.allocate(),
      allocateBindingId: () => bindings.allocate(),
      category: "expr",
    });
    const [fresh, capturedName, definitionName] = result.syntax;
    expect(result.freshBindings).toHaveLength(1);
    expect(result.freshBindings[0]?.binding).toBe(bindingId(100));
    expect(scopes.has(capturedName!.scopes, callerScope)).toBe(true);
    expect(scopes.has(capturedName!.scopes, invocationScopes.useSite)).toBe(
      true,
    );
    expect(
      scopes.has(capturedName!.scopes, invocationScopes.introduction),
    ).toBe(true);
    expect(scopes.has(definitionName!.scopes, definitionScope)).toBe(true);
    expect(scopes.has(definitionName!.scopes, callerScope)).toBe(false);

    const callsiteBinding = bindingId(200);
    const plan = assignPrintedNames({
      declarations: [
        {
          binding: result.freshBindings[0]!.binding,
          preferredName: "tmp",
          conflicts: [callsiteBinding],
        },
        {
          binding: callsiteBinding,
          preferredName: "tmp",
          conflicts: [result.freshBindings[0]!.binding],
        },
      ],
      occurrences: [
        {
          syntax: fresh!.id,
          binding: result.freshBindings[0]!.binding,
          kind: "identifier",
        },
        {
          syntax: capturedName!.id,
          binding: callsiteBinding,
          kind: "identifier",
        },
      ],
    });
    expect([...plan.names.values()]).toEqual(["tmp", "tmp_1"]);
    expect(origins.get(capturedName!.origin)?.kind).toBe("composed");

    const evaluated = evaluateTemplate(
      createSequenceTemplate(definitionOrigin, [
        createHygieneOperationTemplate(definitionOrigin, {
          kind: "capture",
          path: createCapturePath("generated", capture(1)),
        }),
      ]),
      {
        captures: new CaptureRecord([
          [
            capture(1),
            createCaptureLeaf({
              id: capture(1),
              classId: classId(1),
              syntax: [captured],
              origin: captured.origin,
            }),
          ],
        ]),
      },
    );
    expect(evaluated.trace).toEqual([
      {
        operation: "capture",
        origin: definitionOrigin,
        capture: capture(1),
        repetitionIndices: [],
        detail: undefined,
      },
    ]);
  });

  test("do, match, constructor, and protocol contracts enforce declared regions", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const rows = capture(1);
    const name = capture(2);
    const body = capture(3);
    const row = (index: number) =>
      leaf(
        rows,
        `row${String(index)}`,
        scopes.empty(),
        new CaptureRecord([
          [name, leaf(name, `name${String(index)}`, scopes.empty())],
          [body, leaf(body, `body${String(index)}`, scopes.empty())],
        ]),
      );
    const captures = new CaptureRecord([
      [rows, sequence(group(7), [row(0), row(1), row(2)])],
    ]);
    const sequential = applyBindingContract(
      createBindingContract({
        origin: originId(1),
        binders: createCapturePath("rows", rows, [
          { name: "name", capture: name },
        ]),
        region: {
          kind: "capture",
          path: createCapturePath("rows", rows, [
            { name: "body", capture: body },
          ]),
        },
        kind: "sequential",
        space: "value",
      }),
      {
        captures,
        scopeStore: scopes,
        environments,
        environment: environments.createRoot(),
        phase: runtimePhase,
        followingScope: definitionContextScope(scopes),
      },
    );
    const transformedRows = sequential.captures.get(rows);
    if (transformedRows?.kind !== "sequence") throw new Error("missing rows");
    expect(
      transformedRows.elements.map((value) => {
        if (value.kind !== "leaf") throw new Error("missing row");
        return scopes.size(
          (value.fields.get(body) as CaptureLeaf).syntax[0]!.scopes,
        );
      }),
    ).toEqual([0, 1, 2]);

    const arms = capture(10);
    const binder = capture(11);
    const result = capture(12);
    const arm = (index: number) =>
      leaf(
        arms,
        `arm${String(index)}`,
        scopes.empty(),
        new CaptureRecord([
          [binder, leaf(binder, `item${String(index)}`, scopes.empty())],
          [result, leaf(result, `result${String(index)}`, scopes.empty())],
        ]),
      );
    const branchResult = applyBindingContract(
      createBindingContract({
        origin: originId(2),
        binders: createCapturePath("arms", arms, [
          { name: "binder", capture: binder },
        ]),
        region: {
          kind: "capture",
          path: createCapturePath("arms", arms, [
            { name: "result", capture: result },
          ]),
        },
        kind: "lexical",
        space: "value",
      }),
      {
        captures: new CaptureRecord([
          [arms, sequence(group(9), [arm(0), arm(1)])],
        ]),
        scopeStore: scopes,
        environments,
        environment: environments.createRoot(),
        phase: runtimePhase,
        followingScope: definitionContextScope(scopes),
      },
    );
    const transformedArms = branchResult.captures.get(arms);
    if (transformedArms?.kind !== "sequence") throw new Error("missing arms");
    const branchScopes = transformedArms.elements.map((value) => {
      if (value.kind !== "leaf") throw new Error("missing arm");
      return onlyScope(value.fields.get(result)!, scopes);
    });
    expect(branchScopes[0]).not.toBe(branchScopes[1]);
    expect(scopes.size(branchResult.followingScopes)).toBe(0);

    const constructors = capture(20);
    const following = applyBindingContract(
      createBindingContract({
        origin: originId(3),
        binders: createCapturePath("constructors", constructors),
        region: { kind: "following" },
        kind: "recursive",
        space: "value",
      }),
      {
        captures: new CaptureRecord([
          [
            constructors,
            sequence(group(10), [
              leaf(constructors, "Some", scopes.empty()),
              leaf(constructors, "None", scopes.empty()),
            ]),
          ],
        ]),
        scopeStore: scopes,
        environments,
        environment: branchResult.environment,
        phase: runtimePhase,
        followingScope: definitionContextScope(scopes),
      },
    );
    expect(following.bindings).toHaveLength(2);
    expect(scopes.size(following.followingScopes)).toBe(1);

    const parameters = capture(30);
    const parameterBodies = capture(31);
    const protocol = applyBindingContract(
      createBindingContract({
        origin: originId(4),
        binders: createCapturePath("parameters", parameters),
        region: {
          kind: "capture",
          path: createCapturePath("bodies", parameterBodies),
        },
        kind: "lexical",
        space: "value",
      }),
      {
        captures: new CaptureRecord([
          [
            parameters,
            sequence(group(12), [
              leaf(parameters, "left", scopes.empty()),
              leaf(parameters, "right", scopes.empty()),
            ]),
          ],
          [
            parameterBodies,
            sequence(group(12), [
              leaf(parameterBodies, "leftBody", scopes.empty()),
              leaf(parameterBodies, "rightBody", scopes.empty()),
            ]),
          ],
        ]),
        scopeStore: scopes,
        environments,
        environment: following.environment,
        phase: runtimePhase,
        followingScope: definitionContextScope(scopes),
      },
    );
    const bodies = protocol.captures.get(parameterBodies);
    if (bodies?.kind !== "sequence") throw new Error("missing protocol bodies");
    expect(
      bodies.elements.map((value) => scopes.size(onlyScope(value, scopes))),
    ).toEqual([1, 1]);
    expect(onlyScope(bodies.elements[0]!, scopes)).not.toBe(
      onlyScope(bodies.elements[1]!, scopes),
    );
  });

  test("resolution respects definition scopes, ambiguity, and TypeScript spaces", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const definitionScope = scopes.singleton(
      scopes.freshScope("lexical", "definition"),
    );
    const callerScope = scopes.singleton(
      scopes.freshScope("lexical", "caller"),
    );
    let environment = environments.createRoot();
    const definitionHelper = environments.declare(environment, {
      spelling: "helper",
      scopes: definitionScope,
      phase: runtimePhase,
      space: "value",
      declaration: originId(1),
      kind: "function",
    });
    environment = definitionHelper.environment;
    const callerHelper = environments.declare(environment, {
      spelling: "helper",
      scopes: callerScope,
      phase: runtimePhase,
      space: "value",
      declaration: originId(2),
      kind: "function",
    });
    environment = callerHelper.environment;
    expect(
      resolveBinding(environments, environment, scopes, {
        spelling: "helper",
        scopes: definitionScope,
        phase: runtimePhase,
        space: "value",
        position: 0,
      }),
    ).toEqual({ kind: "resolved", binding: definitionHelper.binding });

    const both = scopes.union(definitionScope, callerScope);
    const ambiguous = resolveBinding(environments, environment, scopes, {
      spelling: "helper",
      scopes: both,
      phase: runtimePhase,
      space: "value",
      position: 0,
    });
    expect(ambiguous.kind).toBe("ambiguous");
    expect(
      ambiguityDiagnostic(
        {
          spelling: "helper",
          scopes: both,
          phase: runtimePhase,
          space: "value",
          position: 0,
        },
        ambiguous,
        {
          reference: { sourceId: 1 as SourceId, start: 0, end: 6 },
          declaration: (binding) => ({
            sourceId: 1 as SourceId,
            start: binding.declaration,
            end: binding.declaration + 1,
            originId: binding.declaration,
          }),
        },
      )?.code,
    ).toBe("SWR3001");

    const value = environments.declare(environment, {
      spelling: "Model",
      scopes: scopes.empty(),
      phase: runtimePhase,
      space: "value",
      declaration: originId(3),
      kind: "class",
    });
    const type = environments.declare(value.environment, {
      spelling: "Model",
      scopes: scopes.empty(),
      phase: runtimePhase,
      space: "type",
      declaration: originId(4),
      kind: "interface",
    });
    const valueResult = resolveBinding(environments, type.environment, scopes, {
      spelling: "Model",
      scopes: scopes.empty(),
      phase: runtimePhase,
      space: "value",
      position: 0,
    });
    const typeResult = resolveBinding(environments, type.environment, scopes, {
      spelling: "Model",
      scopes: scopes.empty(),
      phase: runtimePhase,
      space: "type",
      position: 0,
    });
    expect(valueResult).toEqual({ kind: "resolved", binding: value.binding });
    expect(typeResult).toEqual({ kind: "resolved", binding: type.binding });

    const generatedMacro = environments.declare(type.environment, {
      spelling: "generated",
      scopes: callerScope,
      phase: syntaxPhase,
      space: "syntax-expr",
      declaration: originId(5),
      kind: "macro",
    });
    expect(
      resolveBinding(environments, generatedMacro.environment, scopes, {
        spelling: "generated",
        scopes: callerScope,
        phase: syntaxPhase,
        space: "syntax-expr",
        position: 0,
      }),
    ).toEqual({ kind: "resolved", binding: generatedMacro.binding });
    expect(
      resolveBinding(environments, generatedMacro.environment, scopes, {
        spelling: "generated",
        scopes: callerScope,
        phase: runtimePhase,
        space: "value",
        position: 0,
      }).kind,
    ).toBe("unbound");
  });

  test("name assignment is invariant under identity allocation and unrelated alpha-renaming", () => {
    const makePlan = (first: BindingId, second: BindingId, unrelated: string) =>
      assignPrintedNames({
        declarations: [
          { binding: second, preferredName: "macroName", conflicts: [first] },
          { binding: first, preferredName: "macroName", conflicts: [second] },
          { binding: bindingId(999), preferredName: unrelated, conflicts: [] },
        ],
        occurrences: [
          { syntax: syntaxId(1), binding: first, kind: "identifier" },
          { syntax: syntaxId(2), binding: second, kind: "identifier" },
          { syntax: syntaxId(3), binding: bindingId(999), kind: "identifier" },
        ],
      });
    const original = makePlan(bindingId(10), bindingId(20), "other");
    const remapped = makePlan(bindingId(800), bindingId(2), "renamedOther");
    expect(
      original.rewrites.slice(0, 2).map((item) => item.printedName),
    ).toEqual(["macroName", "macroName_1"]);
    expect(
      remapped.rewrites.slice(0, 2).map((item) => item.printedName),
    ).toEqual(original.rewrites.slice(0, 2).map((item) => item.printedName));
  });
});
