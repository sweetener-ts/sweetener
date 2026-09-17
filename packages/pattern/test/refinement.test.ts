import type {
  CaptureId,
  CardinalityGroupId,
  OriginId,
  ScopeSetId,
  SyntaxClassId,
  SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
  createProtectedSyntax,
  createSpan,
  createToken,
} from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  CaptureRecord,
  createCaptureLeaf,
  createCaptureSequence,
  createRefinement,
  describeRefinement,
  evaluateRefinement,
  evaluateRefinements,
} from "../src/index.js";

const capture = 1 as CaptureId;
const classId = 2 as SyntaxClassId;
const origin = 3 as OriginId;
const scopes = 0 as ScopeSetId;
let syntaxId = 1;

function token(raw: string, kind: "identifier" | "punctuation" = "identifier") {
  return createToken({
    id: syntaxId++ as SyntaxId,
    span: createSpan(syntaxId * 2, syntaxId * 2 + raw.length),
    origin,
    scopes,
    kind,
    raw,
    value: kind === "identifier" ? raw : undefined,
  });
}

function leaf(raw: string) {
  return createCaptureLeaf({
    id: capture,
    classId,
    syntax: Object.freeze([token(raw)]),
    origin,
  });
}

function record(raw: string) {
  return new CaptureRecord([[capture, leaf(raw)]]);
}

describe("declarative refinements", () => {
  it("evaluates token kind, spelling sets, and Unicode identifier case", () => {
    const captures = record("alpha");
    expect(
      evaluateRefinements(
        [
          createRefinement(capture, {
            kind: "token-kind",
            tokenKinds: ["identifier"],
          }),
          createRefinement(capture, {
            kind: "spelling-in",
            spellings: ["beta", "alpha", "alpha"],
          }),
          createRefinement(capture, { kind: "starts-with-lowercase" }),
        ],
        captures,
      ),
    ).toBe(true);
    expect(
      evaluateRefinement(
        createRefinement(capture, { kind: "starts-with-uppercase" }),
        record("Éclair"),
      ),
    ).toBe(true);
    expect(
      evaluateRefinement(
        createRefinement(capture, {
          kind: "spelling-equals",
          spelling: "other",
        }),
        captures,
      ),
    ).toBe(false);
  });

  it("evaluates repetition lengths and every repeated leaf", () => {
    const sequence = createCaptureSequence({
      depth: 1,
      cardinalityGroup: 4 as CardinalityGroupId,
      elements: [leaf("a"), leaf("b")],
    });
    const captures = new CaptureRecord([[capture, sequence]]);
    expect(
      evaluateRefinement(
        createRefinement(capture, {
          kind: "repetition-length",
          comparison: "at-least",
          length: 2,
        }),
        captures,
      ),
    ).toBe(true);
    expect(
      evaluateRefinement(
        createRefinement(capture, { kind: "starts-with-lowercase" }),
        captures,
      ),
    ).toBe(true);
  });

  it("evaluates delimiter facts", () => {
    const open = token("(", "punctuation");
    const close = token(")", "punctuation");
    const grouped = createGroup({
      id: syntaxId++ as SyntaxId,
      span: createSpan(open.span.start, close.span.end),
      origin,
      scopes,
      delimiter: "parenthesis",
      open,
      children: [],
      close,
    });
    const captures = new CaptureRecord([
      [
        capture,
        createCaptureLeaf({
          id: capture,
          classId,
          syntax: Object.freeze([grouped]),
          origin,
        }),
      ],
    ]);
    expect(
      evaluateRefinement(
        createRefinement(capture, {
          kind: "delimiter",
          delimiter: "parenthesis",
        }),
        captures,
      ),
    ).toBe(true);
  });

  it("rejects malformed fixed predicates", () => {
    expect(() =>
      createRefinement(capture, { kind: "token-kind", tokenKinds: [] }),
    ).toThrow(/at least one/);
    expect(() =>
      createRefinement(capture, {
        kind: "repetition-length",
        comparison: "equal",
        length: -1,
      }),
    ).toThrow(/non-negative/);
  });
  it("tells apart the forms of a captured expression", () => {
    const expression = (form?: "conditional" | "arrow") =>
      new CaptureRecord([
        [
          capture,
          createCaptureLeaf({
            id: capture,
            classId,
            syntax: Object.freeze([
              createProtectedSyntax({
                id: syntaxId++ as SyntaxId,
                span: createSpan(0, 1),
                origin,
                scopes,
                category: "expr",
                form,
                children: [token("a"), token("?", "punctuation"), token("b")],
              }),
            ]),
            origin,
          }),
        ],
      ]);
    const excluded = createRefinement(capture, {
      kind: "expression-form",
      forms: ["conditional", "arrow"],
      excluded: true,
    });
    const included = createRefinement(capture, {
      kind: "expression-form",
      forms: ["conditional"],
      excluded: false,
    });
    expect(evaluateRefinement(excluded, expression())).toBe(true);
    expect(evaluateRefinement(excluded, expression("conditional"))).toBe(false);
    expect(evaluateRefinement(included, expression("conditional"))).toBe(true);
    expect(evaluateRefinement(included, expression("arrow"))).toBe(false);
    // A token capture is no expression, and has no form to exclude.
    expect(evaluateRefinement(excluded, record("alpha"))).toBe(true);
    expect(describeRefinement(excluded.predicate)).toBe(
      "an expression that is not an unparenthesized arrow function or an unparenthesized conditional",
    );
  });
});
