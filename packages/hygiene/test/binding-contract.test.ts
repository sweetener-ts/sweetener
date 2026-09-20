import {
  CaptureRecord,
  createCaptureLeaf,
  createCapturePath,
  createCaptureSequence,
  type CaptureLeaf,
  type CaptureValue,
} from "@sweetener/pattern";
import type {
  CaptureId,
  CardinalityGroupId,
  OriginId,
  SyntaxClassId,
  SyntaxId,
} from "@sweetener/shared";
import { createToken } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  applyBindingContract,
  applyBindingContracts,
  createBindingContract,
  createPhase,
  EnvironmentStore,
  resolveBinding,
  ScopeStore,
} from "../src/index.js";

const bindingClass = 1 as SyntaxClassId;
const ttClass = 2 as SyntaxClassId;
const capture = (value: number) => value as CaptureId;
const origin = (value: number) => value as OriginId;
const group = (value: number) => value as CardinalityGroupId;
let syntaxId = 1;

function leaf(
  id: CaptureId,
  spelling: string,
  classId: SyntaxClassId,
  scopes: ReturnType<ScopeStore["empty"]>,
  fields: CaptureRecord = CaptureRecord.empty,
): CaptureLeaf {
  const token = createToken({
    id: syntaxId++ as SyntaxId,
    span: { start: 0, end: spelling.length },
    origin: origin(syntaxId),
    scopes,
    kind: "identifier",
    raw: spelling,
    value: spelling,
  });
  return createCaptureLeaf({
    id,
    classId,
    syntax: [token],
    fields,
    origin: token.origin,
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

function appliedScopes(value: CaptureValue): ReturnType<ScopeStore["empty"]> {
  if (value.kind !== "leaf") throw new Error("expected leaf");
  return value.syntax[0]!.scopes;
}

describe("binding contracts", () => {
  /**
   * A contract over a repetition that matched nothing binds nothing.
   *
   * Both of these were refusals, and they read as though they caught a
   * contract naming a capture the rule does not have -- but that is caught
   * when the macro is compiled, as `SWR3002`. What was left for them to catch
   * is a path that exists and selected nothing this time, which is an ordinary
   * outcome: a `match` whose every arm binds nothing, or a `data` declaration
   * whose constructors have no fields. Refused, an enum of nullary variants
   * could be neither declared nor matched, and the refusal arrived as an
   * expansion failure rather than a diagnostic, because it is thrown.
   */
  test.each([
    ["no binders", true, false],
    ["no region values", false, true],
    ["neither", true, true],
  ])(
    "binds nothing where a contract selects %s",
    (_label, emptyBinders, emptyRegion) => {
      const scopes = new ScopeStore();
      const environments = new EnvironmentStore();
      const binderCapture = capture(1);
      const regionCapture = capture(2);
      const captures = new CaptureRecord([
        [
          binderCapture,
          emptyBinders
            ? sequence(group(1), [])
            : sequence(group(1), [
                leaf(binderCapture, "value", bindingClass, scopes.empty()),
              ]),
        ],
        [
          regionCapture,
          emptyRegion
            ? sequence(group(2), [])
            : sequence(group(2), [
                leaf(regionCapture, "body", ttClass, scopes.empty()),
              ]),
        ],
      ]);
      const environment = environments.createRoot();
      const result = applyBindingContract(
        createBindingContract({
          origin: origin(1),
          binders: createCapturePath("binders", binderCapture),
          region: {
            kind: "capture",
            path: createCapturePath("region", regionCapture),
          },
          kind: "lexical",
          space: "value",
        }),
        {
          captures,
          scopeStore: scopes,
          environments,
          environment,
          phase: createPhase(0),
          position: 0,
        },
      );

      expect(result.bindings).toEqual([]);
      expect(result.introducedScopes).toEqual([]);
      expect(result.generatedBindings).toEqual([]);
      // The captures and the environment are handed back as they were, so a
      // contract that selected nothing leaves the next one exactly what it
      // would have had.
      expect(result.captures).toBe(captures);
      expect(result.environment).toBe(environment);
    },
  );

  test("applies a do-style field binder to the complete rest region", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const nameField = capture(2);
    const sourceField = capture(3);
    const stepCapture = capture(1);
    const restCapture = capture(4);
    const name = leaf(nameField, "value", bindingClass, scopes.empty());
    const source = leaf(sourceField, "source", ttClass, scopes.empty());
    const step = leaf(
      stepCapture,
      "step",
      ttClass,
      scopes.empty(),
      new CaptureRecord([
        [nameField, name],
        [sourceField, source],
      ]),
    );
    const rest = sequence(group(1), [
      leaf(restCapture, "first", ttClass, scopes.empty()),
      leaf(restCapture, "second", ttClass, scopes.empty()),
    ]);
    const captures = new CaptureRecord([
      [stepCapture, step],
      [restCapture, rest],
    ]);
    const result = applyBindingContract(
      createBindingContract({
        origin: origin(1),
        binders: createCapturePath("step", stepCapture, [
          { name: "name", capture: nameField },
        ]),
        region: {
          kind: "capture",
          path: createCapturePath("rest", restCapture),
        },
        kind: "lexical",
        space: "value",
      }),
      {
        captures,
        scopeStore: scopes,
        environments,
        environment: environments.createRoot(),
        phase: createPhase(0),
        position: 0,
      },
    );
    const transformedStep = result.captures.get(stepCapture);
    if (transformedStep?.kind !== "leaf") throw new Error("missing step");
    const transformedName = transformedStep.fields.get(nameField)!;
    const transformedSource = transformedStep.fields.get(sourceField)!;
    const transformedRest = result.captures.get(restCapture);
    if (transformedRest?.kind !== "sequence") throw new Error("missing rest");
    const binderScopes = appliedScopes(transformedName);
    expect(scopes.size(binderScopes)).toBe(1);
    expect(scopes.size(appliedScopes(transformedSource))).toBe(0);
    expect(
      transformedRest.elements.every(
        (value) => appliedScopes(value) === binderScopes,
      ),
    ).toBe(true);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({
      spelling: "value",
      scopes: binderScopes,
      space: "value",
    });
  });

  test("exports recursive declaration scopes to following syntax", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const constructors = capture(1);
    const captures = new CaptureRecord([
      [
        constructors,
        sequence(group(1), [
          leaf(constructors, "Some", bindingClass, scopes.empty()),
          leaf(constructors, "None", bindingClass, scopes.empty()),
        ]),
      ],
    ]);
    const result = applyBindingContract(
      createBindingContract({
        origin: origin(1),
        binders: createCapturePath("constructors", constructors),
        region: { kind: "following" },
        kind: "recursive",
        space: "value",
      }),
      {
        captures,
        scopeStore: scopes,
        environments,
        environment: environments.createRoot(),
        phase: createPhase(0),
        position: 0,
      },
    );
    expect(result.bindings).toHaveLength(2);
    expect(scopes.size(result.followingScopes)).toBe(1);
    expect(
      result.bindings.every((binding) =>
        scopes.subset(binding.scopes, result.followingScopes),
      ),
    ).toBe(true);
    expect(result.bindings[0]?.visibility).toEqual({ kind: "from", start: 0 });
  });

  test("threads captures, environments, and following scopes across contracts", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const first = capture(1);
    const second = capture(2);
    const captures = new CaptureRecord([
      [first, leaf(first, "First", bindingClass, scopes.empty())],
      [second, leaf(second, "Second", bindingClass, scopes.empty())],
    ]);
    const contracts = [first, second].map((id, index) =>
      createBindingContract({
        origin: origin(index + 1),
        binders: createCapturePath(index === 0 ? "first" : "second", id),
        region: { kind: "following" },
        kind: "recursive",
        space: "value",
      }),
    );
    const result = applyBindingContracts({
      contracts,
      captures,
      scopeStore: scopes,
      environments,
      environment: environments.createRoot(),
      phase: createPhase(0),
      position: 12,
    });
    expect(result.bindings.map((binding) => binding.spelling)).toEqual([
      "First",
      "Second",
    ]);
    expect(
      result.bindings.every(
        (binding) =>
          binding.visibility.kind === "from" && binding.visibility.start === 12,
      ),
    ).toBe(true);
    expect(scopes.size(result.followingScopes)).toBe(2);
  });

  test("sequential binders scope only later aligned regions", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const rows = capture(1);
    const nameField = capture(2);
    const bodyField = capture(3);
    const row = (index: number) => {
      const name = leaf(
        nameField,
        `name${String(index)}`,
        bindingClass,
        scopes.empty(),
      );
      const body = leaf(
        bodyField,
        `body${String(index)}`,
        ttClass,
        scopes.empty(),
      );
      return leaf(
        rows,
        `row${String(index)}`,
        ttClass,
        scopes.empty(),
        new CaptureRecord([
          [nameField, name],
          [bodyField, body],
        ]),
      );
    };
    const captures = new CaptureRecord([
      [rows, sequence(group(7), [row(0), row(1), row(2)])],
    ]);
    const result = applyBindingContract(
      createBindingContract({
        origin: origin(1),
        binders: createCapturePath("rows", rows, [
          { name: "name", capture: nameField },
        ]),
        region: {
          kind: "capture",
          path: createCapturePath("rows", rows, [
            { name: "body", capture: bodyField },
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
        phase: createPhase(0),
        position: 0,
      },
    );
    const transformed = result.captures.get(rows);
    if (transformed?.kind !== "sequence") throw new Error("missing rows");
    const bodySizes = transformed.elements.map((value) => {
      if (value.kind !== "leaf") throw new Error("expected row leaf");
      return scopes.size(appliedScopes(value.fields.get(bodyField)!));
    });
    expect(bodySizes).toEqual([0, 1, 2]);
    expect(result.bindings).toHaveLength(3);
    expect(scopes.size(result.followingScopes)).toBe(3);
  });

  test("later sequential binders shadow earlier binders with the same name", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const rows = capture(1);
    const nameField = capture(2);
    const bodyField = capture(3);
    const row = () =>
      leaf(
        rows,
        "row",
        ttClass,
        scopes.empty(),
        new CaptureRecord([
          [nameField, leaf(nameField, "value", bindingClass, scopes.empty())],
          [bodyField, leaf(bodyField, "value", ttClass, scopes.empty())],
        ]),
      );
    const captures = new CaptureRecord([
      [rows, sequence(group(7), [row(), row(), row()])],
    ]);
    const result = applyBindingContract(
      createBindingContract({
        origin: origin(1),
        binders: createCapturePath("rows", rows, [
          { name: "name", capture: nameField },
        ]),
        region: {
          kind: "capture",
          path: createCapturePath("rows", rows, [
            { name: "body", capture: bodyField },
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
        phase: createPhase(0),
        position: 0,
      },
    );
    const transformed = result.captures.get(rows);
    if (transformed?.kind !== "sequence") throw new Error("missing rows");
    const finalRow = transformed.elements[2];
    if (finalRow?.kind !== "leaf") throw new Error("missing final row");
    const referenceScopes = appliedScopes(finalRow.fields.get(bodyField)!);

    expect(
      resolveBinding(environments, result.environment, scopes, {
        spelling: "value",
        scopes: referenceScopes,
        phase: createPhase(0),
        space: "value",
        position: 0,
      }),
    ).toMatchObject({ kind: "resolved", binding: result.bindings[1] });
  });

  test("derives and declares a following binding without rebinding its source", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const name = capture(1);
    const captures = new CaptureRecord([
      [name, leaf(name, "count", bindingClass, scopes.empty())],
    ]);
    const result = applyBindingContract(
      createBindingContract({
        origin: origin(1),
        binders: createCapturePath("name", name),
        generatedName: {
          prefix: "set",
          suffix: "",
          casing: "upper-first",
        },
        region: { kind: "following" },
        kind: "lexical",
        space: "value",
      }),
      {
        captures,
        scopeStore: scopes,
        environments,
        environment: environments.createRoot(),
        phase: createPhase(0),
        position: 4,
      },
    );
    const transformed = result.captures.get(name);
    if (transformed?.kind !== "leaf") throw new Error("missing name");
    expect(scopes.size(appliedScopes(transformed))).toBe(0);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toMatchObject({ spelling: "setCount" });
    expect(scopes.size(result.bindings[0]!.scopes)).toBe(1);
    expect(
      scopes.subset(result.bindings[0]!.scopes, result.followingScopes),
    ).toBe(true);
    expect(result.generatedBindings).toEqual([
      {
        spelling: "setCount",
        origin: transformed.origin,
        scopes: result.bindings[0]!.scopes,
      },
    ]);
    expect(
      resolveBinding(environments, result.environment, scopes, {
        spelling: "setCount",
        scopes: result.followingScopes,
        phase: createPhase(0),
        space: "value",
        position: 4,
      }),
    ).toMatchObject({ kind: "resolved", binding: result.bindings[0] });
  });

  test("keeps sequential generated scopes on declarations and out of source captures", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    const names = capture(1);
    const regions = capture(2);
    const cardinality = group(9);
    const captures = new CaptureRecord([
      [
        names,
        sequence(cardinality, [
          leaf(names, "first", bindingClass, scopes.empty()),
          leaf(names, "second", bindingClass, scopes.empty()),
          leaf(names, "third", bindingClass, scopes.empty()),
        ]),
      ],
      [
        regions,
        sequence(cardinality, [
          leaf(regions, "one", ttClass, scopes.empty()),
          leaf(regions, "two", ttClass, scopes.empty()),
          leaf(regions, "three", ttClass, scopes.empty()),
        ]),
      ],
    ]);
    const result = applyBindingContract(
      createBindingContract({
        origin: origin(1),
        binders: createCapturePath("names", names),
        generatedName: {
          prefix: "set",
          suffix: "",
          casing: "upper-first",
        },
        region: {
          kind: "capture",
          path: createCapturePath("regions", regions),
        },
        kind: "sequential",
        space: "value",
      }),
      {
        captures,
        scopeStore: scopes,
        environments,
        environment: environments.createRoot(),
        phase: createPhase(0),
        position: 0,
      },
    );
    const transformedNames = result.captures.get(names);
    const transformedRegions = result.captures.get(regions);
    if (transformedNames?.kind !== "sequence") throw new Error("missing names");
    if (transformedRegions?.kind !== "sequence")
      throw new Error("missing regions");
    expect(
      transformedNames.elements.map((value) =>
        scopes.size(appliedScopes(value)),
      ),
    ).toEqual([0, 0, 0]);
    expect(result.bindings.map(({ spelling }) => spelling)).toEqual([
      "setFirst",
      "setSecond",
      "setThird",
    ]);
    expect(result.bindings.map(({ scopes: set }) => scopes.size(set))).toEqual([
      1, 2, 3,
    ]);
    expect(
      transformedRegions.elements.map((value) =>
        scopes.size(appliedScopes(value)),
      ),
    ).toEqual([0, 1, 2]);
  });
});
