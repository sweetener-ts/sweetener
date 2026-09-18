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

/**
 * How far an arrow reaches, which this consumer measures from the arrow's head
 * rather than from the operand before its `=>`.
 *
 * The infix `=>` reads an arrow by protecting what stands to its left as the
 * parameters, so it reads exactly the heads that are one operand and then
 * `=>`: `v => …` and `(v) => …`. Every other head has to be measured here. In
 * `async v => …` the head is two operands and only the name would stand to the
 * arrow's left, so that route dropped the `async`, the statement holding the
 * arrow did not parse, and the block fell back to a raw token walk.
 */
describe("arrow extent", () => {
  test.each([
    "async v => v + 1",
    "async v => { return v; }",
    "async v => async w => v + w",
    "async (v) => v + 1",
    "() => {}",
    "<T,>(value: T) => { return value; }",
    // A return type stands between the parameters and the `=>`, so the `=>` is
    // not beside the operand the infix route would protect.
    "(x: number): number => { return x; }",
    "async (): Promise<number> => { return 1; }",
  ])("measures %s as one arrow", (source) => {
    const { result } = consume(source);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected an arrow");
    expect(result.syntax.form).toBe("arrow");
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(result.cursor.atEnd).toBe(true);
  });

  test.each([
    // The infix `=>` reads these, and reads the body the same way.
    ["v => v + 1", "v"],
    ["(x: number) => { return x; }", "(x: number)"],
    // An arrow whose one parameter is itself named `async`.
    ["async => async", "async"],
    // `async` modifies what is written on its own line; with a line break
    // after it, it is an ordinary name and the arrow is the one after it.
    ["async\nv => v", "async"],
    // TypeScript reads this one as the call it looks like, and then reports
    // the `=>` after it.
    ["async\n(v) => v", "async\n(v)"],
    // `async` standing as an ordinary name.
    ["async(1)", "async(1)"],
    ["async + 1", "async"],
    ["async.then", "async.then"],
  ])("leaves %s to the surrounding parse, taking %s", (source, taken) => {
    const { result } = consume(source);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected an expression");
    expect(result.syntax.form).toBeUndefined();
    expect(printLosslessSequence(result.syntax.children)).toBe(taken);
  });

  test.each([
    "async v => v + 1",
    "async v => ({ v })",
    "async (v) => v + 1",
    "(x: number): number => { return x; }",
    "async (): Promise<number> => { return 1; }",
  ])("agrees with TypeScript on the extent of %s", (expression) => {
    const output = printed(expression);
    const transpiled = ts.transpileModule(`const result = ${output};`, {
      compilerOptions: { strict: false, target: ts.ScriptTarget.ESNext },
      reportDiagnostics: true,
    });
    expect(
      (transpiled.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ),
    ).toEqual([]);
    expect(output).toBe(expression);
  });
});
