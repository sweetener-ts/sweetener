import type {
  CaptureId,
  CardinalityGroupId,
  OriginId,
  RepetitionId,
  RuleId,
  ScopeSetId,
  SourceId,
  SyntaxClassId,
  SyntaxId,
} from "@sweetener/shared";
import { createSpan, createToken, type SyntaxCursor } from "@sweetener/syntax";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as captureRecord from "../src/capture-record.js";
import {
  compileMatcherProgram,
  createCapturePattern,
  createLiteralPattern,
  createRepeatPattern,
  createSequencePattern,
  createTokenLiteralKey,
  executeMatcher,
  inferCaptureShapes,
  type PatternNode,
} from "../src/index.js";

// Count the capture sequences the matcher builds, and the elements it puts in
// them, without changing what it builds.
vi.mock("../src/capture-record.js", async (importOriginal) => {
  const actual = await importOriginal<typeof captureRecord>();
  return {
    ...actual,
    createCaptureSequence: vi.fn(actual.createCaptureSequence),
  };
});

const built = vi.mocked(captureRecord.createCaptureSequence);

const origin = 1 as OriginId;
const identClass = 2 as SyntaxClassId;
let nextSyntaxId = 1;

function identifier(raw: string) {
  const start = nextSyntaxId * 2;
  return createToken({
    id: nextSyntaxId++ as SyntaxId,
    span: createSpan(start, start + raw.length),
    origin,
    scopes: 0 as ScopeSetId,
    kind: "identifier",
    raw,
    value: raw,
  });
}

function names(count: number) {
  return Array.from({ length: count }, (_, index) =>
    identifier(`name${String(index)}`),
  );
}

const consumeIdent = (classId: SyntaxClassId, cursor: SyntaxCursor) => {
  const syntax = cursor.peek();
  if (classId !== identClass || syntax?.tag !== "token") return undefined;
  if (syntax.kind !== "identifier") return undefined;
  cursor.advance();
  return Object.freeze({
    cursor,
    syntax: Object.freeze([syntax]),
    origin: syntax.origin,
  });
};

/** `$($item:ident)*` followed by the given names as literals. */
function repetitionThen(...after: readonly string[]): PatternNode {
  return createSequencePattern(origin, [
    createRepeatPattern({
      origin,
      repetition: 3 as RepetitionId,
      body: createCapturePattern({
        origin,
        capture: 4 as CaptureId,
        name: "item",
        classId: identClass,
      }),
      minimum: 0,
      depth: 1,
      cardinalityGroup: 5 as CardinalityGroupId,
    }),
    ...after.map((raw) =>
      createLiteralPattern(origin, createTokenLiteralKey("identifier", raw)),
    ),
  ]);
}

function match(pattern: PatternNode, input: ReturnType<typeof names>) {
  const inference = inferCaptureShapes(pattern, {
    sourceId: 6 as SourceId,
    spanForOrigin: () => ({ start: 0, end: 1 }),
  });
  expect(inference.diagnostics).toEqual([]);
  return executeMatcher(
    compileMatcherProgram(pattern, { rule: 7 as RuleId, inference }),
    input,
    { consumeClass: consumeIdent },
  );
}

function builtElements(): number {
  return built.mock.calls.reduce(
    (total, [options]) => total + options.elements.length,
    0,
  );
}

describe("matcher capture sequences", () => {
  beforeEach(() => {
    built.mockClear();
  });

  // A greedy repetition offers an exit after each of its k iterations and
  // tries them from the last. Building an exit's sequences when it was tried,
  // before the literal after the repetition failed it, built k sequences of
  // up to k elements: 4,000 declarations took 15 s to expand.
  it("builds no sequence for exits that fail", () => {
    const result = match(repetitionThen("never"), names(2_000));
    expect(result.matched).toBe(false);
    expect(built).not.toHaveBeenCalled();
  });

  it("builds the sequences of the exit the match takes, once", () => {
    const input = [...names(2_000), identifier("end"), identifier("end")];
    const result = match(repetitionThen("end", "end"), input);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected match");
    expect(built).toHaveBeenCalledTimes(1);
    expect(builtElements()).toBe(2_000);
    const captured = result.captures.get(4 as CaptureId);
    if (captured?.kind !== "sequence") throw new Error("expected a sequence");
    expect(
      captured.elements.map(
        (element) => element.kind === "leaf" && element.syntax[0],
      ),
    ).toEqual(input.slice(0, 2_000));
  });
});
