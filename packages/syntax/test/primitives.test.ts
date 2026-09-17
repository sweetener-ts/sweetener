import {
  createIdAllocator,
  type OriginId,
  type ScopeSetId,
  type SyntaxId,
} from "@sweetener/shared";
import { describe, expect, it } from "vitest";
import {
  angleWidth,
  createGroup,
  createMissingToken,
  createPrecedence,
  createProtectedSyntax,
  createRootSyntax,
  createSpan,
  createToken,
  createTrivia,
  delimiterText,
  spanContains,
  spanLength,
  spansEqual,
  syntaxSequenceStructuralHash,
  syntaxStructuralEquals,
  syntaxStructuralHash,
  tokenLiteralEquals,
  type CreateTokenOptions,
  type DelimiterKind,
  type Span,
  type TokenSyntax,
} from "../src/index.js";

const syntaxIds = createIdAllocator<SyntaxId>();
const originIds = createIdAllocator<OriginId>();
const scopeSetIds = createIdAllocator<ScopeSetId>();
const defaultOrigin = originIds.allocate();
const defaultScopes = scopeSetIds.allocate();

function token(
  raw: string,
  overrides: Partial<CreateTokenOptions> = {},
): TokenSyntax {
  return createToken({
    id: syntaxIds.allocate(),
    span: createSpan(0, raw.length),
    origin: defaultOrigin,
    scopes: defaultScopes,
    kind: raw === "" ? "end-of-file" : "punctuation",
    raw,
    ...overrides,
  });
}

function group(
  delimiter: DelimiterKind,
  children: readonly TokenSyntax[] = [],
) {
  const text = delimiterText[delimiter];
  const open = token(text.open);
  const close = token(text.close);
  return createGroup({
    id: syntaxIds.allocate(),
    span: createSpan(0, text.open.length + text.close.length),
    origin: defaultOrigin,
    scopes: defaultScopes,
    delimiter,
    open,
    children,
    close,
  });
}

describe("spans", () => {
  it("constructs half-open spans and supplies basic relations", () => {
    const outer = createSpan(2, 9);
    const inner = createSpan(4, 7);
    expect(spanLength(outer)).toBe(7);
    expect(spanContains(outer, inner)).toBe(true);
    expect(spansEqual(inner, createSpan(4, 7))).toBe(true);
    expect(Object.isFrozen(outer)).toBe(true);
  });

  it.each([
    [-1, 0],
    [2, 1],
    [0.5, 1],
    [0, Number.POSITIVE_INFINITY],
  ])("rejects invalid span [%s, %s)", (start, end) => {
    expect(() => createSpan(start, end)).toThrow(RangeError);
  });
});

describe("trivia and tokens", () => {
  it("records raw trivia, line breaks, values, and lexical modes", () => {
    const trivia = createTrivia({
      kind: "line-comment",
      raw: "// comment\r\n",
      span: createSpan(0, 12),
    });
    const identifier = token("answer", {
      kind: "identifier",
      value: "answer",
      leadingTrivia: [trivia],
      lexicalMode: "standard",
    });
    expect(trivia.hasLineBreak).toBe(true);
    expect(identifier.value).toBe("answer");
    expect(identifier.leadingTrivia).toEqual([trivia]);
    expect(Object.isFrozen(identifier)).toBe(true);
    expect(Object.isFrozen(identifier.leadingTrivia)).toBe(true);
    expect(Object.isFrozen(identifier.leadingTrivia[0])).toBe(true);
  });

  it("rejects empty ordinary tokens, nonempty EOF, and empty trivia", () => {
    expect(() => token("", { kind: "identifier" })).toThrow(RangeError);
    expect(() => token("x", { kind: "end-of-file" })).toThrow(RangeError);
    expect(() =>
      createTrivia({ kind: "whitespace", raw: "", span: createSpan(0, 0) }),
    ).toThrow(RangeError);
  });
});

describe("groups and protected syntax", () => {
  it("represents a file root without inventing delimiter text", () => {
    const child = token("answer", { kind: "identifier", value: "answer" });
    const root = createRootSyntax({
      id: syntaxIds.allocate(),
      span: createSpan(0, 6),
      origin: defaultOrigin,
      scopes: defaultScopes,
      children: [child],
    });
    expect(root.tag).toBe("root");
    expect(root.children).toEqual([child]);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.children)).toBe(true);
  });

  it.each<DelimiterKind>([
    "parenthesis",
    "bracket",
    "brace",
    "template",
    "jsx-element",
    "jsx-fragment",
  ])("constructs an immutable %s group", (delimiter) => {
    const syntax = group(delimiter, [token("x", { kind: "identifier" })]);
    expect(syntax.delimiter).toBe(delimiter);
    expect(Object.isFrozen(syntax.children)).toBe(true);
    expect(() => (syntax.children as TokenSyntax[]).push(token("y"))).toThrow(
      TypeError,
    );
  });

  it("represents a missing close at a zero-width recovery position", () => {
    const open = token("{");
    const close = createMissingToken({
      id: syntaxIds.allocate(),
      span: createSpan(1, 1),
      origin: defaultOrigin,
      scopes: defaultScopes,
      expectedRaw: "}",
    });
    const syntax = createGroup({
      id: syntaxIds.allocate(),
      span: createSpan(0, 1),
      origin: defaultOrigin,
      scopes: defaultScopes,
      delimiter: "brace",
      open,
      close,
    });
    expect(syntax.close).toBe(close);
    expect(() =>
      createMissingToken({
        ...close,
        id: syntaxIds.allocate(),
        span: createSpan(1, 2),
      }),
    ).toThrow(/zero width/);
  });

  it("rejects mismatched delimiter tokens", () => {
    expect(() =>
      createGroup({
        id: syntaxIds.allocate(),
        span: createSpan(0, 2),
        origin: defaultOrigin,
        scopes: defaultScopes,
        delimiter: "parenthesis",
        open: token("["),
        close: token("]"),
      }),
    ).toThrow(/must open/);
  });

  it("rejects mutable child nodes at the tree boundary", () => {
    const mutable = { ...token("x", { kind: "identifier" }) };
    expect(() =>
      createProtectedSyntax({
        id: syntaxIds.allocate(),
        span: createSpan(0, 1),
        origin: defaultOrigin,
        scopes: defaultScopes,
        category: "expr",
        children: [mutable],
      }),
    ).toThrow(/immutable syntax node/);
  });

  it("protects a nonempty grammatical unit with validated precedence", () => {
    const child = token("answer", { kind: "identifier", value: "answer" });
    const syntax = createProtectedSyntax({
      id: syntaxIds.allocate(),
      span: createSpan(0, 6),
      origin: defaultOrigin,
      scopes: defaultScopes,
      category: "expr",
      precedence: createPrecedence(40),
      children: [child],
    });
    expect(syntax.precedence).toBe(40);
    expect(Object.isFrozen(syntax.children)).toBe(true);
    expect(() => createPrecedence(-1)).toThrow(RangeError);
    expect(() =>
      createProtectedSyntax({
        ...syntax,
        id: syntaxIds.allocate(),
        children: [],
      }),
    ).toThrow(/at least one child/);
  });
});

describe("structural hashing and equality", () => {
  function identifier(
    id: SyntaxId,
    span: Span,
    raw = "answer",
    origin = defaultOrigin,
    scopes = defaultScopes,
  ) {
    return createToken({
      id,
      span,
      origin,
      scopes,
      kind: "identifier",
      raw,
      value: raw,
    });
  }

  it("ignores instance IDs and positions but includes syntax context", () => {
    const left = identifier(syntaxIds.allocate(), createSpan(0, 6));
    const right = identifier(syntaxIds.allocate(), createSpan(20, 26));
    expect(syntaxStructuralHash(left)).toBe(syntaxStructuralHash(right));
    expect(syntaxStructuralEquals(left, right)).toBe(true);

    const anotherOrigin = identifier(
      syntaxIds.allocate(),
      createSpan(0, 6),
      "answer",
      originIds.allocate(),
    );
    expect(syntaxStructuralHash(anotherOrigin)).not.toBe(
      syntaxStructuralHash(left),
    );
    expect(syntaxStructuralEquals(anotherOrigin, left)).toBe(false);
  });

  it("keeps the baseline structural hash stable", () => {
    const syntax = createToken({
      id: 1 as SyntaxId,
      span: createSpan(0, 6),
      origin: 2 as OriginId,
      scopes: 3 as ScopeSetId,
      kind: "identifier",
      raw: "answer",
      value: "answer",
    });
    expect(syntaxStructuralHash(syntax)).toBe("808138d049384d28");
  });

  it("includes token trivia and nested group structure", () => {
    const plain = identifier(syntaxIds.allocate(), createSpan(0, 6));
    const commented = identifier(syntaxIds.allocate(), createSpan(0, 6));
    const withTrivia = createToken({
      ...commented,
      id: syntaxIds.allocate(),
      leadingTrivia: [
        createTrivia({
          kind: "block-comment",
          raw: "/*x*/",
          span: createSpan(0, 5),
        }),
      ],
    });
    expect(syntaxStructuralHash(withTrivia)).not.toBe(
      syntaxStructuralHash(plain),
    );
    expect(syntaxSequenceStructuralHash([plain])).not.toBe(
      syntaxSequenceStructuralHash([group("parenthesis", [plain])]),
    );
  });

  it("compares matcher literals without trivia, position, scopes, or origin", () => {
    const left = identifier(syntaxIds.allocate(), createSpan(0, 6));
    const right = createToken({
      id: syntaxIds.allocate(),
      span: createSpan(30, 36),
      origin: originIds.allocate(),
      scopes: scopeSetIds.allocate(),
      kind: "identifier",
      raw: "answer",
      value: "answer",
      leadingTrivia: [
        createTrivia({
          kind: "whitespace",
          raw: " ",
          span: createSpan(29, 30),
        }),
      ],
    });
    expect(tokenLiteralEquals(left, right)).toBe(true);
    expect(tokenLiteralEquals(left, token("other"))).toBe(false);
  });
});

describe("angle brackets", () => {
  it("counts the angles a token carries", () => {
    // A depth that counted one angle per token would be wrong wherever the
    // scanner joins two, so the count is the token's, not the position's.
    expect(angleWidth("<", "<")).toBe(1);
    expect(angleWidth("<<", "<")).toBe(2);
    expect(angleWidth("<<<", "<")).toBe(3);
    expect(angleWidth(">", ">")).toBe(1);
    expect(angleWidth(">>", ">")).toBe(2);
    expect(angleWidth(">>>", ">")).toBe(3);
  });

  it("counts nothing for a token that only begins with one", () => {
    for (const [raw, character] of [
      ["<=", "<"],
      ["<<=", "<"],
      [">=", ">"],
      [">>=", ">"],
      [">>>=", ">"],
      ["=>", ">"],
      ["<", ">"],
      [">", "<"],
      ["", "<"],
      ["a", "<"],
    ] as const) {
      expect(angleWidth(raw, character), `${raw} as ${character}`).toBe(0);
    }
  });
});
