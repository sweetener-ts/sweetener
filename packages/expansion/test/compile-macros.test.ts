import { createPhase, ScopeStore } from "@sweetener/hygiene";
import { parseMacroDefinitions } from "@sweetener/macro-language";
import { readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  type BindingId,
  type SourceId,
} from "@sweetener/shared";
import { OriginStore } from "@sweetener/syntax";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { compileParsedMacros } from "../src/index.js";

const sourceId = 93 as SourceId;

describe("declarative macro compiler", () => {
  test("compiles the do-notation fixture through one public orchestration API", () => {
    const source = readFileSync(
      "fixtures/acceptance/playground/do-notation/declarative.sts",
      "utf8",
    );
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScope = scopes.freshScope("lexical", "do-definition");
    const definitionScopes = scopes.singleton(definitionScope);
    const read = readSyntax(source, {
      sourceId,
      scopes: definitionScopes,
      originStore: origins,
    });
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    const bindingIds = createIdAllocator<BindingId>(1_000);
    const compiled = compileParsedMacros(parsed, {
      sourceId,
      phase: createPhase(1),
      definitionScopes,
      allocateBindingId: () => bindingIds.allocate(),
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });

    expect(read.diagnostics).toEqual([]);
    expect(parsed.diagnostics).toEqual([]);
    expect(compiled.diagnostics).toEqual([]);
    expect(
      compiled.syntaxClasses
        .get(parsed.classBindings.find(({ name }) => name === "Bind")!.classId)
        ?.fields.map(({ name }) => name),
    ).toEqual(["name", "source"]);
    expect(compiled.macros).toHaveLength(1);
    expect(compiled.macros[0]).toMatchObject({
      category: "expr",
      binding: { spelling: "doSteps", space: "syntax-expr" },
    });
    expect(
      compiled.syntaxClasses.get(compiled.classId("BindAll")!),
    ).toBeDefined();
    expect(compiled.macros[0]!.rules).toHaveLength(3);
    expect(
      compiled.macros[0]!.rules.slice(1).map(
        ({ contracts }) => contracts.length,
      ),
    ).toEqual([1, 1]);
    expect(compiled.get("doSteps", "expr")).toBe(compiled.macros[0]);
    expect(compiled.classId("Bind")).toBeDefined();
  });

  test("lowers declarative operator properties into executable table entries", () => {
    const source = readFileSync(
      "fixtures/acceptance/playground/operators/declarative.sts",
      "utf8",
    );
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("lexical", "operator-definition"),
    );
    const parsed = parseMacroDefinitions(
      readSyntax(source, {
        sourceId,
        scopes: definitionScopes,
        originStore: origins,
      }).root,
      { sourceId },
    );
    const bindingIds = createIdAllocator<BindingId>(2_000);
    const compiled = compileParsedMacros(parsed, {
      sourceId,
      phase: createPhase(1),
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.operators).toMatchObject([
      {
        spelling: "#",
        fixity: "prefix",
        associativity: "none",
        precedence: 90,
      },
      {
        spelling: "|>",
        fixity: "infix",
        associativity: "left",
        precedence: 40,
      },
      {
        spelling: "==",
        fixity: "infix",
        associativity: "none",
        precedence: 30,
      },
    ]);
    expect(
      compiled.definitions.map(({ macro, operator }) => ({
        binding: macro.binding.id,
        operatorBinding: operator?.binding,
      })),
    ).toEqual([
      { binding: 2_000, operatorBinding: 2_000 },
      { binding: 2_001, operatorBinding: 2_001 },
      { binding: 2_002, operatorBinding: 2_002 },
    ]);
  });

  test("diagnoses incomplete operator declarations before registration", () => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.empty();
    const parsed = parseMacroDefinitions(
      readSyntax(
        "operator (%%):expr { rule { $left:expr %% $right:expr } => { $left } }",
        { sourceId, scopes: definitionScopes, originStore: origins },
      ).root,
      { sourceId },
    );
    const bindingIds = createIdAllocator<BindingId>(3_000);
    const compiled = compileParsedMacros(parsed, {
      sourceId,
      phase: createPhase(1),
      definitionScopes,
      allocateBindingId: bindingIds.allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(compiled.diagnostics.map(({ code }) => code)).toContain("SWR4006");
    expect(compiled.operators).toEqual([]);
  });

  test("lowers declared binding literals into matcher identity keys", () => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("lexical", "core-rewrite-definition"),
    );
    const parsed = parseMacroDefinitions(
      readSyntax(
        readFileSync(
          "fixtures/acceptance/playground/core-rewrites/declarative.sts",
          "utf8",
        ),
        { sourceId, scopes: definitionScopes, originStore: origins },
      ).root,
      { sourceId },
    );
    const compiled = compileParsedMacros(parsed, {
      sourceId,
      phase: createPhase(1),
      definitionScopes,
      allocateBindingId: createIdAllocator<BindingId>(3_500).allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.bindingLiterals).toMatchObject([
      {
        binding: 3_500,
        alias: "NaN",
        reference: "globalThis.NaN",
      },
    ]);
    expect(
      compiled
        .get("typeof", "expr")!
        .rules[0]!.matcher.instructions.filter(
          (instruction) =>
            instruction.op === "literal" &&
            instruction.literal.kind === "binding",
        ),
    ).toMatchObject([
      {
        literal: { kind: "binding", binding: 3_500, spelling: "NaN" },
      },
    ]);
  });

  test.each([
    ["csp", 2],
    ["protocols", 1],
    ["new-language", 1],
    ["multi-part-methods", 0],
  ] as const)(
    "compiles every declared operator property in the %s fixture",
    (fixture, expectedOperators) => {
      const origins = new OriginStore();
      const scopes = new ScopeStore();
      const definitionScopes = scopes.singleton(
        scopes.freshScope("lexical", `${fixture}-operator-definition`),
      );
      const parsed = parseMacroDefinitions(
        readSyntax(
          readFileSync(
            `fixtures/acceptance/playground/${fixture}/declarative.sts`,
            "utf8",
          ),
          { sourceId, scopes: definitionScopes, originStore: origins },
        ).root,
        { sourceId },
      );
      const compiled = compileParsedMacros(parsed, {
        sourceId,
        phase: createPhase(1),
        definitionScopes,
        allocateBindingId: createIdAllocator<BindingId>(4_000).allocate,
        spanForOrigin: (origin) =>
          origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
      });
      expect(
        compiled.diagnostics.filter(({ code }) => code === "SWR4006"),
      ).toEqual([]);
      if (fixture === "protocols" || fixture === "multi-part-methods")
        expect(compiled.diagnostics).toEqual([]);
      expect(compiled.operators).toHaveLength(expectedOperators);
      expect(
        compiled.operators.every(
          ({ fixity, precedence }) => fixity === "infix" && precedence > 0,
        ),
      ).toBe(true);
    },
  );

  test("compiles the declarative syntactic contexts a rule requires", () => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("lexical", "context-definition"),
    );
    const parsed = parseMacroDefinitions(
      readSyntax(
        `export syntax emit:stmt {
          rule { emit $value:expr; }
          context generator;
          context async;
          => { yield await $value; }
        }`,
        { sourceId, scopes: definitionScopes, originStore: origins },
      ).root,
      { sourceId },
    );
    const compiled = compileParsedMacros(parsed, {
      sourceId,
      phase: createPhase(1),
      definitionScopes,
      allocateBindingId: createIdAllocator<BindingId>(6_000).allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.macros[0]?.rules[0]?.requiredContexts).toEqual([
      "generator",
      "async",
    ]);
  });

  test("rejects unknown declarative syntactic contexts", () => {
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const definitionScopes = scopes.singleton(
      scopes.freshScope("lexical", "invalid-context-definition"),
    );
    const parsed = parseMacroDefinitions(
      readSyntax(
        `export syntax contextual:stmt {
          rule { contextual; }
          context imaginary;
          => { contextual; }
        }`,
        { sourceId, scopes: definitionScopes, originStore: origins },
      ).root,
      { sourceId },
    );
    const compiled = compileParsedMacros(parsed, {
      sourceId,
      phase: createPhase(1),
      definitionScopes,
      allocateBindingId: createIdAllocator<BindingId>(5_000).allocate,
      spanForOrigin: (origin) =>
        origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
    });
    expect(compiled.diagnostics).toMatchObject([
      {
        code: "SWR4008",
        stage: "expansion",
        messageArguments: ["imaginary"],
      },
    ]);
  });
});
