import type { OriginId, ScopeSetId } from "@sweetener/shared";
import { describe, expect, it } from "vitest";
import {
  createBinding,
  createBindingVisibility,
  createPhase,
  EnvironmentStore,
  runtimePhase,
  syntaxPhase,
} from "../src/index.js";

const scopes = 1 as ScopeSetId;
const declaration = 2 as OriginId;

describe("binding environments", () => {
  it("creates immutable bindings and persistent environment versions", () => {
    const store = new EnvironmentStore();
    const root = store.createRoot();
    const declared = store.declare(root, {
      spelling: "value",
      scopes,
      phase: runtimePhase,
      space: "value",
      declaration,
      kind: "lexical",
    });
    expect(Object.isFrozen(declared.binding)).toBe(true);
    expect(Object.isFrozen(declared.environment)).toBe(true);
    expect(declared.environment.epoch).not.toBe(root.epoch);
    expect(
      store.candidates(root, {
        spelling: "value",
        phase: runtimePhase,
        space: "value",
        position: 0,
      }),
    ).toEqual([]);
    expect(
      store.candidates(declared.environment, {
        spelling: "value",
        phase: runtimePhase,
        space: "value",
        position: 0,
      }),
    ).toEqual([declared.binding]);
  });

  it("keeps one frame's same-spelled bindings in declaration order in every version", () => {
    const store = new EnvironmentStore();
    const versions = [store.createRoot()];
    const bindings = [];
    for (let index = 0; index < 3; index += 1) {
      const declared = store.declare(versions.at(-1)!, {
        spelling: "value",
        scopes,
        phase: runtimePhase,
        space: "value",
        declaration,
        kind: "lexical",
      });
      versions.push(declared.environment);
      bindings.push(declared.binding);
    }
    const query = {
      spelling: "value",
      phase: runtimePhase,
      space: "value",
      position: 0,
    } as const;
    expect(store.candidates(versions[3]!, query)).toEqual(bindings);
    expect(store.candidates(versions[2]!, query)).toEqual(bindings.slice(0, 2));
    expect(store.candidates(versions[1]!, query)).toEqual(bindings.slice(0, 1));
    expect(versions[3]!.localCandidates("value", runtimePhase, "value")).toBe(
      versions[3]!.localCandidates("value", runtimePhase, "value"),
    );
  });

  it("keeps child frames attached to their parent snapshot", () => {
    const store = new EnvironmentStore();
    const root = store.createRoot();
    const child = store.child(root);
    const later = store.declare(root, {
      spelling: "later",
      scopes,
      phase: runtimePhase,
      space: "value",
      declaration,
      kind: "lexical",
    });
    expect(child.parent).toBe(root);
    expect(child.depth).toBe(1);
    expect(
      store.candidates(child, {
        spelling: "later",
        phase: runtimePhase,
        space: "value",
        position: 100,
      }),
    ).toEqual([]);
    expect(
      store.candidates(store.child(later.environment), {
        spelling: "later",
        phase: runtimePhase,
        space: "value",
        position: 100,
      }),
    ).toEqual([later.binding]);
  });

  it("filters candidates by spelling, phase, space, and visibility", () => {
    const store = new EnvironmentStore();
    let environment = store.createRoot();
    const runtimeValue = store.declare(environment, {
      spelling: "Name",
      scopes,
      phase: runtimePhase,
      space: "value",
      declaration,
      kind: "class",
      visibility: { kind: "from", start: 10 },
    });
    environment = runtimeValue.environment;
    const typeBinding = store.declare(environment, {
      spelling: "Name",
      scopes,
      phase: runtimePhase,
      space: "type",
      declaration,
      kind: "class",
      visibility: { kind: "range", start: 5, end: 20 },
    });
    environment = typeBinding.environment;
    const macro = store.declare(environment, {
      spelling: "Name",
      scopes,
      phase: syntaxPhase,
      space: "syntax-expr",
      declaration,
      kind: "macro",
    });
    environment = macro.environment;

    const query = (position: number) =>
      store.candidates(environment, {
        spelling: "Name",
        phase: runtimePhase,
        space: "value",
        position,
      });
    expect(query(9)).toEqual([]);
    expect(query(10)).toEqual([runtimeValue.binding]);
    expect(
      store.candidates(environment, {
        spelling: "Name",
        phase: runtimePhase,
        space: "type",
        position: 19,
      }),
    ).toEqual([typeBinding.binding]);
    expect(
      store.candidates(environment, {
        spelling: "Name",
        phase: runtimePhase,
        space: "type",
        position: 20,
      }),
    ).toEqual([]);
    expect(
      store.candidates(environment, {
        spelling: "Name",
        phase: syntaxPhase,
        space: "syntax-expr",
        position: 0,
      }),
    ).toEqual([macro.binding]);
  });

  it("groups one TypeScript declaration across value, type, and namespace spaces", () => {
    const store = new EnvironmentStore();
    const group = store.freshDeclarationGroup();
    let environment = store.createRoot();
    const bindings = [];
    for (const space of ["value", "type", "namespace"] as const) {
      const result = store.declare(environment, {
        spelling: "Merged",
        scopes,
        phase: runtimePhase,
        space,
        declaration,
        kind: "namespace",
        declarationGroup: group,
      });
      environment = result.environment;
      bindings.push(result.binding);
    }
    expect(new Set(bindings.map((binding) => binding.id)).size).toBe(3);
    expect(
      bindings.every((binding) => binding.declarationGroup === group),
    ).toBe(true);
  });

  it("returns local candidates before visible parent candidates", () => {
    const store = new EnvironmentStore();
    const parentDeclaration = store.declare(store.createRoot(), {
      spelling: "value",
      scopes,
      phase: runtimePhase,
      space: "value",
      declaration,
      kind: "lexical",
    });
    const localDeclaration = store.declare(
      store.child(parentDeclaration.environment),
      {
        spelling: "value",
        scopes,
        phase: runtimePhase,
        space: "value",
        declaration,
        kind: "lexical",
      },
    );
    expect(
      store.candidates(localDeclaration.environment, {
        spelling: "value",
        phase: runtimePhase,
        space: "value",
        position: 0,
      }),
    ).toEqual([localDeclaration.binding, parentDeclaration.binding]);
  });

  it("rejects malformed phases, spellings, and visibility regions", () => {
    expect(() => createPhase(Number.NaN)).toThrow(/safe integer/);
    expect(() => createBindingVisibility({ kind: "from", start: -1 })).toThrow(
      /non-negative/,
    );
    expect(() =>
      createBindingVisibility({ kind: "range", start: 5, end: 4 }),
    ).toThrow(/precede/);
    expect(() =>
      createBinding({
        id: 1 as never,
        spelling: "two\nlines",
        scopes,
        phase: runtimePhase,
        space: "value",
        declaration,
        kind: "lexical",
      }),
    ).toThrow(/one line/);
    const first = new EnvironmentStore();
    const second = new EnvironmentStore();
    expect(() => second.child(first.createRoot())).toThrow(
      /another implementation/,
    );
  });
});
