import {
  CancellationSource,
  createResourceBudget,
  ResourceLimitError,
  type CaptureId,
  type CardinalityGroupId,
  type OriginId,
  type RepetitionId,
  type RuleId,
  type ScopeSetId,
  type SourceId,
  type SyntaxClassId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
  createSpan,
  createToken,
  type Syntax,
  type SyntaxCursor,
  type TokenSyntax,
} from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  compileMatcherProgram,
  createCapturePattern,
  createClassCallPattern,
  createChoicePattern,
  createGroupPattern,
  createLiteralPattern,
  createRepeatPattern,
  createSequencePattern,
  createTokenLiteralKey,
  executeMatcher,
  inferCaptureShapes,
  type MatcherResult,
  type PatternNode,
} from "../src/index.js";

const sourceId = 1 as SourceId;
const scopes = 0 as ScopeSetId;
const origin = 2 as OriginId;
const rule = 3 as RuleId;
const identClass = 4 as SyntaxClassId;
const captureId = 5 as CaptureId;
let nextSyntaxId = 1;

function token(raw: string, kind: TokenSyntax["kind"] = "punctuation") {
  const start = nextSyntaxId * 2;
  return createToken({
    id: nextSyntaxId++ as SyntaxId,
    span: createSpan(start, start + raw.length),
    origin,
    scopes,
    kind,
    raw,
    value: kind === "identifier" ? raw : undefined,
  });
}

function identifier(raw: string) {
  return token(raw, "identifier");
}

function group(children: readonly Syntax[]) {
  const open = token("(");
  const close = token(")");
  return createGroup({
    id: nextSyntaxId++ as SyntaxId,
    span: createSpan(open.span.start, close.span.end),
    origin,
    scopes,
    delimiter: "parenthesis",
    open,
    children,
    close,
  });
}

function literal(raw: string) {
  return createLiteralPattern(
    origin,
    createTokenLiteralKey("punctuation", raw),
  );
}

function capture(name = "item") {
  return createCapturePattern({
    origin,
    capture: captureId,
    name,
    classId: identClass,
  });
}

function program(pattern: PatternNode) {
  const inference = inferCaptureShapes(pattern, {
    sourceId,
    spanForOrigin: () => ({ start: 0, end: 1 }),
  });
  expect(inference.diagnostics).toEqual([]);
  return compileMatcherProgram(pattern, { rule, inference });
}

const consumeIdent = (classId: SyntaxClassId, cursor: SyntaxCursor) => {
  if (classId !== identClass || cursor.peek()?.tag !== "token")
    return undefined;
  const syntax = cursor.peek();
  if (syntax?.tag !== "token" || syntax.kind !== "identifier") return undefined;
  cursor.advance();
  return Object.freeze({
    cursor,
    syntax: Object.freeze([syntax]),
    origin: syntax.origin,
  });
};

function match(pattern: PatternNode, input: readonly Syntax[]): MatcherResult {
  return executeMatcher(program(pattern), input, {
    consumeClass: consumeIdent,
  });
}

describe("matcher virtual machine", () => {
  it("matches literals and returns the unconsumed cursor", () => {
    const result = match(literal("a"), [token("a"), token("b")]);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected match");
    expect(result.cursor.index).toBe(1);
    expect(result.cursor.peek()).toMatchObject({ raw: "b" });
    expect(result.captures.size).toBe(0);
  });

  it("rolls back cursor state when an earlier choice fails", () => {
    const pattern = createChoicePattern(origin, [
      createSequencePattern(origin, [literal("a"), literal("missing")]),
      createSequencePattern(origin, [literal("a"), literal("b")]),
    ]);
    const result = match(pattern, [token("a"), token("b")]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.cursor.atEnd).toBe(true);
  });

  it("requires a nested group body to consume the complete group", () => {
    const pattern = createGroupPattern(
      origin,
      "parenthesis",
      createSequencePattern(origin, [literal("a")]),
    );
    expect(match(pattern, [group([token("a")])]).matched).toBe(true);
    expect(match(pattern, [group([token("a"), token("b")])]).matched).toBe(
      false,
    );
  });

  it("captures greedy separated repetition and rolls back its final separator attempt", () => {
    const repeated = createRepeatPattern({
      origin,
      repetition: 10 as RepetitionId,
      body: capture(),
      separator: literal(","),
      minimum: 0,
      depth: 1,
      cardinalityGroup: 11 as CardinalityGroupId,
    });
    const result = match(repeated, [
      identifier("a"),
      token(","),
      identifier("b"),
      token(","),
      identifier("c"),
    ]);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected match");
    expect(result.cursor.atEnd).toBe(true);
    expect(result.captures.get(captureId)).toMatchObject({
      kind: "sequence",
      depth: 1,
      cardinalityGroup: 11,
      elements: [
        { kind: "leaf", syntax: [{ raw: "a" }] },
        { kind: "leaf", syntax: [{ raw: "b" }] },
        { kind: "leaf", syntax: [{ raw: "c" }] },
      ],
    });
  });

  it("takes an exit a greedy repetition passed with the values it had then", () => {
    const end = createLiteralPattern(
      origin,
      createTokenLiteralKey("identifier", "end"),
    );
    const pattern = createSequencePattern(origin, [
      createRepeatPattern({
        origin,
        repetition: 12 as RepetitionId,
        body: capture(),
        minimum: 0,
        depth: 1,
        cardinalityGroup: 13 as CardinalityGroupId,
      }),
      end,
      end,
    ]);
    // The repetition reads all four names, and the match backs out of the
    // last two iterations to let the literals have them.
    const result = match(pattern, [
      identifier("a"),
      identifier("b"),
      identifier("end"),
      identifier("end"),
    ]);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected match");
    expect(result.cursor.atEnd).toBe(true);
    expect(result.captures.get(captureId)).toMatchObject({
      kind: "sequence",
      elements: [
        { kind: "leaf", syntax: [{ raw: "a" }] },
        { kind: "leaf", syntax: [{ raw: "b" }] },
      ],
    });
  });

  // Each iteration used to copy every value captured before it, and build the
  // whole sequence again for the exit it offered, so a repetition this long
  // held hundreds of millions of copied values.
  it("captures a long repetition in order", () => {
    const names = Array.from({ length: 20_000 }, (_, index) =>
      identifier(`name${String(index)}`),
    );
    const result = match(
      createRepeatPattern({
        origin,
        repetition: 14 as RepetitionId,
        body: capture(),
        minimum: 0,
        depth: 1,
        cardinalityGroup: 15 as CardinalityGroupId,
      }),
      names,
    );
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected match");
    const captured = result.captures.get(captureId);
    if (captured?.kind !== "sequence") throw new Error("expected a sequence");
    expect(
      captured.elements.map(
        (element) => element.kind === "leaf" && element.syntax[0],
      ),
    ).toEqual(names);
  });

  /** `$($($item:ident)+)+` followed by `end`, unseparated at both levels. */
  function nestedUnseparated(): PatternNode {
    const inner = createRepeatPattern({
      origin,
      repetition: 30 as RepetitionId,
      body: capture(),
      minimum: 1,
      depth: 2,
      cardinalityGroup: 31 as CardinalityGroupId,
    });
    const outer = createRepeatPattern({
      origin,
      repetition: 32 as RepetitionId,
      body: inner,
      minimum: 1,
      depth: 1,
      cardinalityGroup: 33 as CardinalityGroupId,
    });
    return createSequencePattern(origin, [outer, literal("end")]);
  }

  it("fails nested repetitions without trying every split of the input", () => {
    // Every way of grouping forty names into runs fails at the missing
    // `end`; a failure keyed on how many each run captured stood for one
    // grouping alone, and every one of them was tried.
    const names = Array.from({ length: 40 }, (_, at) => identifier(`n${at}`));
    const result = executeMatcher(
      program(nestedUnseparated()),
      [...names, token("wrong")],
      {
        consumeClass: consumeIdent,
        budget: createResourceBudget({ maxMatcherSteps: 100_000 }),
      },
    );
    expect(result.matched).toBe(false);
  });

  it("still matches nested repetitions greedily, the first split first", () => {
    const result = match(nestedUnseparated(), [
      identifier("a"),
      identifier("b"),
      identifier("c"),
      token("end"),
    ]);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected match");
    expect(result.captures.get(captureId)).toMatchObject({
      kind: "sequence",
      depth: 2,
      elements: [{ kind: "sequence", depth: 1, elements: [{}, {}, {}] }],
    });
  });

  it("materializes empty and nested capture dimensions", () => {
    const inner = createRepeatPattern({
      origin,
      repetition: 20 as RepetitionId,
      body: capture(),
      separator: literal(","),
      minimum: 1,
      depth: 2,
      cardinalityGroup: 21 as CardinalityGroupId,
    });
    const outer = createRepeatPattern({
      origin,
      repetition: 22 as RepetitionId,
      body: inner,
      separator: literal(";"),
      minimum: 0,
      depth: 1,
      cardinalityGroup: 23 as CardinalityGroupId,
    });
    const empty = match(outer, []);
    expect(empty.matched).toBe(true);
    if (empty.matched) {
      expect(empty.captures.get(captureId)).toMatchObject({
        kind: "sequence",
        depth: 2,
        elements: [],
      });
    }

    const nested = match(outer, [
      identifier("a"),
      token(","),
      identifier("b"),
      token(";"),
      identifier("c"),
    ]);
    expect(nested.matched).toBe(true);
    if (nested.matched) {
      expect(nested.cursor.atEnd).toBe(true);
      expect(nested.captures.get(captureId)).toMatchObject({
        kind: "sequence",
        depth: 2,
        elements: [
          { kind: "sequence", depth: 1, elements: [{}, {}] },
          { kind: "sequence", depth: 1, elements: [{}] },
        ],
      });
    }
  });

  it("enforces matcher-step budgets and cancellation", () => {
    expect(() =>
      executeMatcher(program(literal("a")), [token("a")], {
        consumeClass: consumeIdent,
        budget: createResourceBudget({ maxMatcherSteps: 0 }),
      }),
    ).toThrow(ResourceLimitError);

    const grouped = createGroupPattern(
      origin,
      "parenthesis",
      createSequencePattern(origin, [literal("a")]),
    );
    expect(() =>
      executeMatcher(program(grouped), [group([token("a")])], {
        consumeClass: consumeIdent,
        budget: createResourceBudget({ maxNestingDepth: 0 }),
      }),
    ).toThrow(ResourceLimitError);

    const source = new CancellationSource();
    source.cancel();
    expect(() =>
      executeMatcher(program(literal("a")), [token("a")], {
        consumeClass: consumeIdent,
        cancellation: source.token,
      }),
    ).toThrow(/cancelled/);
  });

  it("ranks the farthest failure and merges equal-position expectations", () => {
    const merged = createChoicePattern(origin, [
      createSequencePattern(origin, [literal("a"), literal("b")]),
      createSequencePattern(origin, [literal("a"), literal("c")]),
    ]);
    const mergedResult = match(merged, [token("a"), token("x")]);
    expect(mergedResult.matched).toBe(false);
    if (mergedResult.matched) throw new Error("expected failure");
    expect(
      mergedResult.failure?.expectations.map((expectation) =>
        expectation.kind === "literal" && expectation.literal.kind === "token"
          ? expectation.literal.raw
          : expectation.kind,
      ),
    ).toEqual(["b", "c"]);

    const farthest = createChoicePattern(origin, [
      createSequencePattern(origin, [literal("a"), literal("b"), literal("c")]),
      createSequencePattern(origin, [literal("a"), literal("x")]),
    ]);
    const farthestResult = match(farthest, [
      token("a"),
      token("b"),
      token("wrong"),
    ]);
    expect(farthestResult.matched).toBe(false);
    if (farthestResult.matched) throw new Error("expected failure");
    expect(farthestResult.failure?.expectations).toMatchObject([
      { kind: "literal", literal: { raw: "c" } },
    ]);
  });

  it("records expectation specificity and memoizes converged failed states", () => {
    const specificity = createChoicePattern(origin, [
      createClassCallPattern(origin, identClass),
      literal("expected"),
    ]);
    const specificResult = match(specificity, [token("wrong")]);
    expect(specificResult.matched).toBe(false);
    if (specificResult.matched) throw new Error("expected failure");
    expect(specificResult.failure).toMatchObject({
      specificity: 4,
      expectations: [{ kind: "class" }, { kind: "literal" }],
    });

    const converged = createSequencePattern(origin, [
      createChoicePattern(origin, [literal("a"), literal("a")]),
      literal("end"),
    ]);
    const memoized = match(converged, [token("a"), token("wrong")]);
    expect(memoized.matched).toBe(false);
    if (memoized.matched) throw new Error("expected failure");
    expect(memoized.memoizedFailureCount).toBe(1);
    expect(memoized.failure?.expectations).toMatchObject([
      { kind: "literal", literal: { raw: "end" } },
    ]);
  });

  it("validates the environment epoch used in memo keys", () => {
    expect(() =>
      executeMatcher(program(literal("a")), [token("a")], {
        consumeClass: consumeIdent,
        environmentEpoch: -1,
      }),
    ).toThrow(/Environment epoch/);
  });

  it("passes the following literal to external syntax consumers as a boundary", () => {
    const pattern = createSequencePattern(origin, [
      capture(),
      literal("-"),
      literal(">"),
    ]);
    const input = [identifier("value"), token("-"), token(">")];
    const observed: string[][] = [];
    const result = executeMatcher(program(pattern), input, {
      consumeClass: (classId, cursor, boundary) => {
        observed.push([...(boundary?.stopTokens ?? [])]);
        return consumeIdent(classId, cursor);
      },
    });
    expect(result.matched).toBe(true);
    expect(observed).toEqual([["-"]]);
  });
});
