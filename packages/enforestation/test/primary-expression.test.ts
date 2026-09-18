import { createPhase } from "@sweetener/hygiene";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type EnvironmentEpoch,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import { createSyntaxCursor, OriginStore } from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  ConsumerRegistry,
  createPrimaryExpressionConsumer,
  primaryExpressionPrecedence,
  StopSet,
} from "../src/index.js";

const sourceId = 88 as SourceId;

function consume(source: string, stopSet?: StopSet) {
  const origins = new OriginStore();
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
  });
  expect(read.diagnostics).toEqual([]);
  const syntax = read.root.children.filter(
    (node) => node.tag !== "token" || node.kind !== "end-of-file",
  );
  const ids = createIdAllocator<SyntaxId>(10_000);
  const registry = new ConsumerRegistry([
    {
      category: "expr",
      consumer: createPrimaryExpressionConsumer({
        origins,
        allocateSyntaxId: () => ids.allocate(),
      }),
    },
  ]);
  const cursor = createSyntaxCursor(syntax);
  const result = registry.consume("expr", {
    cursor,
    phase: createPhase(0),
    environmentEpoch: 0 as EnvironmentEpoch,
    tracker: new ResourceTracker(createResourceBudget()),
    stopSet,
    allowYield: false,
    allowAwait: false,
  });
  return { result, cursor, syntax, origins };
}

function printed(source: string): string {
  const { result } = consume(source);
  if (!result.matched) throw new Error("expected expression to match");
  return printLosslessSequence(result.syntax.children);
}

describe("primary and postfix expressions", () => {
  test.each([
    "value",
    "42",
    "10n",
    "'text'",
    "/value/gu",
    "this",
    "null",
    "true",
    // TypeScript scans `undefined` as a keyword, so it needs listing among the
    // value keywords or no macro can capture an expression that mentions it.
    "undefined",
    "[first, second]",
    "{ first: 1, second }",
    "(first)",
    "`plain`",
    "`value ${item}`",
    "function(value: number) { return value + 1; }",
    "function named() { return 1; }",
    "function* values() { yield 1; }",
    "async function(value: number) { return value; }",
  ])("consumes primary atom %s losslessly", (source) => {
    const { result, cursor } = consume(source);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected success");
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(result.syntax.precedence).toBe(primaryExpressionPrecedence);
    expect(result.cursor.atEnd).toBe(true);
    expect(cursor.index).toBe(0);
  });

  test.each([
    "value.member",
    "value['member']",
    "value.#private",
    "fn(first, second)",
    "fn?.(value)",
    "value?.member",
    "value?.[index]",
    "value.member!(argument)[index]?.next",
    "tag`plain`",
    "tag`value ${item}`",
  ])("consumes complete postfix chain %s", (source) => {
    expect(printed(source)).toBe(source);
  });

  test("stops before caller boundaries without consuming the boundary", () => {
    const stopSet = new StopSet([
      { kind: "token", tokenKind: "punctuation", raw: "." },
    ]);
    const { result } = consume("value.member", stopSet);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected success");
    expect(printLosslessSequence(result.syntax.children)).toBe("value");
    expect(result.cursor.peek()).toMatchObject({ raw: "." });
  });

  test.each([
    ["value.", "property name"],
    ["value?.", "property, index, or call"],
    ["value[]", "expression inside index"],
    ["value?.member`tag`", "tagged template outside"],
    ["()", "identifier, literal"],
    [";", "identifier, literal"],
  ])("rejects malformed extent %s", (source, expectation) => {
    const { result, cursor } = consume(source);
    expect(result.matched).toBe(false);
    if (result.matched) throw new Error("expected failure");
    expect(result.failure.expectations.join(" ")).toContain(expectation);
    expect(cursor.index).toBe(0);
  });

  test("creates a composed origin for multi-node postfix chains", () => {
    const { result, origins } = consume("value.member(argument)");
    if (!result.matched) throw new Error("expected success");
    expect(origins.get(result.syntax.origin)?.kind).toBe("composed");
    expect(origins.collectSourceOrigins(result.syntax.origin)).toHaveLength(4);
  });

  test.each([
    "value",
    "[first, second]",
    "({ first: 1 }).first",
    "fn?.(value)?.result",
    "value.member!(argument)[index]",
    "tag`value ${item}`",
  ])(
    "agrees with TypeScript on complete expression extent: %s",
    (expression) => {
      const output = printed(expression);
      const transpiled = ts.transpileModule(`const result = ${output};`, {
        compilerOptions: { strict: true, target: ts.ScriptTarget.ESNext },
        reportDiagnostics: true,
      });
      expect(
        (transpiled.diagnostics ?? []).filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        ),
      ).toEqual([]);
      expect(output).toBe(expression);
    },
  );
});
