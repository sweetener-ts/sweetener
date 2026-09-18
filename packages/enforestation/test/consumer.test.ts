import { createPhase } from "@sweetener/hygiene";
import {
  CancellationSource,
  createResourceBudget,
  ResourceLimitError,
  ResourceTracker,
  type EnvironmentEpoch,
  type OriginId,
  type ScopeSetId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createProtectedSyntax,
  createSyntaxCursor,
  createToken,
  type SyntaxCategory,
  type SyntaxCursor,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  ConsumerProgressError,
  ConsumerRegistry,
  createConsumerFailure,
  mergeConsumerFailures,
  StopSet,
  type ConsumerContext,
  type SyntaxConsumer,
} from "../src/index.js";

let nextId = 1;
function token(raw: string) {
  return createToken({
    id: nextId++ as SyntaxId,
    span: { start: 0, end: raw.length },
    origin: nextId as OriginId,
    scopes: 0 as ScopeSetId,
    kind: raw === ";" ? "punctuation" : "identifier",
    raw,
    value: raw,
  });
}

function protectedResult(cursor: SyntaxCursor, category: SyntaxCategory) {
  const syntax = cursor.consume();
  if (syntax === undefined) throw new Error("missing syntax");
  return createProtectedSyntax({
    id: nextId++ as SyntaxId,
    span: syntax.span,
    origin: syntax.origin,
    scopes: syntax.scopes,
    category,
    children: [syntax],
  });
}

function context() {
  return {
    phase: createPhase(0),
    environmentEpoch: 4 as EnvironmentEpoch,
    tracker: new ResourceTracker(createResourceBudget()),
    allowYield: false,
    allowAwait: false,
  };
}

function consumer(implementation: SyntaxConsumer["consume"]): SyntaxConsumer {
  return Object.freeze({ consume: implementation });
}

describe("syntax consumer infrastructure", () => {
  test("isolates the input cursor and returns an exact consumed range", () => {
    const input = [token("first"), token("second")];
    const cursor = createSyntaxCursor(input);
    let received: ConsumerContext | undefined;
    const requestContext = context();
    const registry = new ConsumerRegistry([
      {
        category: "expr",
        consumer: consumer((working, consumeContext) => {
          received = consumeContext;
          return Object.freeze({
            matched: true,
            syntax: protectedResult(working, "expr"),
            cursor: working,
          });
        }),
      },
    ]);
    const result = registry.consume("expr", { cursor, ...requestContext });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected success");
    expect(cursor.index).toBe(0);
    expect(result.cursor.index).toBe(1);
    expect(result.consumed.toArray()).toEqual([input[0]]);
    expect(received).toMatchObject({
      category: "expr",
      phase: 0,
      environmentEpoch: 4,
    });
    expect(requestContext.tracker.usage.expansionSteps).toBe(1);
  });

  test("restores failure attempts and normalizes ranked expectations", () => {
    const cursor = createSyntaxCursor([token("value")]);
    const registry = new ConsumerRegistry([
      {
        category: "expr",
        consumer: consumer((working) => {
          working.advance();
          return Object.freeze({
            matched: false,
            failure: createConsumerFailure({
              category: "expr",
              cursor: working.identity,
              progress: 1,
              specificity: 2,
              expectations: ["identifier", "identifier", "literal"],
            }),
          });
        }),
      },
    ]);
    const result = registry.consume("expr", { cursor, ...context() });
    expect(cursor.index).toBe(0);
    expect(result).toMatchObject({
      matched: false,
      failure: { expectations: ["identifier", "literal"] },
    });
  });

  test("honors token, group-independent end, and unioned stop boundaries", () => {
    let calls = 0;
    const registry = new ConsumerRegistry([
      {
        category: "stmt",
        consumer: consumer((working) => {
          calls += 1;
          return Object.freeze({
            matched: true,
            syntax: protectedResult(working, "stmt"),
            cursor: working,
          });
        }),
      },
    ]);
    const semicolon = new StopSet([
      { kind: "token", tokenKind: "punctuation", raw: ";" },
    ]);
    const stops = semicolon.union(new StopSet([{ kind: "end" }]));
    expect(
      registry.consume("stmt", {
        cursor: createSyntaxCursor([token(";")]),
        ...context(),
        stopSet: stops,
      }).matched,
    ).toBe(false);
    expect(
      registry.consume("stmt", {
        cursor: createSyntaxCursor([]),
        ...context(),
        stopSet: stops,
      }).matched,
    ).toBe(false);
    expect(calls).toBe(0);
    expect(semicolon.union(semicolon)).toBe(semicolon);
  });

  test("rejects zero progress, foreign cursors, and wrong protected categories", () => {
    const input = [token("value")];
    const run = (implementation: SyntaxConsumer["consume"]) =>
      new ConsumerRegistry([
        { category: "expr", consumer: consumer(implementation) },
      ]).consume("expr", {
        cursor: createSyntaxCursor(input),
        ...context(),
      });
    expect(() =>
      run((working) =>
        Object.freeze({
          matched: true,
          syntax: createProtectedSyntax({
            id: nextId++ as SyntaxId,
            span: input[0]!.span,
            origin: input[0]!.origin,
            scopes: input[0]!.scopes,
            category: "expr",
            children: input,
          }),
          cursor: working,
        }),
      ),
    ).toThrow(ConsumerProgressError);
    expect(() =>
      run((working) => {
        protectedResult(working, "expr");
        return Object.freeze({
          matched: true,
          syntax: createProtectedSyntax({
            id: nextId++ as SyntaxId,
            span: input[0]!.span,
            origin: input[0]!.origin,
            scopes: input[0]!.scopes,
            category: "expr",
            children: input,
          }),
          cursor: createSyntaxCursor(input).fork(),
        });
      }),
    ).toThrow(ConsumerProgressError);
    expect(() =>
      run((working) =>
        Object.freeze({
          matched: true,
          syntax: protectedResult(working, "stmt"),
          cursor: working,
        }),
      ),
    ).toThrow(/protected stmt/);
  });

  test("charges resources and observes cancellation before callbacks", () => {
    let calls = 0;
    const registry = new ConsumerRegistry([
      {
        category: "expr",
        consumer: consumer((working) => {
          calls += 1;
          return Object.freeze({
            matched: true,
            syntax: protectedResult(working, "expr"),
            cursor: working,
          });
        }),
      },
    ]);
    expect(() =>
      registry.consume("expr", {
        cursor: createSyntaxCursor([token("x")]),
        ...context(),
        tracker: new ResourceTracker(
          createResourceBudget({ maxExpansionSteps: 0 }),
        ),
      }),
    ).toThrow(ResourceLimitError);
    const cancellation = new CancellationSource();
    cancellation.cancel();
    expect(() =>
      registry.consume("expr", {
        cursor: createSyntaxCursor([token("x")]),
        ...context(),
        cancellation: cancellation.token,
      }),
    ).toThrow(/cancelled/);
    expect(calls).toBe(0);
  });

  test("persists registry snapshots and rejects missing or duplicate consumers", () => {
    const expression = consumer((working) =>
      Object.freeze({
        matched: true,
        syntax: protectedResult(working, "expr"),
        cursor: working,
      }),
    );
    const empty = new ConsumerRegistry();
    const populated = empty.withConsumer("expr", expression);
    expect(() =>
      empty.consume("expr", {
        cursor: createSyntaxCursor([token("x")]),
        ...context(),
      }),
    ).toThrow(/No syntax consumer/);
    expect(() => populated.withConsumer("expr", expression)).toThrow(
      /Duplicate/,
    );
    expect(Object.isFrozen(populated)).toBe(true);
  });

  test("merges only farthest, most-specific failures deterministically", () => {
    const failures = [
      createConsumerFailure({
        category: "expr",
        cursor: "1:1:1" as Parameters<
          typeof createConsumerFailure
        >[0]["cursor"],
        progress: 1,
        specificity: 10,
        expectations: ["near"],
      }),
      createConsumerFailure({
        category: "expr",
        cursor: "1:1:2" as Parameters<
          typeof createConsumerFailure
        >[0]["cursor"],
        progress: 2,
        specificity: 4,
        expectations: ["identifier"],
      }),
      createConsumerFailure({
        category: "expr",
        cursor: "1:1:3" as Parameters<
          typeof createConsumerFailure
        >[0]["cursor"],
        progress: 2,
        specificity: 4,
        expectations: ["literal"],
      }),
    ];
    expect(mergeConsumerFailures(failures)).toMatchObject({
      progress: 2,
      specificity: 4,
      cursor: "1:1:2",
      expectations: ["identifier", "literal"],
    });
    expect(mergeConsumerFailures([])).toBeUndefined();
  });
});
