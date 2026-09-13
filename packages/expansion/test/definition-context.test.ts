import {
  createBinding,
  createPhase,
  runtimePhase,
  type SyntaxSpace,
} from "@sweetener/hygiene";
import {
  parseMacroDefinitions,
  type MacroDefinition,
} from "@sweetener/macro-language";
import { readSyntax } from "@sweetener/reader";
import type {
  BindingId,
  OriginId,
  ScopeSetId,
  SourceId,
  SyntaxId,
} from "@sweetener/shared";
import { createSyntaxSequence, createToken } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  ExpansionEnvironmentStore,
  processDefinitionContext,
  processLocalDefinitionContext,
  resolveCompiledMacro,
  type PreparedMacroDefinition,
} from "../src/index.js";

const sourceId = 77 as SourceId;
const syntaxPhase = createPhase(1);

function definitions(source: string): readonly MacroDefinition[] {
  const parsed = parseMacroDefinitions(
    readSyntax(source, { sourceId, scopes: 0 as ScopeSetId }).root,
    { sourceId },
  );
  expect(parsed.diagnostics).toEqual([]);
  return parsed.definitions;
}

function syntaxBinding(
  id: number,
  spelling: string,
  space: SyntaxSpace = "syntax-expr",
  kind: "macro" | "operator" = "macro",
) {
  return createBinding({
    id: id as BindingId,
    spelling,
    scopes: 0 as ScopeSetId,
    phase: syntaxPhase,
    space,
    declaration: id as OriginId,
    kind,
  });
}

function prepared(
  definition: MacroDefinition,
  id: number,
  generated = false,
): PreparedMacroDefinition {
  const spelling =
    definition.kind === "operator" ? definition.spelling : definition.name;
  const category =
    definition.kind === "syntax-class" ? "tt" : definition.category;
  const binding = syntaxBinding(
    id,
    spelling,
    `syntax-${category === "classElement" ? "class-element" : category === "jsxChild" ? "jsx-child" : category}` as SyntaxSpace,
    definition.kind === "operator" ? "operator" : "macro",
  );
  return Object.freeze({
    kind: "macro-definition",
    definition,
    binding,
    generated,
    operator:
      definition.kind === "operator"
        ? Object.freeze({
            binding: binding.id,
            spelling,
            phase: syntaxPhase,
            category: definition.category,
            fixity: "infix" as const,
            associativity: "left" as const,
            precedence: 20,
            origin: definition.origin,
          })
        : undefined,
  });
}

describe("definition contexts", () => {
  test("orders recursive visibility, runtime emission, and nonrecursive visibility", () => {
    const [recursive, ordinary] = definitions(`
      rec syntax loop:expr { rule { loop } => { loop } }
      syntax later:expr { rule { later } => { loop } }
    `);
    const store = new ExpansionEnvironmentStore();
    const root = store.createRoot();
    const runtimeToken = createToken({
      id: 900 as SyntaxId,
      span: { start: 0, end: 5 },
      origin: 900 as OriginId,
      scopes: 0 as ScopeSetId,
      kind: "identifier",
      raw: "value",
      value: "value",
    });
    const runtimeBinding = createBinding({
      id: 50 as BindingId,
      spelling: "value",
      scopes: 0 as ScopeSetId,
      phase: runtimePhase,
      space: "value",
      declaration: 900 as OriginId,
      kind: "lexical",
    });
    const seen = new Map<string, readonly number[]>();
    const result = processDefinitionContext({
      store,
      environment: root,
      items: Object.freeze([
        prepared(recursive!, 1),
        Object.freeze({
          kind: "runtime" as const,
          origin: runtimeToken.origin,
          syntax: createSyntaxSequence([runtimeToken]),
          bindings: Object.freeze([runtimeBinding]),
        }),
        prepared(ordinary!, 2),
      ]),
      validate: (item, environment) => {
        seen.set(
          item.binding.spelling,
          store
            .lookupBindings(environment, {
              spelling: item.binding.spelling,
              phase: syntaxPhase,
              category: "expr",
            })
            .map(({ id }) => id),
        );
        return Object.freeze({ diagnostics: Object.freeze([]) });
      },
    });
    expect(seen.get("loop")).toEqual([1]);
    expect(seen.get("later")).toEqual([]);
    expect(result.emitted).toEqual([runtimeToken]);
    expect(result.runtimeBindings).toEqual([runtimeBinding]);
    expect(result.definitions.map(({ item }) => item.binding.id)).toEqual([
      1, 2,
    ]);
    expect(
      store
        .lookupBindings(result.environment, {
          spelling: "later",
          phase: syntaxPhase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([2]);
    expect(result.steps.map(({ emittedSyntax }) => emittedSyntax)).toEqual([
      0, 1, 0,
    ]);
  });

  test("rolls back failed generated definitions before following items", () => {
    const [bad, after] = definitions(`
      syntax bad:expr { rule { bad } => { bad } }
      syntax after:expr { rule { after } => { after } }
    `);
    const malformed = parseMacroDefinitions(
      readSyntax("syntax", { sourceId, scopes: 0 as ScopeSetId }).root,
      { sourceId },
    ).diagnostics;
    expect(malformed.some(({ severity }) => severity === "error")).toBe(true);
    const store = new ExpansionEnvironmentStore();
    const observations: number[][] = [];
    const result = processDefinitionContext({
      store,
      environment: store.createRoot(),
      items: Object.freeze([
        prepared(bad!, 1, true),
        prepared(after!, 2, true),
      ]),
      validate: (item, environment) => {
        if (item.binding.spelling === "bad") {
          return Object.freeze({ diagnostics: malformed });
        }
        observations.push(
          store
            .lookupBindings(environment, {
              spelling: "bad",
              phase: syntaxPhase,
              category: "expr",
            })
            .map(({ id }) => id),
        );
        return Object.freeze({ diagnostics: Object.freeze([]) });
      },
    });
    expect(observations).toEqual([[]]);
    expect(result.definitions.map(({ item }) => item.binding.spelling)).toEqual(
      ["after"],
    );
    expect(result.steps).toMatchObject([
      { generated: true, registeredBinding: undefined },
      { generated: true, registeredBinding: 2 },
    ]);
    expect(result.diagnostics).toEqual(malformed);
  });

  test("registers operator bindings and table entries atomically", () => {
    const [definition] = definitions(`
      operator (%%):expr {
        fixity infix;
        associativity left;
        precedence 20;
        rule { $left:expr %% $right:expr } => { combine($left, $right) }
      }
    `);
    const store = new ExpansionEnvironmentStore();
    const result = processDefinitionContext({
      store,
      environment: store.createRoot(),
      items: Object.freeze([prepared(definition!, 8)]),
      validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
    });
    expect(
      store
        .lookupBindings(result.environment, {
          spelling: "%%",
          phase: syntaxPhase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([8]);
    expect(
      store.lookupOperators(result.environment, {
        spelling: "%%",
        phase: syntaxPhase,
        category: "expr",
      }),
    ).toMatchObject([{ binding: 8, precedence: 20 }]);
    expect(result.emitted).toEqual([]);
  });

  test("diagnoses conflicting local operator fixities without leaking bindings", () => {
    const [first, second] = definitions(`
      operator (%%):expr {
        fixity infix; associativity left; precedence 20;
        rule { $left:expr %% $right:expr } => { first($left, $right) }
      }
      operator (%%):expr {
        fixity infix; associativity left; precedence 30;
        rule { $left:expr %% $right:expr } => { second($left, $right) }
      }
    `);
    const store = new ExpansionEnvironmentStore();
    const result = processDefinitionContext({
      store,
      environment: store.createRoot(),
      items: Object.freeze([prepared(first!, 8), prepared(second!, 9)]),
      validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
      diagnosticOrigin: (origin) => ({
        sourceId,
        start: Number(origin),
        end: Number(origin),
        originId: origin,
      }),
    });
    expect(result.diagnostics).toMatchObject([
      {
        code: "SWR4007",
        messageArguments: ["%%", "infix"],
        relatedOrigins: [{ message: "previous operator binding" }],
      },
    ]);
    expect(result.definitions.map(({ item }) => item.binding.id)).toEqual([8]);
    expect(result.steps).toMatchObject([
      { registeredBinding: 8 },
      { registeredBinding: undefined, diagnostics: [{ code: "SWR4007" }] },
    ]);
    expect(
      store.lookupOperators(result.environment, {
        spelling: "%%",
        phase: syntaxPhase,
        category: "expr",
        fixity: "infix",
      }),
    ).toMatchObject([{ binding: 8 }]);
  });

  test("rejects mismatched categories and syntax bindings in runtime items", () => {
    const [definition] = definitions(
      "syntax itemForm:item { rule { itemForm } => { value; } }",
    );
    const store = new ExpansionEnvironmentStore();
    expect(() =>
      processDefinitionContext({
        store,
        environment: store.createRoot(),
        items: Object.freeze([
          Object.freeze({
            kind: "macro-definition" as const,
            definition: definition!,
            binding: syntaxBinding(1, "itemForm", "syntax-expr"),
          }),
        ]),
        validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
      }),
    ).toThrow(/requires syntax-item/);
    expect(() =>
      processDefinitionContext({
        store,
        environment: store.createRoot(),
        items: Object.freeze([
          Object.freeze({
            kind: "runtime" as const,
            origin: 1 as OriginId,
            syntax: createSyntaxSequence([]),
            bindings: Object.freeze([syntaxBinding(1, "bad")]),
          }),
        ]),
        validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
      }),
    ).toThrow(/syntax-space/);
  });

  test("contains local syntax bindings and restores the exact parent snapshot", () => {
    const [outerDefinition, localDefinition] = definitions(`
      syntax outer:expr { rule { outer } => { 1 } }
      rec syntax local:expr { rule { local } => { local } }
    `);
    const store = new ExpansionEnvironmentStore();
    const outer = processDefinitionContext({
      store,
      environment: store.createRoot(),
      items: Object.freeze([prepared(outerDefinition!, 1)]),
      validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
    }).environment;
    let recursiveVisibleDuringValidation = false;
    const local = processLocalDefinitionContext({
      store,
      parentEnvironment: outer,
      items: Object.freeze([prepared(localDefinition!, 2)]),
      validate: (_item, environment) => {
        recursiveVisibleDuringValidation =
          store.lookupBindings(environment, {
            spelling: "local",
            phase: syntaxPhase,
            category: "expr",
          })[0]?.id === 2;
        return Object.freeze({ diagnostics: Object.freeze([]) });
      },
    });
    expect(recursiveVisibleDuringValidation).toBe(true);
    expect(local.localEnvironment.parent).toBe(outer);
    expect(local.exitEnvironment).toBe(outer);
    expect(
      store
        .lookupBindings(local.localEnvironment, {
          spelling: "local",
          phase: syntaxPhase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([2]);
    expect(
      store.lookupBindings(local.exitEnvironment, {
        spelling: "local",
        phase: syntaxPhase,
        category: "expr",
      }),
    ).toEqual([]);
    expect(
      store
        .lookupBindings(local.localEnvironment, {
          spelling: "outer",
          phase: syntaxPhase,
          category: "expr",
        })
        .map(({ id }) => id),
    ).toEqual([1]);

    const localBinding = prepared(localDefinition!, 2).binding;
    const compiledLocal = Object.freeze({
      binding: localBinding,
      category: "expr" as const,
      definitionScopes: localBinding.scopes,
      rules: Object.freeze([]),
      parameter: false,
    });
    const module = Object.freeze({
      macros: Object.freeze([compiledLocal]),
    });
    expect(
      resolveCompiledMacro({
        module,
        store,
        environment: local.localEnvironment,
        spelling: "local",
        category: "expr",
        phase: syntaxPhase,
      }),
    ).toBe(compiledLocal);
    expect(
      resolveCompiledMacro({
        module,
        store,
        environment: local.exitEnvironment,
        spelling: "local",
        category: "expr",
        phase: syntaxPhase,
      }),
    ).toBeUndefined();
  });

  test("selects the nearest local shadow and restores the outer macro on exit", () => {
    const [outerDefinition, localDefinition] = definitions(`
      syntax choose:expr { rule { choose } => { outer } }
      syntax choose:expr { rule { choose } => { local } }
    `);
    const store = new ExpansionEnvironmentStore();
    const outerItem = prepared(outerDefinition!, 10);
    const localItem = prepared(localDefinition!, 11);
    const outerEnvironment = processDefinitionContext({
      store,
      environment: store.createRoot(),
      items: Object.freeze([outerItem]),
      validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
    }).environment;
    const local = processLocalDefinitionContext({
      store,
      parentEnvironment: outerEnvironment,
      items: Object.freeze([localItem]),
      validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
    });
    const outerMacro = Object.freeze({
      binding: outerItem.binding,
      category: "expr" as const,
      definitionScopes: outerItem.binding.scopes,
      rules: Object.freeze([]),
      parameter: false,
    });
    const localMacro = Object.freeze({
      binding: localItem.binding,
      category: "expr" as const,
      definitionScopes: localItem.binding.scopes,
      rules: Object.freeze([]),
      parameter: false,
    });
    const module = Object.freeze({
      macros: Object.freeze([outerMacro, localMacro]),
    });
    const resolve = (environment: typeof outerEnvironment) =>
      resolveCompiledMacro({
        module,
        store,
        environment,
        spelling: "choose",
        category: "expr",
        phase: syntaxPhase,
      });
    expect(resolve(local.localEnvironment)).toBe(localMacro);
    expect(resolve(local.exitEnvironment)).toBe(outerMacro);
  });

  test("rolls back a provisional recursive binding when validation fails", () => {
    const [definition] = definitions(
      "rec syntax broken:expr { rule { broken } => { broken } }",
    );
    const malformed = parseMacroDefinitions(
      readSyntax("syntax", { sourceId, scopes: 0 as ScopeSetId }).root,
      { sourceId },
    ).diagnostics;
    const store = new ExpansionEnvironmentStore();
    const root = store.createRoot();
    let visibleDuringValidation = false;
    const result = processDefinitionContext({
      store,
      environment: root,
      items: Object.freeze([prepared(definition!, 12)]),
      validate: (_item, environment) => {
        visibleDuringValidation =
          store.lookupBindings(environment, {
            spelling: "broken",
            phase: syntaxPhase,
            category: "expr",
          })[0]?.id === 12;
        return Object.freeze({ diagnostics: malformed });
      },
    });
    expect(visibleDuringValidation).toBe(true);
    expect(result.environment).toBe(root);
    expect(result.definitions).toEqual([]);
    expect(
      store.lookupBindings(result.environment, {
        spelling: "broken",
        phase: syntaxPhase,
        category: "expr",
      }),
    ).toEqual([]);
  });
});
