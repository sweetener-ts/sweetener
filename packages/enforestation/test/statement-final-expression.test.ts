import { createPhase } from "@sweetener/hygiene";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
import {
  CancellationSource,
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
  consumeStatementPrefixFinalExpression,
  createPrattExpressionConsumer,
  createStatementConsumer,
  StopSet,
} from "../src/index.js";

const sourceId = 127 as SourceId;

function setup(source: string) {
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
  const ids = createIdAllocator<SyntaxId>(70_000);
  const shared = { origins, allocateSyntaxId: ids.allocate };
  const expression = createPrattExpressionConsumer({
    ...shared,
    allowComma: true,
  });
  const statement = createStatementConsumer(shared);
  const tracker = new ResourceTracker(createResourceBudget());
  const context = Object.freeze({
    category: "tt" as const,
    phase: createPhase(0),
    environmentEpoch: 0 as EnvironmentEpoch,
    stopSet: StopSet.empty,
    tracker,
    allowYield: false,
    cancellation: Object.freeze({
      isCancellationRequested: false,
      throwIfCancellationRequested() {},
    }),
  });
  const cursor = createSyntaxCursor(syntax);
  const result = consumeStatementPrefixFinalExpression(cursor, context, {
    ...shared,
    expression,
    statement,
  });
  return { result, cursor, syntax, context, shared, expression, statement };
}

function diagnostics(source: string) {
  return (
    ts.createSourceFile(
      "implicit.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
}

describe("statement-prefix/final-expression composition", () => {
  test("splits the implicit-return acceptance body", () => {
    const source = "const doubled = value * 2;\ndoubled + 1";
    const { result, cursor } = setup(source);
    expect(result.matched).toBe(true);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(result.skeleton.completion).toBe("implicit-expression");
    expect(result.skeleton.statements).toHaveLength(1);
    expect(printLosslessSequence(result.skeleton.statements[0]!.children)).toBe(
      "const doubled = value * 2;",
    );
    expect(
      printLosslessSequence(result.skeleton.finalExpression!.children),
    ).toBe("\ndoubled + 1");
    expect(printLosslessSequence(result.skeleton.syntax.children)).toBe(source);
    expect(result.cursor.atEnd).toBe(true);
    expect(cursor.index).toBe(0);
    expect(
      diagnostics(
        `function calculate(value: number) { const doubled = value * 2; return doubled + 1; }`,
      ),
    ).toEqual([]);
  });

  test("accepts zero prefix statements", () => {
    const { result } = setup("value * 2");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected composition");
    expect(result.skeleton.statements).toEqual([]);
    expect(result.skeleton.finalExpression).toBeDefined();
  });

  test.each(["return value;", "return;"])(
    "preserves a final explicit return %s",
    (source) => {
      const { result } = setup(source);
      expect(result.matched).toBe(true);
      if (!result.matched) throw new Error("expected explicit return");
      expect(result.skeleton.completion).toBe("explicit-return");
      expect(result.skeleton.explicitReturn).toBeDefined();
      expect(result.skeleton.finalExpression === undefined).toBe(
        source === "return;",
      );
      expect(printLosslessSequence(result.skeleton.syntax.children)).toBe(
        source,
      );
    },
  );

  test("keeps an earlier return in the prefix when a final expression follows", () => {
    const { result } = setup("if (stop) return 0;\nvalue");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected composition");
    expect(result.skeleton.completion).toBe("implicit-expression");
    expect(result.skeleton.statements).toHaveLength(1);
    expect(
      printLosslessSequence(result.skeleton.finalExpression!.children),
    ).toBe("\nvalue");
  });

  test("uses ASI to separate a prefix expression statement", () => {
    const { result } = setup("first()\nsecond()");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected composition");
    expect(result.skeleton.statements).toHaveLength(1);
    expect(printLosslessSequence(result.skeleton.statements[0]!.children)).toBe(
      "first()",
    );
    expect(
      printLosslessSequence(result.skeleton.finalExpression!.children),
    ).toBe("\nsecond()");
  });

  test("does not split a continued expression at a line break", () => {
    const { result } = setup("first +\nsecond");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected expression");
    expect(result.skeleton.statements).toEqual([]);
    expect(
      printLosslessSequence(result.skeleton.finalExpression!.children),
    ).toBe("first +\nsecond");
  });

  test.each(["", "const value = 1;", "value;"])(
    "rejects a body without a final value: %j",
    (source) => {
      const { result, cursor } = setup(source);
      expect(result.matched).toBe(false);
      if (result.matched) throw new Error("expected failure");
      expect(result.failure.expectations).toEqual([
        "final expression or return statement",
      ]);
      expect(cursor.index).toBe(0);
    },
  );

  test("propagates cancellation without publishing a partial skeleton", () => {
    const prepared = setup("const value = 1;\nvalue");
    const cancellation = new CancellationSource();
    cancellation.cancel();
    expect(() =>
      consumeStatementPrefixFinalExpression(
        prepared.cursor,
        { ...prepared.context, cancellation: cancellation.token },
        {
          ...prepared.shared,
          expression: prepared.expression,
          statement: prepared.statement,
        },
      ),
    ).toThrow("Operation cancelled");
    expect(prepared.cursor.index).toBe(0);
  });
});
