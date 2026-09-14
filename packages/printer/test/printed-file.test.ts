import {
  createIdAllocator,
  type CaptureId,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
  createPrecedence,
  createProtectedSyntax,
  createToken,
  OriginStore,
  type Syntax,
  type TokenSyntax,
} from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  createExpansionTraceEnvelope,
  printExpandedFile,
  serializeExpansionTrace,
} from "../src/index.js";

const sourceId = 920 as SourceId;
const scopes = 0 as ScopeSetId;
const syntaxIds = createIdAllocator<SyntaxId>(920);

describe("expanded TypeScript printing", () => {
  test("groups protected expressions and maps every generated range", () => {
    const origins = new OriginStore();
    const leftOrigin = origins.source(sourceId, { start: 0, end: 1 });
    const rightSource = origins.source(sourceId, { start: 4, end: 5 });
    const rightOrigin = origins.copied(1 as CaptureId, rightSource);
    const left = createToken({
      id: syntaxIds.allocate(),
      span: { start: 0, end: 1 },
      origin: leftOrigin,
      scopes,
      kind: "identifier",
      raw: "a",
      value: "a",
      leadingTrivia: [],
    });
    const right = createToken({
      id: syntaxIds.allocate(),
      span: { start: 4, end: 5 },
      origin: rightOrigin,
      scopes,
      kind: "identifier",
      raw: "b",
      value: "b",
      leadingTrivia: [],
    });
    const protectedExpression = createProtectedSyntax({
      id: syntaxIds.allocate(),
      span: { start: 0, end: 5 },
      origin: origins.composed([leftOrigin, rightOrigin]),
      scopes,
      category: "expr",
      children: [left, right],
    });
    const result = printExpandedFile({
      syntax: [protectedExpression],
      origins,
      trace: { rule: 2, macro: "pair" },
      groupProtectedExpression: ({ id }) => id === protectedExpression.id,
    });
    // Two identifiers hold no operator, so nothing around them can re-bind and
    // no parentheses are needed. They would lex as one word, so a separator is
    // printed between them and mapped as its own synthesized region.
    expect(result.text).toBe("a b");
    expect(result.originMap.entries).toMatchObject([
      { generatedStart: 0, generatedEnd: 1, kind: "source" },
      { generatedStart: 1, generatedEnd: 2, kind: "synthesized" },
      { generatedStart: 2, generatedEnd: 3, kind: "copied" },
    ]);
  });

  test("never parenthesizes a protected expression of one token", () => {
    const origins = new OriginStore();
    const origin = origins.source(sourceId, { start: 0, end: 5 });
    const token = createToken({
      id: syntaxIds.allocate(),
      span: { start: 0, end: 5 },
      origin,
      scopes,
      kind: "identifier",
      raw: "value",
      value: "value",
      leadingTrivia: [],
    });
    const expression = createProtectedSyntax({
      id: syntaxIds.allocate(),
      span: token.span,
      origin,
      scopes,
      category: "expr",
      children: [token],
    });
    // `{ (value) }` is not an object literal member, so a lone token must print
    // bare however the host would answer for a compound expression.
    expect(
      printExpandedFile({
        syntax: [expression],
        origins,
        trace: [],
        groupProtectedExpression: () => true,
      }).text,
    ).toBe("value");
  });

  test("separates only tokens that would otherwise lex as one", () => {
    const origins = new OriginStore();
    const origin = origins.source(sourceId, { start: 0, end: 1 });
    const token = (raw: string, kind: "identifier" | "punctuation") =>
      createToken({
        id: syntaxIds.allocate(),
        span: { start: 0, end: raw.length },
        origin,
        scopes,
        kind,
        raw,
        value: kind === "identifier" ? raw : undefined,
        leadingTrivia: [],
      });
    const print = (...syntax: readonly TokenSyntax[]) =>
      printExpandedFile({ syntax, origins, trace: [] }).text;

    expect(
      print(token("typeof", "identifier"), token("value", "identifier")),
    ).toBe("typeof value");
    // Punctuation that came from source was already adjacent and round-trips,
    // including the `>` the reader splits for nested type arguments.
    expect(print(token(">", "punctuation"), token(">", "punctuation"))).toBe(
      ">>",
    );
    expect(print(token("value", "identifier"), token(".", "punctuation"))).toBe(
      "value.",
    );
  });

  test("reports where each token's own text landed", () => {
    const origins = new OriginStore();
    const origin = origins.source(sourceId, { start: 0, end: 5 });
    const first = createToken({
      id: syntaxIds.allocate(),
      span: { start: 0, end: 5 },
      origin,
      scopes,
      kind: "identifier",
      raw: "value",
      value: "value",
      leadingTrivia: [],
    });
    const second = createToken({
      id: syntaxIds.allocate(),
      span: { start: 6, end: 11 },
      origin,
      scopes,
      kind: "identifier",
      raw: "other",
      value: "other",
      leadingTrivia: [
        {
          kind: "whitespace",
          raw: " ",
          span: { start: 5, end: 6 },
          hasLineBreak: false,
        },
      ],
    });
    const result = printExpandedFile({
      syntax: [first, second],
      origins,
      trace: [],
    });
    expect(result.text).toBe("value other");
    // Trivia belongs to the token but not to the span a parser would report.
    expect(result.tokenSpans).toEqual([
      { syntax: first.id, start: 0, end: 5 },
      { syntax: second.id, start: 6, end: 11 },
    ]);
  });

  test("uses the host precedence decision for each protected expression", () => {
    const origins = new OriginStore();
    const origin = origins.source(sourceId, { start: 0, end: 3 });
    const token = (raw: string, start: number) =>
      createToken({
        id: syntaxIds.allocate(),
        span: { start, end: start + raw.length },
        origin,
        scopes,
        kind: "identifier",
        raw,
        value: raw,
        leadingTrivia: [],
      });
    const expression = createProtectedSyntax({
      id: syntaxIds.allocate(),
      span: { start: 0, end: 3 },
      origin,
      scopes,
      category: "expr",
      children: [token("a", 0), token("b", 2)],
    });
    expect(
      printExpandedFile({
        syntax: [expression],
        origins,
        trace: [],
        groupProtectedExpression: () => false,
      }).text,
    ).toBe("a b");
  });

  test("serializes traces with stable key order and rejects unsafe values", () => {
    expect(serializeExpansionTrace({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{\n  "a": {\n    "b": 3,\n    "y": 2\n  },\n  "z": 1\n}\n',
    );
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeExpansionTrace(cyclic)).toThrow(/cyclic/);
    expect(() => serializeExpansionTrace({ value: Number.NaN })).toThrow(
      /finite/,
    );
  });

  test("versions the public expansion trace envelope", () => {
    const envelope = createExpansionTraceEnvelope([{ invocationId: 1 }]);
    expect(envelope).toEqual({
      schemaVersion: 1,
      events: [{ invocationId: 1 }],
    });
    expect(Object.isFrozen(envelope)).toBe(true);
  });
});

describe("trivia regions", () => {
  test("keeps a token's own region exactly the token", () => {
    const origins = new OriginStore();
    // The source reads `let  value`, so `value` sits at 5..10 behind two
    // spaces of leading trivia.
    const valueOrigin = origins.source(sourceId, { start: 5, end: 10 });
    const keyword = createToken({
      id: syntaxIds.allocate(),
      span: { start: 0, end: 3 },
      origin: origins.source(sourceId, { start: 0, end: 3 }),
      scopes,
      kind: "keyword",
      raw: "let",
      value: "let",
      leadingTrivia: [],
    });
    const value = createToken({
      id: syntaxIds.allocate(),
      span: { start: 5, end: 10 },
      origin: valueOrigin,
      scopes,
      kind: "identifier",
      raw: "value",
      value: "value",
      leadingTrivia: [
        {
          kind: "whitespace",
          raw: "  ",
          span: { start: 3, end: 5 },
          hasLineBreak: false,
        },
      ],
    });
    const printed = printExpandedFile({
      syntax: [keyword, value],
      origins,
      trace: [],
    });
    expect(printed.text).toBe("let  value");

    const own = printed.originMap.entries.find(
      (entry) => entry.origin === valueOrigin && entry.kind === "source",
    );
    // The region covers `value` alone. Were the two spaces folded in, every
    // offset inside the token would project one or two characters late.
    expect(own).toBeDefined();
    expect(printed.text.slice(own?.generatedStart, own?.generatedEnd)).toBe(
      "value",
    );
    expect((own?.generatedEnd ?? 0) - (own?.generatedStart ?? 0)).toBe(
      "value".length,
    );

    // The trivia keeps a region of its own so the map still covers the file.
    const trivia = printed.originMap.entries.find(
      (entry) => entry.generatedEnd === own?.generatedStart,
    );
    expect(trivia?.kind).toBe("synthesized");
    expect(
      printed.text.slice(trivia?.generatedStart, trivia?.generatedEnd),
    ).toBe("  ");
  });
  describe("grouping by precedence", () => {
    const origins = new OriginStore();
    const origin = origins.source(sourceId, { start: 0, end: 1 });
    const token = (raw: string, kind: TokenSyntax["kind"] = "identifier") =>
      createToken({
        id: syntaxIds.allocate(),
        span: { start: 0, end: 1 },
        origin,
        scopes,
        kind,
        raw,
        leadingTrivia: [],
      });
    const expression = (
      children: readonly Syntax[],
      precedence?: number,
      form?: "conditional" | "arrow",
    ) =>
      createProtectedSyntax({
        id: syntaxIds.allocate(),
        span: { start: 0, end: 1 },
        origin,
        scopes,
        category: "expr",
        ...(precedence === undefined
          ? {}
          : { precedence: createPrecedence(precedence) }),
        form,
        children,
      });
    const print = (syntax: ReturnType<typeof createProtectedSyntax>): string =>
      printExpandedFile({
        syntax: [syntax],
        origins,
        trace: {},
        groupProtectedExpression: () => true,
      }).text;

    test("leaves out parentheses an operand's own precedence makes redundant", () => {
      const product = expression(
        [token("a"), token("*", "punctuation"), token("b")],
        140,
      );
      const sum = expression(
        [product, token("+", "punctuation"), token("c")],
        130,
      );
      expect(print(expression([sum], undefined))).toBe("(a * b + c)");
    });

    test("keeps what precedence alone would drop but the language requires", () => {
      const either = expression(
        [token("a"), token("||", "punctuation"), token("b")],
        50,
      );
      const nullish = expression(
        [either, token("??", "punctuation"), token("c")],
        40,
      );
      expect(print(expression([nullish], undefined))).toBe("((a || b) ?? c)");
      const negated = expression([token("-", "punctuation"), token("a")], 160);
      const power = expression(
        [negated, token("**", "punctuation"), token("b")],
        150,
      );
      expect(print(expression([power], undefined))).toBe("((-a) ** b)");
    });

    test("groups a conditional or an arrow wherever it is not a whole arrow body", () => {
      const conditional = expression(
        [
          token("c"),
          token("?", "punctuation"),
          token("a"),
          token(":", "punctuation"),
          token("b"),
        ],
        undefined,
        "conditional",
      );
      const product = expression([
        conditional,
        token("*", "punctuation"),
        token("d"),
      ]);
      expect(print(product)).toBe("((c ? a : b) * d)");
      const arrow = expression(
        [
          token("x"),
          token("=>", "punctuation"),
          expression([token("x"), token("+", "punctuation"), token("y")]),
        ],
        undefined,
        "arrow",
      );
      // The body runs to the end of the arrow and needs no parentheses; the
      // arrow called with an argument does.
      const call = expression([
        arrow,
        createGroup({
          id: syntaxIds.allocate(),
          span: { start: 0, end: 1 },
          origin,
          scopes,
          delimiter: "parenthesis",
          open: token("(", "punctuation"),
          close: token(")", "punctuation"),
          children: [],
        }),
      ]);
      expect(print(call)).toBe("(x => x + y)()");
    });
  });
});
