import {
  createBinding,
  createPhase,
  type Binding,
  type Phase,
  type SyntaxSpace,
} from "@sweetener/hygiene";
import type { BindingId, OriginId, ScopeSetId } from "@sweetener/shared";
import { describe, expect, test } from "vitest";
import {
  ExpansionEnvironmentStore,
  syntaxSpaceForCategory,
  type OperatorBinding,
} from "../src/index.js";

const phase = createPhase(1);
const binding = (
  id: number,
  spelling: string,
  space: SyntaxSpace = "syntax-expr",
  bindingPhase: Phase = phase,
): Binding =>
  createBinding({
    id: id as BindingId,
    spelling,
    scopes: 0 as ScopeSetId,
    phase: bindingPhase,
    space,
    declaration: id as OriginId,
    kind: "macro",
  });

const operator = (
  id: number,
  overrides: Partial<OperatorBinding> = {},
): OperatorBinding => ({
  binding: id as BindingId,
  spelling: "++",
  phase,
  category: "expr",
  fixity: "infix",
  associativity: "left",
  precedence: 20,
  origin: id as OriginId,
  ...overrides,
});

describe("expansion environments", () => {
  test("maps every expansion category to a distinct syntax space", () => {
    expect(
      [
        "item",
        "stmt",
        "expr",
        "type",
        "binding",
        "classElement",
        "jsxChild",
        "token",
        "tt",
      ].map((category) =>
        syntaxSpaceForCategory(
          category as Parameters<typeof syntaxSpaceForCategory>[0],
        ),
      ),
    ).toEqual([
      "syntax-item",
      "syntax-stmt",
      "syntax-expr",
      "syntax-type",
      "syntax-binding",
      "syntax-class-element",
      "syntax-jsx-child",
      "syntax-token",
      "syntax-tt",
    ]);
  });

  test("extends immutable snapshots with fresh epochs", () => {
    const store = new ExpansionEnvironmentStore();
    const root = store.createRoot();
    const first = store.extendBinding(root, binding(1, "unless"));
    const second = store.extendBinding(first, binding(2, "when"));
    expect([root.epoch, first.epoch, second.epoch]).toEqual([0, 1, 2]);
    expect(new Set([root.id, first.id, second.id]).size).toBe(3);
    expect(
      store.lookupBindings(root, {
        spelling: "unless",
        phase,
        category: "expr",
      }),
    ).toEqual([]);
    expect(
      store.lookupBindings(first, {
        spelling: "when",
        phase,
        category: "expr",
      }),
    ).toEqual([]);
    expect(
      store.lookupBindings(second, {
        spelling: "unless",
        phase,
        category: "expr",
      }),
    ).toEqual([binding(1, "unless")]);
    expect(Object.isFrozen(root)).toBe(true);
  });

  test("separates phase and category keys", () => {
    const store = new ExpansionEnvironmentStore();
    const otherPhase = createPhase(2);
    let environment = store.createRoot();
    environment = store.extendBinding(
      environment,
      binding(1, "form", "syntax-expr"),
    );
    environment = store.extendBinding(
      environment,
      binding(2, "form", "syntax-type"),
    );
    environment = store.extendBinding(
      environment,
      binding(3, "form", "syntax-expr", otherPhase),
    );
    expect(
      store
        .lookupBindings(environment, {
          spelling: "form",
          phase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([1]);
    expect(
      store
        .lookupBindings(environment, {
          spelling: "form",
          phase,
          category: "type",
        })
        .map(({ id }) => id),
    ).toEqual([2]);
    expect(
      store
        .lookupBindings(environment, {
          spelling: "form",
          phase: otherPhase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([3]);
  });

  test("lexical children allocate contexts and shadow exact binding keys", () => {
    const store = new ExpansionEnvironmentStore();
    const root = store.extendBinding(store.createRoot(), binding(1, "form"));
    const child = store.child(root);
    const shadowed = store.extendBinding(child, binding(2, "form"));
    expect(child.parent).toBe(root);
    expect(child.depth).toBe(1);
    expect(child.definitionContext).not.toBe(root.definitionContext);
    expect(
      store
        .lookupBindings(child, { spelling: "form", phase, category: "expr" })
        .map(({ id }) => id),
    ).toEqual([1]);
    expect(
      store
        .lookupBindings(shadowed, { spelling: "form", phase, category: "expr" })
        .map(({ id }) => id),
    ).toEqual([2]);
  });

  test("stores persistent operator families and validates properties", () => {
    const store = new ExpansionEnvironmentStore();
    const root = store.extendOperator(store.createRoot(), operator(1));
    const withPrefix = store.extendOperator(
      root,
      operator(2, { fixity: "prefix", associativity: "none" }),
    );
    expect(
      store
        .lookupOperators(root, { spelling: "++", phase, category: "expr" })
        .map(({ binding }) => binding),
    ).toEqual([1]);
    expect(
      store
        .lookupOperators(withPrefix, {
          spelling: "++",
          phase,
          category: "expr",
        })
        .map(({ fixity }) => fixity),
    ).toEqual(["infix", "prefix"]);
    expect(() => store.extendOperator(withPrefix, operator(3))).toThrow(
      /Duplicate local infix/,
    );
    expect(() =>
      store.extendOperator(
        withPrefix,
        operator(4, { fixity: "prefix", associativity: "left" }),
      ),
    ).toThrow(/nonassociative/);
    expect(() =>
      store.extendOperator(withPrefix, operator(4, { precedence: -1 })),
    ).toThrow(/precedence/);
  });

  test("a local fixity shadows its parent while other fixities remain visible", () => {
    const store = new ExpansionEnvironmentStore();
    let root = store.createRoot();
    root = store.extendOperator(root, operator(1));
    root = store.extendOperator(
      root,
      operator(2, { fixity: "prefix", associativity: "none" }),
    );
    const child = store.extendOperator(
      store.child(root),
      operator(3, { fixity: "prefix", associativity: "none", precedence: 30 }),
    );
    expect(
      store
        .lookupOperators(child, {
          spelling: "++",
          phase,
          category: "expr",
          fixity: "prefix",
        })
        .map(({ binding }) => binding),
    ).toEqual([3]);
    expect(
      store
        .lookupOperators(child, {
          spelling: "++",
          phase,
          category: "expr",
          fixity: "infix",
        })
        .map(({ binding }) => binding),
    ).toEqual([1]);
  });

  test("every earlier snapshot keeps answering as it did", () => {
    const store = new ExpansionEnvironmentStore();
    const versions = [store.createRoot()];
    for (let index = 1; index <= 600; index += 1) {
      const current = versions.at(-1)!;
      versions.push(
        index % 3 === 0
          ? store.extendOperator(
              current,
              operator(index, { spelling: `op${String(index)}` }),
            )
          : store.extendBinding(current, binding(index, `m${String(index)}`)),
      );
    }
    versions.forEach((version, size) => {
      for (const index of [1, 2, 3, 299, 300, 301, 598, 599, 600]) {
        const query = { phase, category: "expr" } as const;
        const found =
          index % 3 === 0
            ? store
                .lookupOperators(version, {
                  ...query,
                  spelling: `op${String(index)}`,
                })
                .map(({ binding }) => binding)
            : store
                .lookupBindings(version, {
                  ...query,
                  spelling: `m${String(index)}`,
                })
                .map(({ id }) => id);
        expect(found).toEqual(index <= size ? [index] : []);
      }
    });
  });

  test("rejects cross-store snapshots and runtime bindings", () => {
    const first = new ExpansionEnvironmentStore();
    const second = new ExpansionEnvironmentStore();
    const root = first.createRoot();
    expect(() => second.child(root)).toThrow(/another store/);
    expect(() =>
      first.extendBinding(root, binding(1, "value", "value")),
    ).toThrow(/syntax-space/);
  });

  test("re-extending an identical binding identity is idempotent", () => {
    const store = new ExpansionEnvironmentStore();
    const root = store.createRoot();
    const declaration = binding(1, "form");
    const once = store.extendBinding(root, declaration);
    const twice = store.extendBinding(once, declaration);
    expect(twice).toBe(once);
    expect(
      store.lookupBindings(twice, {
        spelling: "form",
        phase,
        category: "expr",
      }),
    ).toHaveLength(1);
  });
});
