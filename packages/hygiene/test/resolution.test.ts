import { describe, expect, test } from "vitest";
import type { OriginId, SourceId } from "@sweetener/shared";
import {
  ambiguityDiagnostic,
  BindingResolver,
  createPhase,
  EnvironmentStore,
  resolveBinding,
  ScopeStore,
  runtimePhase,
  type Binding,
  type BindingEnvironment,
  type IdentifierReference,
} from "../src/index.js";

const sourceId = 1 as SourceId;
const origin = (value: number) => value as OriginId;

function reference(
  scopes: ReturnType<ScopeStore["empty"]>,
  overrides: Partial<IdentifierReference> = {},
): IdentifierReference {
  return {
    spelling: "value",
    scopes,
    phase: runtimePhase,
    space: "value",
    position: 10,
    ...overrides,
  };
}

function declare(
  store: EnvironmentStore,
  environment: BindingEnvironment,
  scopes: ReturnType<ScopeStore["empty"]>,
  declaration: number,
  overrides: Partial<Parameters<EnvironmentStore["declare"]>[1]> = {},
) {
  return store.declare(environment, {
    spelling: "value",
    scopes,
    phase: runtimePhase,
    space: "value",
    declaration: origin(declaration),
    kind: "lexical",
    ...overrides,
  });
}

describe("binding resolution", () => {
  test("returns unbound when no applicable candidate exists", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    expect(
      resolveBinding(
        environments,
        environments.createRoot(),
        scopes,
        reference(scopes.empty()),
      ),
    ).toEqual({ kind: "unbound" });
  });

  test("selects the sole subset candidate", () => {
    const scopes = new ScopeStore();
    const lexical = scopes.freshScope();
    const lexicalSet = scopes.singleton(lexical);
    const environments = new EnvironmentStore();
    const declared = declare(
      environments,
      environments.createRoot(),
      lexicalSet,
      1,
    );
    const result = resolveBinding(
      environments,
      declared.environment,
      scopes,
      reference(lexicalSet),
    );
    expect(result).toEqual({ kind: "resolved", binding: declared.binding });
  });

  test("selects the most specific scope set", () => {
    const scopes = new ScopeStore();
    const outerScope = scopes.freshScope();
    const innerScope = scopes.freshScope();
    const outerSet = scopes.singleton(outerScope);
    const innerSet = scopes.add(outerSet, innerScope);
    const environments = new EnvironmentStore();
    let environment = environments.createRoot();
    environment = declare(environments, environment, outerSet, 1).environment;
    const inner = declare(environments, environment, innerSet, 2);
    expect(
      resolveBinding(
        environments,
        inner.environment,
        scopes,
        reference(innerSet),
      ),
    ).toEqual({ kind: "resolved", binding: inner.binding });
  });

  test("retains incomparable and equal maximal candidates as ambiguous", () => {
    const scopes = new ScopeStore();
    const left = scopes.singleton(scopes.freshScope());
    const right = scopes.singleton(scopes.freshScope());
    const both = scopes.union(left, right);
    const environments = new EnvironmentStore();
    let environment = environments.createRoot();
    environment = declare(environments, environment, right, 20).environment;
    environment = declare(environments, environment, left, 10).environment;
    environment = declare(environments, environment, left, 11).environment;
    const result = resolveBinding(
      environments,
      environment,
      scopes,
      reference(both),
    );
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates.map((binding) => binding.declaration)).toEqual([
        origin(10),
        origin(11),
        origin(20),
      ]);
    }
  });

  test("honors environment phase, space, and visibility filters", () => {
    const scopes = new ScopeStore();
    const environments = new EnvironmentStore();
    let environment = environments.createRoot();
    environment = declare(environments, environment, scopes.empty(), 1, {
      phase: createPhase(1),
    }).environment;
    environment = declare(environments, environment, scopes.empty(), 2, {
      space: "type",
    }).environment;
    environment = declare(environments, environment, scopes.empty(), 3, {
      visibility: { kind: "from", start: 20 },
    }).environment;
    expect(
      resolveBinding(
        environments,
        environment,
        scopes,
        reference(scopes.empty()),
      ),
    ).toEqual({ kind: "unbound" });
  });

  test("emits SWR3001 with candidates in deterministic order", () => {
    const scopes = new ScopeStore();
    const left = scopes.singleton(scopes.freshScope());
    const right = scopes.singleton(scopes.freshScope());
    const environments = new EnvironmentStore();
    let environment = environments.createRoot();
    environment = declare(environments, environment, right, 20).environment;
    environment = declare(environments, environment, left, 10).environment;
    const identifier = reference(scopes.union(left, right));
    const result = resolveBinding(
      environments,
      environment,
      scopes,
      identifier,
    );
    const diagnostic = ambiguityDiagnostic(identifier, result, {
      reference: { sourceId, start: 100, end: 105 },
      declaration: (binding: Binding) => ({
        sourceId,
        start: binding.declaration,
        end: binding.declaration + 1,
        originId: binding.declaration,
      }),
    });
    expect(diagnostic?.code).toBe("SWR3001");
    expect(diagnostic?.messageArguments).toEqual(["value", 2]);
    expect(
      diagnostic?.relatedOrigins.map((related) => related.origin.start),
    ).toEqual([10, 20]);
  });

  test("is independent of declaration insertion order", () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const permutations: number[][] = [];
    for (let trial = 0; trial < 100; trial += 1) {
      const permutation = Array.from({ length: 8 }, (_, index) => index);
      for (let index = permutation.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(random() * (index + 1));
        [permutation[index], permutation[swap]] = [
          permutation[swap]!,
          permutation[index]!,
        ];
      }
      permutations.push(permutation);
    }
    for (const permutation of permutations) {
      const scopes = new ScopeStore();
      const first = scopes.singleton(scopes.freshScope());
      const second = scopes.singleton(scopes.freshScope());
      const definitions = [
        { scopes: first, declaration: 30 },
        { scopes: second, declaration: 10 },
        { scopes: second, declaration: 20 },
        { scopes: scopes.empty(), declaration: 1 },
        { scopes: scopes.empty(), declaration: 2 },
        { scopes: scopes.empty(), declaration: 3 },
        { scopes: scopes.empty(), declaration: 4 },
        { scopes: scopes.empty(), declaration: 5 },
      ];
      const environments = new EnvironmentStore();
      let environment = environments.createRoot();
      for (const index of permutation) {
        const definition = definitions[index]!;
        environment = declare(
          environments,
          environment,
          definition.scopes,
          definition.declaration,
        ).environment;
      }
      const result = resolveBinding(
        environments,
        environment,
        scopes,
        reference(scopes.union(first, second)),
      );
      expect(result.kind).toBe("ambiguous");
      if (result.kind === "ambiguous") {
        expect(
          result.candidates.map((candidate) => candidate.declaration),
        ).toEqual([origin(30), origin(10), origin(20)]);
      }
    }
  });

  test("a resolver answers every reference as resolveBinding does", () => {
    let state = 0x2e5_01fe;
    const random = (bound: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % bound;
    };
    const scopes = new ScopeStore();
    const pool = Array.from({ length: 7 }, () => scopes.freshScope());
    const randomSet = (minimum: number, maximum: number) => {
      let set = scopes.empty();
      const size = minimum + random(maximum - minimum + 1);
      for (let index = 0; index < size; index += 1)
        set = scopes.add(set, pool[random(pool.length)]!);
      return set;
    };
    const spellings = ["a", "b", "c"];
    const spaces = ["value", "type"] as const;
    const environments = new EnvironmentStore();
    let environment = environments.createRoot();
    for (let index = 1; index <= 300; index += 1) {
      if (random(40) === 0) environment = environments.child(environment);
      const start = random(100);
      const visibility = [
        { kind: "whole-frame" as const },
        { kind: "from" as const, start },
        { kind: "range" as const, start, end: start + random(50) },
      ][random(3)]!;
      environment = declare(
        environments,
        environment,
        randomSet(random(25) === 0 ? 0 : 1, 4),
        index,
        {
          spelling: spellings[random(spellings.length)]!,
          space: spaces[random(spaces.length)]!,
          visibility,
        },
      ).environment;
    }
    const resolver = new BindingResolver(environments, environment, scopes);
    const kinds = new Set<string>();
    for (let index = 0; index < 3_000; index += 1) {
      const identifier = reference(randomSet(0, 7), {
        spelling: spellings[random(spellings.length)]!,
        space: spaces[random(spaces.length)]!,
        position: random(160),
      });
      const expected = resolveBinding(
        environments,
        environment,
        scopes,
        identifier,
      );
      kinds.add(expected.kind);
      expect(resolver.resolve(identifier)).toEqual(expected);
    }
    expect(kinds).toEqual(new Set(["resolved", "unbound", "ambiguous"]));
  });
});
