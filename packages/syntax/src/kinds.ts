declare const precedenceBrand: unique symbol;

export type TokenKind =
  | "identifier"
  | "private-identifier"
  | "keyword"
  | "numeric-literal"
  | "bigint-literal"
  | "string-literal"
  | "regular-expression-literal"
  | "no-substitution-template"
  | "template-head"
  | "template-middle"
  | "template-tail"
  | "punctuation"
  | "jsx-text"
  | "jsx-identifier"
  | "end-of-file"
  | "unknown";

export type LexicalMode =
  | "standard"
  | "regular-expression"
  | "template"
  | "template-substitution"
  | "jsx-tag"
  | "jsx-text";

export type DelimiterKind =
  | "parenthesis"
  | "bracket"
  | "brace"
  | "template"
  | "jsx-element"
  | "jsx-fragment";

export type SyntaxCategory =
  | "item"
  | "stmt"
  | "expr"
  | "type"
  | "binding"
  | "classElement"
  | "typeMember"
  | "jsxChild"
  | "token"
  | "tt";

export type Precedence = number & {
  readonly [precedenceBrand]: "Precedence";
};

export function createPrecedence(value: number): Precedence {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new RangeError(
      "Precedence must be an integer between 0 and 1,000,000",
    );
  }
  return value as Precedence;
}

export const delimiterText: Readonly<
  Record<DelimiterKind, { readonly open: string; readonly close: string }>
> = Object.freeze({
  parenthesis: Object.freeze({ open: "(", close: ")" }),
  bracket: Object.freeze({ open: "[", close: "]" }),
  brace: Object.freeze({ open: "{", close: "}" }),
  template: Object.freeze({ open: "`", close: "`" }),
  "jsx-element": Object.freeze({ open: "<", close: ">" }),
  "jsx-fragment": Object.freeze({ open: "<", close: ">" }),
});
