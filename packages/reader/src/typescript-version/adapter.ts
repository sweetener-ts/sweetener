import type {
  LexicalMode,
  TokenReadings,
  TokenKind,
  TriviaKind,
} from "@sweetener/syntax";
import * as ts from "typescript";

export const supportedTypeScriptMajorMinor = "6.0" as const;

export type ScannerLanguageVariant = "standard" | "jsx";

export interface TypeScriptScannerError {
  readonly start: number;
  readonly length: number;
  readonly message: string;
}

export interface TypeScriptScannedToken {
  readonly kind: number;
  readonly kindName: string;
  readonly projectKind: TokenKind | undefined;
  readonly triviaKind: TriviaKind | undefined;
  readonly lexicalMode: LexicalMode;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly value: string;
  readonly precededByLineBreak: boolean;
  readonly unterminated: boolean;
}

export interface TypeScriptScanResult {
  readonly tokens: readonly TypeScriptScannedToken[];
  readonly errors: readonly TypeScriptScannerError[];
  readonly version: string;
  /**
   * The offsets of the readings given that the scan read no token at: no slash
   * for a slash's reading, no `<` it judged for a `<`'s.
   */
  readonly unread: readonly number[];
}

export class UnsupportedTypeScriptVersionError extends Error {
  override readonly name = "UnsupportedTypeScriptVersionError";

  constructor(readonly actualVersion: string) {
    super(
      `Unsupported TypeScript version ${actualVersion}; expected ${supportedTypeScriptMajorMinor}.x`,
    );
  }
}

export function assertSupportedTypeScriptVersion(version: string): void {
  if (!version.startsWith(`${supportedTypeScriptMajorMinor}.`)) {
    throw new UnsupportedTypeScriptVersionError(version);
  }
}

function computeTriviaKind(kind: ts.SyntaxKind): TriviaKind | undefined {
  switch (kind) {
    case ts.SyntaxKind.WhitespaceTrivia:
    case ts.SyntaxKind.NewLineTrivia:
      return "whitespace";
    case ts.SyntaxKind.SingleLineCommentTrivia:
      return "line-comment";
    case ts.SyntaxKind.MultiLineCommentTrivia:
      return "block-comment";
    case ts.SyntaxKind.ShebangTrivia:
      return "shebang";
    case ts.SyntaxKind.ConflictMarkerTrivia:
      return "conflict-marker";
    default:
      return undefined;
  }
}

/**
 * Every projection, precomputed once and indexed by syntax kind.
 *
 * These two run for every token and every piece of trivia in the file, and
 * each is a chain of comparisons that ends, for the commonest answers —
 * keyword and punctuation — only after falling through the whole switch. A
 * table is one array read. It is built from the same functions below, so the
 * two cannot drift.
 */
const tokenKinds: (TokenKind | undefined)[] = [];
const triviaKinds: (TriviaKind | undefined)[] = [];
for (let kind = 0; kind <= ts.SyntaxKind.LastToken; kind += 1) {
  tokenKinds.push(computeTokenKind(kind, "standard"));
  triviaKinds.push(computeTriviaKind(kind));
}

function projectTokenKind(
  kind: ts.SyntaxKind,
  mode: LexicalMode,
): TokenKind | undefined {
  if (mode === "jsx-tag" && kind === ts.SyntaxKind.Identifier) {
    return "jsx-identifier";
  }
  return kind >= 0 && kind < tokenKinds.length
    ? tokenKinds[kind]
    : computeTokenKind(kind, mode);
}

function projectTriviaKind(kind: ts.SyntaxKind): TriviaKind | undefined {
  return kind >= 0 && kind < triviaKinds.length
    ? triviaKinds[kind]
    : computeTriviaKind(kind);
}

function computeTokenKind(
  kind: ts.SyntaxKind,
  mode: LexicalMode,
): TokenKind | undefined {
  if (mode === "jsx-tag" && kind === ts.SyntaxKind.Identifier) {
    return "jsx-identifier";
  }
  switch (kind) {
    case ts.SyntaxKind.EndOfFileToken:
      return "end-of-file";
    case ts.SyntaxKind.Identifier:
      return "identifier";
    case ts.SyntaxKind.PrivateIdentifier:
      return "private-identifier";
    case ts.SyntaxKind.NumericLiteral:
      return "numeric-literal";
    case ts.SyntaxKind.BigIntLiteral:
      return "bigint-literal";
    case ts.SyntaxKind.StringLiteral:
      return "string-literal";
    case ts.SyntaxKind.RegularExpressionLiteral:
      return "regular-expression-literal";
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return "no-substitution-template";
    case ts.SyntaxKind.TemplateHead:
      return "template-head";
    case ts.SyntaxKind.TemplateMiddle:
      return "template-middle";
    case ts.SyntaxKind.TemplateTail:
      return "template-tail";
    case ts.SyntaxKind.JsxText:
    case ts.SyntaxKind.JsxTextAllWhiteSpaces:
      return "jsx-text";
    default:
      if (
        kind >= ts.SyntaxKind.FirstKeyword &&
        kind <= ts.SyntaxKind.LastKeyword
      ) {
        return "keyword";
      }
      if (
        kind >= ts.SyntaxKind.FirstPunctuation &&
        kind <= ts.SyntaxKind.LastPunctuation
      ) {
        return "punctuation";
      }
      if (
        kind >= ts.SyntaxKind.FirstTriviaToken &&
        kind <= ts.SyntaxKind.LastTriviaToken
      ) {
        return undefined;
      }
      return "unknown";
  }
}

type JsxMode = "standard" | "tag" | "text" | "expression";

interface JsxContainer {
  /**
   * The mode the scan returns to once the element closes: `tag` for an
   * element written as an attribute's value without braces, `<a b=<c />>`.
   */
  readonly returnMode: "standard" | "expression" | "tag";
  depth: number;
}

function tokenLexicalMode(kind: ts.SyntaxKind, jsxMode: JsxMode): LexicalMode {
  if (kind === ts.SyntaxKind.RegularExpressionLiteral)
    return "regular-expression";
  if (kind === ts.SyntaxKind.TemplateHead) return "template-substitution";
  if (
    kind === ts.SyntaxKind.TemplateMiddle ||
    kind === ts.SyntaxKind.TemplateTail
  ) {
    return "template";
  }
  if (
    kind === ts.SyntaxKind.JsxText ||
    kind === ts.SyntaxKind.JsxTextAllWhiteSpaces
  ) {
    return "jsx-text";
  }
  if (jsxMode === "tag") return "jsx-tag";
  if (jsxMode === "text") return "jsx-text";
  return "standard";
}

const identifierStart = /[\p{ID_Start}_$]/u;

/**
 * How deep in braces each template substitution the lookahead has entered
 * stands. A `}` written at depth zero closes the substitution rather than a
 * brace group, and the scanner is told so by rescanning it.
 */
type TemplateSubstitutions = number[];

/**
 * The next token the lookahead reads, with the two rescans the walk below
 * needs.
 *
 * TypeScript's scanner cannot know either of them on its own, because both
 * depend on what the parser was reading: a `}` closes a template's
 * substitution rather than a brace group, and a `/` begins a regular
 * expression rather than a division. The walk keeps that position, so it is
 * the walk that asks for the rescan -- the same two questions, and the same
 * answers, as the scan this adapter runs over the whole file.
 */
function nextLookaheadToken(
  lookahead: ts.Scanner,
  templates: TemplateSubstitutions,
  regularExpressionAllowed: boolean,
  readings: TokenReadings,
): ts.SyntaxKind {
  let kind = lookahead.scan();
  if (
    (kind === ts.SyntaxKind.SlashToken ||
      kind === ts.SyntaxKind.SlashEqualsToken) &&
    readsRegularExpression(
      readings,
      lookahead.getTokenStart(),
      regularExpressionAllowed,
    )
  )
    kind = lookahead.reScanSlashToken();
  if (kind === ts.SyntaxKind.TemplateHead) {
    templates.push(0);
    return kind;
  }
  const braces = templates.at(-1);
  if (braces === undefined) return kind;
  if (kind === ts.SyntaxKind.OpenBraceToken) {
    templates[templates.length - 1] = braces + 1;
  } else if (kind === ts.SyntaxKind.CloseBraceToken) {
    if (braces > 0) templates[templates.length - 1] = braces - 1;
    else {
      kind = lookahead.reScanTemplateToken(false);
      if (kind === ts.SyntaxKind.TemplateTail) templates.pop();
    }
  }
  return kind;
}

/**
 * Whether the slash starting at `start` begins a regular expression: as
 * `readings` says where it says, and otherwise as the token before it allows.
 */
function readsRegularExpression(
  readings: TokenReadings,
  start: number,
  allowed: boolean,
): boolean {
  const reading = readings.get(start);
  return reading === undefined ? allowed : reading === "regular-expression";
}

/** Whether `readings` says what the `<` starting at `start` opens. */
function readsAngle(readings: TokenReadings, start: number): boolean {
  const reading = readings.get(start);
  return reading === "element" || reading === "type-parameters";
}

/**
 * Whether a token can stand among the parameters of a signature or function
 * type: names, keywords, literals and the punctuation types are written with.
 * A `-` or `+` stands there as a literal's sign or a mapped type's modifier.
 * No parameter of a type has an initializer, so no `=` stands there, and no
 * `/` or other operator does; nor does an unterminated literal.
 */
function standsInSignatureParameters(
  kind: ts.SyntaxKind,
  unterminated: boolean,
): boolean {
  if (unterminated) return false;
  if (kind === ts.SyntaxKind.Identifier) return true;
  if (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword)
    return true;
  switch (kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.OpenParenToken:
    case ts.SyntaxKind.CloseParenToken:
    case ts.SyntaxKind.OpenBracketToken:
    case ts.SyntaxKind.CloseBracketToken:
    case ts.SyntaxKind.OpenBraceToken:
    case ts.SyntaxKind.CloseBraceToken:
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.CommaToken:
    case ts.SyntaxKind.ColonToken:
    case ts.SyntaxKind.SemicolonToken:
    case ts.SyntaxKind.QuestionToken:
    case ts.SyntaxKind.DotToken:
    case ts.SyntaxKind.DotDotDotToken:
    case ts.SyntaxKind.BarToken:
    case ts.SyntaxKind.AmpersandToken:
    case ts.SyntaxKind.EqualsGreaterThanToken:
    case ts.SyntaxKind.MinusToken:
    case ts.SyntaxKind.PlusToken:
      return true;
    default:
      return false;
  }
}

/**
 * Whether a signature's parameter list ends where `kind` follows it: at its
 * return type's `:`, or at the end of the member -- a `;`, a `,`, the body's
 * `}`, a line break. An element's text goes on with words.
 */
function endsSignature(kind: ts.SyntaxKind, lineBreakBefore: boolean): boolean {
  return (
    lineBreakBefore ||
    kind === ts.SyntaxKind.ColonToken ||
    kind === ts.SyntaxKind.SemicolonToken ||
    kind === ts.SyntaxKind.CommaToken ||
    kind === ts.SyntaxKind.CloseBraceToken ||
    kind === ts.SyntaxKind.EndOfFileToken
  );
}

/**
 * Whether the `<T>` the lookahead has just read is the type parameter list of
 * a function type, `<T>(v: T) => T`, or of a call or construct signature,
 * `<T>(v: T): T`, rather than a JSX opening tag. An element with children can
 * have a `(` next too -- `<div>(text)</div>` -- so this is a judgement, made
 * from what follows, and the enforester corrects it where the grammar reads
 * an element (see `AngleReading`).
 *
 * Where a member of an interface or an object type begins (`memberStart`,
 * from `beginsMember`) a signature is judged where the parentheses read as a
 * type's and the member's return type or end follows them (`endsSignature`):
 * `<T>(v: T): T`, and `<T>(v: T);`, which returns what it is not told. An
 * element written there is a statement of its own, whose text may well go on
 * with words -- `<p>(optional) note</p>` -- and where it reads like a
 * signature instead, `<b>(note): x</b>;`, the enforester reads the element.
 * Elsewhere only a function type is judged, by the arrow after the
 * parentheses, since an element's text says `(note): see below` as readily
 * as a signature says `(v: T): T`.
 *
 * Parameters of a type hold no expression -- no initializer, so no regular
 * expression and no element -- so the walk reads them as types and stops at
 * the first token no type contains. An element's text reaches one by its
 * closing tag at the latest, so the walk never reads past the element.
 */
function signatureFollows(
  lookahead: ts.Scanner,
  templates: TemplateSubstitutions,
  readings: TokenReadings,
  memberStart: boolean,
): boolean {
  if (
    nextLookaheadToken(lookahead, templates, false, readings) !==
    ts.SyntaxKind.OpenParenToken
  )
    return false;
  let depth = 1;
  while (depth > 0) {
    const kind = nextLookaheadToken(lookahead, templates, false, readings);
    if (!standsInSignatureParameters(kind, lookahead.isUnterminated()))
      return false;
    if (kind === ts.SyntaxKind.OpenParenToken) depth += 1;
    else if (kind === ts.SyntaxKind.CloseParenToken) depth -= 1;
  }
  const after = nextLookaheadToken(lookahead, templates, false, readings);
  if (after === ts.SyntaxKind.EqualsGreaterThanToken) return true;
  return memberStart && endsSignature(after, lookahead.hasPrecedingLineBreak());
}

/**
 * Whether the `<` at `start` opens a JSX element rather than a type parameter
 * list.
 *
 * Where an expression is written, TypeScript's parser decides it from the
 * tokens straight after the name, and so does this: `<T,`, `<T =` and
 * `<T extends U` are a generic arrow's type parameters, and anything else
 * opens an element -- `<T extends>`, `<T extends=…` and `<T extends/` among
 * them, whose `extends` is an attribute's name. A `const` before the name is
 * a modifier and is passed over. What is written further on in the tag never
 * enters into it, so an attribute holding an element, a regular expression or
 * a string is never scanned here -- reading those with an ordinary scanner
 * took the `/` of an inner closing tag for a regular expression and an
 * apostrophe in an inner element's text for a string, and either one hid the
 * end of the tag.
 *
 * Where a type is written there is no element, and a type parameter list
 * opens a function type or a signature. Every spelling of one is caught by the
 * rule above but the bare `<T>`, so only that one asks what follows it
 * (`signatureFollows`).
 */
function looksLikeJsxStart(
  lookahead: ts.Scanner,
  source: string,
  start: number,
  readings: TokenReadings,
  memberStart: boolean,
): boolean {
  if (source.charCodeAt(start + 1) === 0x3e /* > */) return true;
  const nameStart = start + 1;
  if (nameStart >= source.length || !identifierStart.test(source[nameStart]!))
    return false;
  lookahead.setText(source, nameStart);
  const templates: TemplateSubstitutions = [];
  if (
    nextLookaheadToken(lookahead, templates, false, readings) ===
    ts.SyntaxKind.ConstKeyword
  )
    nextLookaheadToken(lookahead, templates, false, readings);
  const third = nextLookaheadToken(lookahead, templates, false, readings);
  if (third === ts.SyntaxKind.CommaToken || third === ts.SyntaxKind.EqualsToken)
    return false;
  if (third === ts.SyntaxKind.ExtendsKeyword) {
    const fourth = nextLookaheadToken(lookahead, templates, false, readings);
    return (
      fourth === ts.SyntaxKind.EqualsToken ||
      fourth === ts.SyntaxKind.GreaterThanToken ||
      fourth === ts.SyntaxKind.SlashToken
    );
  }
  if (third === ts.SyntaxKind.GreaterThanToken)
    return !signatureFollows(lookahead, templates, readings, memberStart);
  return true;
}

/**
 * Whether a `<` written after a token of kind `previous`, inside a group
 * opened by `innermost`, stands where a member of an interface or an object
 * type begins: after the `{` that opens the body, after a `;` or `,` that ends
 * the member before it inside those braces, after a line break that ends it --
 * members are written without semicolons as often as with -- or after the
 * `new` of a construct signature. A `,` inside brackets or parentheses
 * separates elements and arguments, and the braces of a JSX expression hold an
 * expression; either may well be an element.
 *
 * A line break comes into it only where the `<` is judged at all, which is
 * where an expression could begin after `previous`. Of the tokens a member's
 * type ends in, only a `>` and a `void` stand there -- both take an operand in
 * an expression: `a: Array<string>` and the `<T>(v: T): T` under it -- and a
 * line break after any other, a `:` or an `=` among them, carries an
 * expression on. Where an expression is written after a `>` or a `void`
 * instead, the enforester reads the element (see `AngleReading`).
 */
function beginsMember(
  previous: ts.SyntaxKind | undefined,
  innermost: ts.SyntaxKind | undefined,
  lineBreakBefore: boolean,
): boolean {
  if (previous === ts.SyntaxKind.NewKeyword) return true;
  return (
    innermost === ts.SyntaxKind.OpenBraceToken &&
    (previous === ts.SyntaxKind.OpenBraceToken ||
      previous === ts.SyntaxKind.SemicolonToken ||
      previous === ts.SyntaxKind.CommaToken ||
      (lineBreakBefore &&
        (previous === ts.SyntaxKind.GreaterThanToken ||
          previous === ts.SyntaxKind.VoidKeyword)))
  );
}

const endsExpression: boolean[] = [];
for (let kind = 0; kind <= ts.SyntaxKind.LastToken; kind += 1)
  endsExpression.push(computeEndsExpression(kind));

/** Runs for every token, so it is a table for the same reason the others are. */
function tokenCanEndExpression(kind: ts.SyntaxKind): boolean {
  return kind >= 0 && kind < endsExpression.length
    ? endsExpression[kind]!
    : computeEndsExpression(kind);
}

function computeEndsExpression(kind: ts.SyntaxKind): boolean {
  // A contextual keyword is a name wherever no declaration or type is being
  // written with it, and none of them is followed by an operand where it is
  // the keyword: `as` and `satisfies` take a type, `type` and `declare` a
  // name, `from` a string. So a slash after one divides the name -- `of / 2`
  // and `undefined / 2` -- but for `await`, which takes an operand, and `of`
  // in a `for` head, which the scan below judges by where it stands.
  // TypeScript's own range of them, from `abstract` to `of`.
  if (kind >= ts.SyntaxKind.AbstractKeyword && kind <= ts.SyntaxKind.OfKeyword)
    return kind !== ts.SyntaxKind.AwaitKeyword;
  switch (kind) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.PrivateIdentifier:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.SuperKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.CloseParenToken:
    case ts.SyntaxKind.CloseBracketToken:
    case ts.SyntaxKind.CloseBraceToken:
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
      return true;
    default:
      return false;
  }
}

/**
 * What a group was opened after, as far as a slash written after its closing
 * delimiter is concerned, and what the group holds: a `block` holds
 * statements, and `members` the members of a class, an interface or an enum.
 * Both end a statement where they close. A `body` holds statements and a
 * `class` members as those do, but each is the body of a function or a class
 * written as an expression, which is an operand where it closes:
 * `foo(function () { function g() {} })` declares `g`, and `x = class {} / 2`
 * divides.
 */
type GroupHead =
  | "statement"
  | "for"
  | "catch"
  | "block"
  | "members"
  | "body"
  | "class"
  | "other";

/** Whether a group with the head holds statements. */
function holdsStatements(head: GroupHead | undefined): boolean {
  return head === undefined || head === "block" || head === "body";
}

/** Whether a group with the head holds a class's or an interface's members. */
function holdsMembers(head: GroupHead | undefined): boolean {
  return head === "members" || head === "class";
}

/** The words a statement's parenthesized head is written after. */
const statementHeads = new Map<ts.SyntaxKind, GroupHead>([
  [ts.SyntaxKind.IfKeyword, "statement"],
  [ts.SyntaxKind.WhileKeyword, "statement"],
  [ts.SyntaxKind.WithKeyword, "statement"],
  [ts.SyntaxKind.SwitchKeyword, "statement"],
  [ts.SyntaxKind.ForKeyword, "for"],
  [ts.SyntaxKind.CatchKeyword, "catch"],
]);

/** The words a block is written after, as a statement's own body. */
const blockHeads = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ElseKeyword,
  ts.SyntaxKind.DoKeyword,
  ts.SyntaxKind.TryKeyword,
  ts.SyntaxKind.FinallyKeyword,
  ts.SyntaxKind.CatchKeyword,
]);

/**
 * The words that declare what their body is the whole of, wherever they begin
 * a statement: a function's, a class's or an enum's. The `}` that ends the
 * body ends the statement, so what follows begins another -- where a slash
 * begins a regular expression -- just as after an `if`'s block.
 */
const declarationKeywords = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionKeyword,
  ts.SyntaxKind.ClassKeyword,
  ts.SyntaxKind.EnumKeyword,
]);

/**
 * The words that declare a body as those above do, but are names anywhere
 * they are not followed by what they declare: an interface's or a
 * namespace's name, a module's string, or the braces of `declare global`.
 * `module.exports = {}` assigns, and `global.x` reads.
 */
const contextualDeclarationKeywords = new Map<
  ts.SyntaxKind,
  ReadonlySet<ts.SyntaxKind>
>([
  [ts.SyntaxKind.InterfaceKeyword, new Set([ts.SyntaxKind.Identifier])],
  [ts.SyntaxKind.NamespaceKeyword, new Set([ts.SyntaxKind.Identifier])],
  [
    ts.SyntaxKind.ModuleKeyword,
    new Set([ts.SyntaxKind.Identifier, ts.SyntaxKind.StringLiteral]),
  ],
  [ts.SyntaxKind.GlobalKeyword, new Set([ts.SyntaxKind.OpenBraceToken])],
]);

/**
 * The modifiers written in front of a declaration, which begin the statement
 * the declaration does: `export default async function`, `declare abstract
 * class`, `const enum`.
 */
const declarationModifiers = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ExportKeyword,
  ts.SyntaxKind.DefaultKeyword,
  ts.SyntaxKind.AsyncKeyword,
  ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.AbstractKeyword,
  ts.SyntaxKind.ConstKeyword,
]);

/**
 * The words after which a line break ends the statement they stand in: the
 * jumps that take an operand only on their own line, and the contextual
 * modifiers, which are names where a line break follows them.
 */
const endsStatementAtLineBreak = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ReturnKeyword,
  ts.SyntaxKind.BreakKeyword,
  ts.SyntaxKind.ContinueKeyword,
  ts.SyntaxKind.AsyncKeyword,
  ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.AbstractKeyword,
]);

/**
 * The tokens a type is written after, where a brace in a declaration's header
 * opens an object type rather than the declaration's body: a return type's
 * `:`, a constraint's `extends`, a default's `=`, and the operators and
 * separators of the type grammar.
 */
const typeBraceAfter = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.EqualsGreaterThanToken,
  ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.ExtendsKeyword,
  ts.SyntaxKind.KeyOfKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.IsKeyword,
]);

/**
 * The tokens that carry a type on where it could have ended, across a line
 * break as well: the operators of the type grammar, a qualified name's `.`, a
 * type argument list's `,` and `>`, a conditional's `?` and `:`, a function
 * type's `=>`, a type parameter's constraint and default. None of them begins
 * a statement. A `[`, a `<` and a conditional's `extends` continue a type only
 * on its own line, which TypeScript requires of each.
 */
const continuesType = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.DotToken,
  ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.QuestionToken,
  ts.SyntaxKind.ColonToken,
  ts.SyntaxKind.EqualsGreaterThanToken,
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.ExtendsKeyword,
]);

/**
 * Whether a type, or the name a declaration binds, could end at a token: a
 * name, a literal, a closer, a type argument list's `>`, `void`. The words
 * that take a type after them -- `keyof`, `infer`, `unique`, `readonly`,
 * `asserts`, `is`, `abstract new` -- end none.
 */
function completesType(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.KeyOfKeyword:
    case ts.SyntaxKind.InferKeyword:
    case ts.SyntaxKind.UniqueKeyword:
    case ts.SyntaxKind.ReadonlyKeyword:
    case ts.SyntaxKind.AssertsKeyword:
    case ts.SyntaxKind.IsKeyword:
    case ts.SyntaxKind.AbstractKeyword:
      return false;
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.VoidKeyword:
      return true;
    default:
      return tokenCanEndExpression(kind);
  }
}

/** Whether a token can follow `function` in a function expression. */
function continuesFunction(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.OpenParenToken ||
    kind === ts.SyntaxKind.AsteriskToken ||
    kind === ts.SyntaxKind.LessThanToken ||
    isBindingName(kind)
  );
}

/** Whether a token can follow `class` in a class expression. */
function continuesClass(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.OpenBraceToken ||
    kind === ts.SyntaxKind.ExtendsKeyword ||
    kind === ts.SyntaxKind.ImplementsKeyword ||
    kind === ts.SyntaxKind.LessThanToken ||
    isBindingName(kind)
  );
}

/** Whether a token can be the name a declaration binds: `let of`, `type T`. */
function isBindingName(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.Identifier ||
    (kind >= ts.SyntaxKind.AbstractKeyword && kind <= ts.SyntaxKind.OfKeyword)
  );
}

/**
 * What of a statement that ends with a type is being read: the names a
 * variable statement binds and their types (`binding`, ended by an
 * initializer's `=`), an initializer (`initializer`, which the next
 * declarator's `,` ends), a type alias's or an import alias's name and type
 * parameters (`name`, before its `=`), or the type itself (`type`).
 */
type TypedPart = "binding" | "initializer" | "name" | "type";

/**
 * The words that begin a statement ending with a type, what of it follows,
 * whether the name they declare must be written on their own line, and
 * whether it may be a destructuring pattern: `let x: T`, `using r: R = ...`,
 * `type T = ...`, `import x = A.B`. Words that are names elsewhere --
 * `type = 1`, `using\n(x)` -- begin one only before a name on their line.
 */
const typedStatements = new Map<
  ts.SyntaxKind,
  {
    readonly part: TypedPart;
    readonly sameLine: boolean;
    readonly patterns: boolean;
  }
>([
  [
    ts.SyntaxKind.LetKeyword,
    { part: "binding", sameLine: false, patterns: true },
  ],
  [
    ts.SyntaxKind.ConstKeyword,
    { part: "binding", sameLine: false, patterns: true },
  ],
  [
    ts.SyntaxKind.VarKeyword,
    { part: "binding", sameLine: false, patterns: true },
  ],
  [
    ts.SyntaxKind.UsingKeyword,
    { part: "binding", sameLine: true, patterns: false },
  ],
  [
    ts.SyntaxKind.TypeKeyword,
    { part: "name", sameLine: true, patterns: false },
  ],
  [
    ts.SyntaxKind.ImportKeyword,
    { part: "name", sameLine: true, patterns: false },
  ],
]);

/** The opening delimiter each closing one closes. */
const opens = new Map<ts.SyntaxKind, ts.SyntaxKind>([
  [ts.SyntaxKind.CloseParenToken, ts.SyntaxKind.OpenParenToken],
  [ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.OpenBracketToken],
  [ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.OpenBraceToken],
  [ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateHead],
  [ts.SyntaxKind.TemplateTail, ts.SyntaxKind.TemplateHead],
]);

/**
 * Whether a slash begins a regular expression, judged from what stands
 * before it, as a scan reads one token after another.
 *
 * Which of the two a slash begins is the parser's to say, and a scan that runs
 * ahead of its parser judges from the token before: after a name, a literal
 * or a closer, a division. A closer on its own says only that an operand may
 * have ended there, and what its group was opened after says more where that
 * was a statement's head. The `)` that closes `if (c)`, `while (c)`, `with
 * (o)` or a `for` head ends the head, and the body after it begins where an
 * expression does, so `if (c) /re/.test(s)` writes a regular expression. The
 * `}` that closes a block written as such a body, or after `else`, `do`,
 * `try`, `finally` or `catch`, or as an arrow's body, ends a statement or an
 * arrow function, and TypeScript takes no operator after either. That is the
 * sweet.js reader's lookbehind, as far as the groups alone can tell it.
 *
 * Past that, the scan follows the statements it stands in, as far as their
 * words tell it: where a declaration's body ends the statement, where a
 * function or a class written as an expression has a body that is an
 * operand, and where a statement ends with a type -- `let a: string`, `type
 * T = {}`, an overload's return type -- after which nothing divides. Where
 * only the grammar can tell, the enforester says (see `TokenReadings`), and
 * the source is read again.
 *
 * The groups are matched as the reader matches them: a closer closes the
 * nearest group it can, and every group still open inside that one with it.
 */
class SlashJudgement {
  #allowed: boolean;
  readonly #open: {
    readonly opener: ts.SyntaxKind;
    readonly head: GroupHead;
  }[] = [];
  #previous: ts.SyntaxKind | undefined;
  #beforePrevious: ts.SyntaxKind | undefined;
  /** What the group the latest token closed was opened after. */
  #closed: GroupHead | undefined;
  /**
   * Whether the next token begins a statement, as the first one does. Only
   * in a list of statements does one: at the top level, or in a block.
   */
  #nextBeginsStatement = true;
  /**
   * Whether the next token stands in a list of statements after one that
   * ends an expression. A word that cannot carry an expression on -- a
   * declaring word, a label -- begins a statement there, by a line break or
   * as an error TypeScript reports. A brace or a parenthesis carries one on:
   * `function () {}` and `f(x)`.
   */
  #nextAfterExpression = false;
  /**
   * Whether the next token stands in a list of statements after a word that
   * ends a statement where a line break follows it: a `return`, `break` or
   * `continue` taking nothing, or a contextual modifier -- `async`,
   * `declare`, `abstract` -- that a line break makes a name. `return` and
   * `function f() {}` on the line under it are two statements.
   */
  #nextAfterLineEnd = false;
  /**
   * Whether the statement the latest token stands in ends with it where a
   * line break follows: a module's specifier, `import x from "m"`, or the
   * label a `break` or `continue` jumps to. A slash on the line under either
   * begins a regular expression, which after a name it otherwise does not.
   */
  #statementEndsAtLineBreak = false;
  /**
   * How many groups stood open outside a brace whose close ends the statement
   * it stands in: an import's attributes, `with { type: "json" }`, and the
   * list of an export from nowhere, `export type { A }`. Undefined where none
   * is open.
   */
  #closesStatement: number | undefined;
  /**
   * A declaration whose body has not been read yet: how many groups stood
   * open at its declaring word, where its body is the first brace opened at
   * that depth where no type is written, whether that body holds members
   * rather than statements, and whether the function or class is written as
   * an expression rather than declared. Undefined where no such word was
   * read.
   */
  #declaration:
    | {
        readonly depth: number;
        readonly members: boolean;
        readonly expression: boolean;
      }
    | undefined;
  /**
   * What must follow a contextual declaring word just read for it to declare,
   * on the same line, and the declaration it would begin. Undefined where
   * none was read.
   */
  #candidate:
    | {
        readonly follows: ReadonlySet<ts.SyntaxKind>;
        readonly depth: number;
        readonly members: boolean;
      }
    | undefined;
  /**
   * Whether the modifiers read since the statement began include `declare`,
   * after which a function has no body.
   */
  #ambient = false;
  /**
   * Whether the decorators read since a token that was no decorator began a
   * statement, and how many groups stood open there. A class they decorate
   * begins one where they did: `@d class C {}` declares, and `x = @d class
   * {}` is an expression.
   */
  #decorated:
    { readonly beginsStatement: boolean; readonly depth: number } | undefined;
  /**
   * The `case` or `default` clause whose `:` has not been read yet: how many
   * groups stood open at it, how many `?`s of a conditional in its expression
   * still wait for their `:`, and whether it is a `default`, whose `:` comes
   * next or which is no clause.
   */
  #clause:
    | { readonly depth: number; questions: number; readonly default: boolean }
    | undefined;
  /** How many groups stood open at a name that began a statement, just read. */
  #label: number | undefined;
  /**
   * A statement that ends with a type, being read: how many groups stood
   * open where it began, and what of it the scan stands in. Nothing in a type
   * or in the names a declaration binds is divided, so a slash written there
   * at the statement's own depth is past its end and begins a regular
   * expression: `let a: string` and the `/[(]/.test(s)` under it. Where the
   * type ends at a line break, the token after it begins a statement.
   * Undefined where no such statement is being read.
   */
  #typed:
    | {
        readonly depth: number;
        part: TypedPart;
        /**
         * How many `<` an initializer holds that no `>` has closed: the `,`
         * of `f<A, B>(c)` separates type arguments, not declarators.
         */
        angles: number;
      }
    | undefined;
  /**
   * A word just read that begins a statement ending with a type if a name
   * follows it as `typedStatements` says, with how many groups stood open at
   * it. Undefined where none was read.
   */
  #typedCandidate:
    | {
        readonly depth: number;
        readonly part: TypedPart;
        readonly sameLine: boolean;
        readonly patterns: boolean;
      }
    | undefined;
  /**
   * A function declaration whose return type has not been reached yet: how
   * many groups stood open at its `function`, and whether its parameter list
   * is still to come, being read, or just closed, where a `:` writes the
   * return type its signature may end with -- an overload's, or an ambient
   * function's. `angles` counts the `<` of its type parameters still open,
   * which may hold parentheses of their own: `f<T extends (a: A) => B>(x)`.
   * Undefined where none is being read.
   */
  #signature:
    | {
        readonly depth: number;
        part: "header" | "parameters" | "closed";
        angles: number;
      }
    | undefined;

  constructor(allowed: boolean) {
    this.#allowed = allowed;
  }

  /** Whether the scan stands in a list of statements. */
  get inStatements(): boolean {
    return holdsStatements(this.#open.at(-1)?.head);
  }

  /**
   * Whether a `kind` read next, after a line break where `lineBreakBefore`
   * says so, begins an expression: a slash a regular expression, and a `<`
   * an element where the variant has them.
   */
  beginsExpression(kind: ts.SyntaxKind, lineBreakBefore: boolean): boolean {
    return (
      this.#allowed ||
      (this.#statementEndsAtLineBreak && lineBreakBefore) ||
      this.#typeEndsAt(kind, lineBreakBefore)
    );
  }

  /**
   * Takes in that the latest token ended an element, which is an operand:
   * `<div>{a}</div> / 2` divides.
   */
  endOperand(): void {
    this.#allowed = false;
    this.#nextAfterExpression = holdsStatements(this.#open.at(-1)?.head);
  }

  /**
   * Whether the statement ending with a type being read ends in front of a
   * `kind` read next, where it stands at the statement's depth: at a slash
   * where a type or a binding is read, at a brace after a complete type --
   * a function's body, or a block on the line under it -- and, after a line
   * break, at any token that does not carry a type on.
   */
  #typeEndsAt(kind: ts.SyntaxKind, lineBreakBefore: boolean): boolean {
    const typed = this.#typed;
    if (
      typed === undefined ||
      typed.part === "initializer" ||
      this.#open.length !== typed.depth
    )
      return false;
    if (
      typed.part !== "name" &&
      (kind === ts.SyntaxKind.SlashToken ||
        kind === ts.SyntaxKind.SlashEqualsToken ||
        kind === ts.SyntaxKind.RegularExpressionLiteral)
    )
      return true;
    if (this.#previous === undefined || !completesType(this.#previous))
      return false;
    if (kind === ts.SyntaxKind.OpenBraceToken) return true;
    return lineBreakBefore && !continuesType.has(kind);
  }

  /**
   * Takes in the next token that is not trivia. `lineBreakBefore` says whether
   * a line break stands in front of it. A token that says nothing of what
   * follows it -- JSX text -- is taken only for the groups it closes.
   */
  take(kind: ts.SyntaxKind, lineBreakBefore: boolean, judged = true): void {
    // After a `.` a keyword is a member's name: `o.else / 2` divides, and no
    // statement or declaration begins there. A `(` or a `[` after `?.` is an
    // optional call or index, and no name.
    const memberName =
      (this.#previous === ts.SyntaxKind.DotToken ||
        this.#previous === ts.SyntaxKind.QuestionDotToken) &&
      kind >= ts.SyntaxKind.FirstKeyword &&
      kind <= ts.SyntaxKind.LastKeyword;
    const depth = this.#open.length;
    // A function or a class written as an expression goes on to its name, its
    // parameters or its heritage; a word spelled like one that does not is a
    // key: `{ class: 1, m() {} }`.
    if (
      this.#declaration?.expression === true &&
      this.#declaration.depth === depth &&
      ((this.#previous === ts.SyntaxKind.FunctionKeyword &&
        !continuesFunction(kind)) ||
        (this.#previous === ts.SyntaxKind.ClassKeyword &&
          !continuesClass(kind)))
    )
      this.#declaration = undefined;
    const typeEnds = this.#typeEndsAt(kind, lineBreakBefore);
    const typed = typeEnds ? undefined : this.#typed;
    this.#typed = typed;
    if (typed !== undefined && depth === typed.depth) {
      if (kind === ts.SyntaxKind.SemicolonToken) this.#typed = undefined;
      else if (typed.part === "initializer") {
        // An initializer holds no bare comma operator, so a `,` at the
        // statement's depth begins the next declarator, which may be typed:
        // `let w = 1, x: T`. Where its expression is not known to end, the
        // statement is left to the enforester: at a line break that no `,`
        // stands at, since an expression goes on across one.
        if (
          lineBreakBefore &&
          kind !== ts.SyntaxKind.CommaToken &&
          this.#previous !== ts.SyntaxKind.CommaToken
        )
          this.#typed = undefined;
        else if (kind === ts.SyntaxKind.LessThanToken) typed.angles += 1;
        else if (kind === ts.SyntaxKind.GreaterThanToken)
          typed.angles = Math.max(0, typed.angles - 1);
        else if (kind === ts.SyntaxKind.CommaToken && typed.angles === 0)
          typed.part = "binding";
      } else if (kind === ts.SyntaxKind.EqualsToken) {
        // A variable's initializer is an expression; an alias's `=` writes
        // its type, after a type parameter's default that has its own.
        if (typed.part === "binding") typed.part = "initializer";
        else typed.part = "type";
      }
    }
    const typedCandidate = this.#typedCandidate;
    this.#typedCandidate = undefined;
    if (
      typedCandidate !== undefined &&
      depth === typedCandidate.depth &&
      !(typedCandidate.sameLine && lineBreakBefore) &&
      (isBindingName(kind) ||
        (typedCandidate.patterns &&
          (kind === ts.SyntaxKind.OpenBraceToken ||
            kind === ts.SyntaxKind.OpenBracketToken)))
    )
      this.#typed = { depth, part: typedCandidate.part, angles: 0 };
    const signature = this.#signature;
    if (signature !== undefined) {
      if (signature.part === "closed") {
        this.#signature = undefined;
        if (kind === ts.SyntaxKind.ColonToken && depth === signature.depth)
          this.#typed = { depth, part: "type", angles: 0 };
      } else if (signature.part === "header" && depth === signature.depth) {
        if (kind === ts.SyntaxKind.LessThanToken) signature.angles += 1;
        else if (kind === ts.SyntaxKind.GreaterThanToken) signature.angles -= 1;
        else if (
          kind === ts.SyntaxKind.OpenParenToken &&
          signature.angles === 0
        )
          signature.part = "parameters";
        else if (
          kind === ts.SyntaxKind.SemicolonToken ||
          kind === ts.SyntaxKind.OpenBraceToken
        )
          this.#signature = undefined;
      }
    }
    // A statement that ends with a type ends where a slash is written after
    // it, or where a line break stands after the type.
    // A contextual modifier with a line break after it modifies nothing.
    if (this.#nextAfterLineEnd && lineBreakBefore) this.#ambient = false;
    const typedStatementEnds =
      typeEnds && (lineBreakBefore || kind !== ts.SyntaxKind.OpenBraceToken);
    // A brace on the line under an operand's end cannot carry it on, and
    // begins a block: `f(x)` and the `{ ... }` under it are two statements.
    const beginsStatement =
      (this.#nextBeginsStatement ||
        typedStatementEnds ||
        ((this.#nextAfterLineEnd || this.#statementEndsAtLineBreak) &&
          lineBreakBefore) ||
        (kind === ts.SyntaxKind.OpenBraceToken &&
          this.#nextAfterExpression &&
          lineBreakBefore)) &&
      !memberName;
    /** Whether a word that cannot carry an expression on begins one here. */
    const wordBeginsStatement =
      beginsStatement || (this.#nextAfterExpression && !memberName);
    if (
      this.#candidate !== undefined &&
      !lineBreakBefore &&
      this.#candidate.follows.has(kind)
    )
      this.#declaration = {
        depth: this.#candidate.depth,
        members: this.#candidate.members,
        expression: false,
      };
    this.#candidate = undefined;
    let clauseEnds = false;
    if (this.#clause !== undefined && this.#clause.depth === depth) {
      if (kind === ts.SyntaxKind.ColonToken && this.#clause.questions === 0) {
        clauseEnds = true;
        this.#clause = undefined;
      } else if (this.#clause.default) this.#clause = undefined;
      else if (kind === ts.SyntaxKind.QuestionToken)
        this.#clause.questions += 1;
      else if (kind === ts.SyntaxKind.ColonToken) this.#clause.questions -= 1;
    }
    // The `:` after a name a variable statement binds writes its type: `const
    // l: string` labels nothing.
    const labelEnds =
      this.#label === depth &&
      kind === ts.SyntaxKind.ColonToken &&
      !(this.#typed?.part === "binding" && this.#typed.depth === depth);
    this.#label = undefined;
    if (!memberName) {
      const declares =
        kind === ts.SyntaxKind.ClassKeyword && this.#decorated !== undefined
          ? this.#decorated.beginsStatement
          : wordBeginsStatement;
      if (
        declares &&
        declarationKeywords.has(kind) &&
        !(kind === ts.SyntaxKind.FunctionKeyword && this.#ambient)
      )
        this.#declaration = {
          depth,
          members: kind !== ts.SyntaxKind.FunctionKeyword,
          expression: false,
        };
      else if (
        !declares &&
        (kind === ts.SyntaxKind.FunctionKeyword ||
          kind === ts.SyntaxKind.ClassKeyword)
      )
        this.#declaration = {
          depth,
          members: kind === ts.SyntaxKind.ClassKeyword,
          expression: true,
        };
      const follows = contextualDeclarationKeywords.get(kind);
      if (wordBeginsStatement && follows !== undefined)
        this.#candidate = {
          follows,
          depth,
          members: kind === ts.SyntaxKind.InterfaceKeyword,
        };
      if (
        wordBeginsStatement &&
        (kind === ts.SyntaxKind.CaseKeyword ||
          kind === ts.SyntaxKind.DefaultKeyword)
      )
        this.#clause = {
          depth,
          questions: 0,
          default: kind === ts.SyntaxKind.DefaultKeyword,
        };
      // A name after an operand begins a statement only on a line of its own:
      // the `T` of `c ? w as T : {}` is a type, and labels nothing.
      if (
        (beginsStatement || (wordBeginsStatement && lineBreakBefore)) &&
        kind === ts.SyntaxKind.Identifier
      )
        this.#label = depth;
      const typedStatement = typedStatements.get(kind);
      if (wordBeginsStatement && typedStatement !== undefined)
        this.#typedCandidate = { depth, ...typedStatement };
      if (wordBeginsStatement && kind === ts.SyntaxKind.FunctionKeyword)
        this.#signature = { depth, part: "header", angles: 0 };
      if (kind === ts.SyntaxKind.AtToken)
        this.#decorated ??= { beginsStatement: wordBeginsStatement, depth };
    }
    if (kind === ts.SyntaxKind.ClassKeyword) this.#decorated = undefined;
    this.#ambient = declarationModifiers.has(kind)
      ? this.#ambient ||
        (kind === ts.SyntaxKind.DeclareKeyword && wordBeginsStatement)
      : false;
    let closed: GroupHead | undefined;
    const opener = opens.get(kind);
    if (opener !== undefined) {
      const index = this.#open.findLastIndex((open) => open.opener === opener);
      if (index >= 0) {
        closed = this.#open[index]!.head;
        this.#open.length = index;
      }
      this.#closed = closed ?? "other";
    }
    if (kind === ts.SyntaxKind.OpenParenToken)
      this.#open.push({ opener: kind, head: this.#parenthesisHead() });
    else if (kind === ts.SyntaxKind.OpenBraceToken)
      this.#open.push({ opener: kind, head: this.#braceHead(beginsStatement) });
    else if (
      kind === ts.SyntaxKind.OpenBracketToken ||
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.TemplateMiddle
    )
      this.#open.push({
        opener:
          kind === ts.SyntaxKind.TemplateMiddle
            ? ts.SyntaxKind.TemplateHead
            : kind,
        head: "other",
      });
    if (this.#typed !== undefined && this.#open.length < this.#typed.depth)
      this.#typed = undefined;
    if (this.#signature !== undefined) {
      if (this.#open.length < this.#signature.depth)
        this.#signature = undefined;
      else if (
        this.#signature.part === "parameters" &&
        kind === ts.SyntaxKind.CloseParenToken &&
        this.#open.length === this.#signature.depth
      )
        this.#signature.part = "closed";
    }
    if (this.#declaration !== undefined) {
      // A `;` at the declaration's depth ends one with no body -- an
      // overload -- and a closer below it leaves the scope it was written in.
      if (
        this.#open.length < this.#declaration.depth ||
        (kind === ts.SyntaxKind.SemicolonToken &&
          this.#open.length === this.#declaration.depth)
      )
        this.#declaration = undefined;
    }
    // A member's decorators end at its name; a brace or a `;` where they
    // were written is past them, and so is a closer that leaves the group
    // they were written in: a parameter's, `(@Inject(T) t: T)`, or a last
    // member's with no `;` after it.
    if (
      this.#decorated !== undefined &&
      (this.#open.length < this.#decorated.depth ||
        ((kind === ts.SyntaxKind.OpenBraceToken ||
          kind === ts.SyntaxKind.SemicolonToken) &&
          depth === this.#decorated.depth))
    )
      this.#decorated = undefined;
    const innermost = this.#open.at(-1)?.head;
    const statements = holdsStatements(innermost);
    this.#nextBeginsStatement =
      statements &&
      (kind === ts.SyntaxKind.SemicolonToken ||
        clauseEnds ||
        labelEnds ||
        (!memberName &&
          (kind === ts.SyntaxKind.ElseKeyword ||
            kind === ts.SyntaxKind.DoKeyword)) ||
        (kind === ts.SyntaxKind.OpenBraceToken && holdsStatements(innermost)) ||
        // A statement begins after a block, a body that declares, or a
        // statement's head: `if (x) {} l: function g() {}` labels.
        closed === "block" ||
        closed === "members" ||
        closed === "statement" ||
        closed === "for" ||
        (!memberName && declarationModifiers.has(kind) && wordBeginsStatement));
    this.#nextAfterLineEnd =
      statements && !memberName && endsStatementAtLineBreak.has(kind);
    let closesStatement = false;
    if (
      kind === ts.SyntaxKind.OpenBraceToken &&
      (((this.#previous === ts.SyntaxKind.WithKeyword ||
        this.#previous === ts.SyntaxKind.AssertKeyword) &&
        this.#beforePrevious === ts.SyntaxKind.StringLiteral) ||
        this.#previous === ts.SyntaxKind.ExportKeyword ||
        (this.#previous === ts.SyntaxKind.TypeKeyword &&
          this.#beforePrevious === ts.SyntaxKind.ExportKeyword))
    )
      this.#closesStatement = depth;
    else if (
      kind === ts.SyntaxKind.CloseBraceToken &&
      this.#closesStatement !== undefined &&
      this.#open.length <= this.#closesStatement
    ) {
      closesStatement = this.#open.length === this.#closesStatement;
      this.#closesStatement = undefined;
    }
    this.#statementEndsAtLineBreak =
      statements &&
      (closesStatement ||
        (kind === ts.SyntaxKind.StringLiteral &&
          (this.#previous === ts.SyntaxKind.FromKeyword ||
            this.#previous === ts.SyntaxKind.ImportKeyword)) ||
        (kind === ts.SyntaxKind.Identifier &&
          !lineBreakBefore &&
          (this.#previous === ts.SyntaxKind.BreakKeyword ||
            this.#previous === ts.SyntaxKind.ContinueKeyword)));
    this.#nextAfterExpression =
      statements &&
      judged &&
      !(declarationModifiers.has(kind) && !memberName) &&
      (memberName || tokenCanEndExpression(kind));
    if (judged)
      this.#allowed =
        closed === "statement" ||
        closed === "for" ||
        closed === "block" ||
        closed === "members"
          ? true
          : memberName
            ? false
            : kind === ts.SyntaxKind.ExclamationToken
              ? // A `!` on its operand's own line is a non-null assertion, and
                // the operand it ends still ends there: TypeScript writes
                // `LeftHandSideExpression [no LineTerminator here] !`, so
                // `a! / 2` divides. Anywhere else it is the prefix operator.
                lineBreakBefore || this.#allowed
              : kind === ts.SyntaxKind.OfKeyword
                ? this.#open.at(-1)?.head === "for"
                : !tokenCanEndExpression(kind);
    this.#beforePrevious = this.#previous;
    this.#previous = kind;
  }

  /**
   * Whether the latest token is the keyword it is spelled as, rather than a
   * member named after it: `o.if (x)` calls a method.
   */
  #keyword(): boolean {
    return (
      this.#beforePrevious !== ts.SyntaxKind.DotToken &&
      this.#beforePrevious !== ts.SyntaxKind.QuestionDotToken
    );
  }

  #parenthesisHead(): GroupHead {
    const previous = this.#previous;
    if (previous === undefined) return "other";
    const head = statementHeads.get(previous);
    if (head !== undefined) return this.#keyword() ? head : "other";
    // `for await (`.
    return previous === ts.SyntaxKind.AwaitKeyword &&
      this.#beforePrevious === ts.SyntaxKind.ForKeyword
      ? "for"
      : "other";
  }

  /**
   * What the brace being opened holds, `beginsStatement` saying whether it
   * begins a statement.
   */
  #braceHead(beginsStatement: boolean): GroupHead {
    const previous = this.#previous;
    const typed = previous !== undefined && typeBraceAfter.has(previous);
    if (this.#declaration?.depth === this.#open.length && !typed) {
      const { members, expression } = this.#declaration;
      this.#declaration = undefined;
      if (members) return expression ? "class" : "members";
      return expression ? "body" : "block";
    }
    // What `export default` is followed by in braces is an object.
    if (previous === ts.SyntaxKind.DefaultKeyword && this.#keyword())
      return "other";
    // A brace that begins a statement is a block; and among a class's
    // members one after a parameter list, a return type or `static` is a
    // method's body or a static block, where one after an operator is an
    // object written in an initializer.
    if (beginsStatement) return "block";
    if (
      holdsMembers(this.#open.at(-1)?.head) &&
      previous !== undefined &&
      !typed &&
      (tokenCanEndExpression(previous) ||
        previous === ts.SyntaxKind.StaticKeyword ||
        previous === ts.SyntaxKind.GreaterThanToken ||
        previous === ts.SyntaxKind.VoidKeyword)
    )
      return "block";
    // After any other parameter list, a method's body: written in an object,
    // nothing else takes a brace after a parenthesis.
    if (previous === ts.SyntaxKind.CloseParenToken)
      return this.#closed === "statement" ||
        this.#closed === "for" ||
        this.#closed === "catch"
        ? "block"
        : "body";
    if (previous === ts.SyntaxKind.EqualsGreaterThanToken) return "block";
    return previous !== undefined && blockHeads.has(previous) && this.#keyword()
      ? "block"
      : "other";
  }
}

/**
 * Where the regular expression a slash at `offset` would begin ends, read as
 * one; undefined where none would end on the slash's own line.
 */
export function regularExpressionEnd(
  source: string,
  offset: number,
): number | undefined {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  scanner.setText(source, offset);
  const kind = scanner.scan();
  if (
    kind !== ts.SyntaxKind.SlashToken &&
    kind !== ts.SyntaxKind.SlashEqualsToken
  )
    throw new RangeError(`No slash at offset ${String(offset)}`);
  if (
    scanner.reScanSlashToken() !== ts.SyntaxKind.RegularExpressionLiteral ||
    scanner.isUnterminated()
  )
    return undefined;
  return scanner.getTokenEnd();
}

export function scanWithSupportedTypeScript(
  source: string,
  variant: ScannerLanguageVariant,
  beforeToken: () => void = () => {},
  readings: TokenReadings = new Map(),
): TypeScriptScanResult {
  assertSupportedTypeScriptVersion(ts.version);
  const errors: TypeScriptScannerError[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    variant === "jsx" ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );
  scanner.setOnError((message, length) => {
    // TypeScript moves the scanner to where the error begins for the length
    // of the callback, so the position it reports is the start; taking it for
    // the end put an unterminated regular expression `length` characters in
    // front of its slash.
    errors.push(
      Object.freeze({
        start: scanner.getTextPos(),
        length,
        message: ts.flattenDiagnosticMessageText(message.message, "\n"),
      }),
    );
  });
  /**
   * The scanner the JSX lookahead reads with. It is its own, because the one
   * above stands mid-file wherever the question is asked, and it skips trivia
   * because the lookahead has no use for any. Nothing it reads is reported:
   * whatever it makes of source the scan has not reached yet, the scan reads
   * again for itself.
   */
  const lookahead = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
  );

  const tokens: TypeScriptScannedToken[] = [];
  const templateSubstitutions: { braceDepth: number }[] = [];
  const jsxContainers: JsxContainer[] = [];
  const jsxExpressionReturns: ("tag" | "text")[] = [];
  const jsxExpressionBraceDepth: number[] = [];
  let jsxMode: JsxMode = "standard";
  let closingTag = false;
  let selfClosingTag = false;
  /**
   * How many `<` of the current tag's type arguments are still open.
   * `<Comp<string> value={x} />` is a generic element, and the `>` that closes
   * its type arguments is not the one that ends the tag. Taking that `>` as the
   * tag's own would move the scanner into text mode, so the attributes after it
   * would be scanned as JSX text and a `>` among them reported as needing
   * escaping.
   */
  let typeArgumentDepth = 0;
  const judgement = new SlashJudgement(true);
  /** Whether a line break stands between the last token and this one. */
  let lineBreakBefore = false;
  /** The kind of the token before this one, trivia included. */
  let previousKind: ts.SyntaxKind | undefined;
  /** The kind of the last token before this one that was not trivia. */
  let previousSignificantKind: ts.SyntaxKind | undefined;
  /**
   * The opening token of each group the scan stands inside, innermost last:
   * a parenthesis, bracket or brace, or a template's head for its
   * substitution. The brace that opens a JSX expression is recorded as
   * `JsxExpression`, since what it holds is an expression and never a member.
   * Only `beginsMember` asks, and only which one is innermost.
   */
  const openGroups: ts.SyntaxKind[] = [];
  /** The offsets of `readings` the scan has read a slash or a `<` at. */
  const read = new Set<number>();
  /**
   * Whether the `<` at `start`, standing where an expression may begin,
   * opens an element: as `readings` says where it says, which is where the
   * enforester found the judgement below wrong, and otherwise as the tokens
   * around it say (`looksLikeJsxStart`).
   */
  const opensElement = (start: number): boolean => {
    const reading = readings.get(start);
    if (reading === "element" || reading === "type-parameters") {
      read.add(start);
      return reading === "element";
    }
    // A list of statements holds no member, and what begins one there is an
    // element: `function g() { <b>(note): x</b>; }`.
    return looksLikeJsxStart(
      lookahead,
      source,
      start,
      readings,
      !judgement.inStatements &&
        beginsMember(
          previousSignificantKind,
          openGroups.at(-1),
          lineBreakBefore,
        ),
    );
  };
  while (true) {
    beforeToken();
    const scanStart = scanner.getTextPos();
    const errorsBeforeScan = errors.length;
    const modeBeforeScan = jsxMode;
    // A tag's type arguments are a type argument list, not tag syntax: what
    // is written inside them is scanned as it would be anywhere else, so
    // `<Comp<list<string>> />` names `list` with an ordinary identifier. Only
    // the `<` and `>` that delimit them stay tag syntax, which is how the
    // delimiter reader tells them from a nested element.
    const insideTypeArguments = jsxMode === "tag" && typeArgumentDepth > 0;
    /** Whether this token is the `>` that ends an element. */
    let elementEnds = false;
    let kind: ts.SyntaxKind;
    if (jsxMode === "text") {
      kind = scanner.scanJsxToken();
    } else if (
      jsxMode === "tag" &&
      !insideTypeArguments &&
      previousKind === ts.SyntaxKind.EqualsToken &&
      (source.charCodeAt(scanStart) === 0x22 /* " */ ||
        source.charCodeAt(scanStart) === 0x27) /* ' */
    ) {
      // An attribute's string value, which TypeScript scans with JSX's own
      // rule when it is written straight after the `=`: a backslash escapes
      // nothing and the string may run across lines. After a space it scans an
      // ordinary string, and so does the branch below. The scanner leaves the
      // token's start where the `=` began, so it is set here first.
      scanner.resetTokenState(scanStart);
      kind = scanner.scanJsxAttributeValue();
    } else {
      kind = scanner.scan();
      if (
        kind === ts.SyntaxKind.PrivateIdentifier &&
        scanner.getTokenText() === "#"
      ) {
        kind = scanner.reScanHashToken();
        const hashErrors = errors.slice(errorsBeforeScan);
        if (
          hashErrors.length > 0 &&
          hashErrors.every(
            (error) =>
              error.length === 1 && error.message === "Invalid character.",
          )
        ) {
          errors.splice(errorsBeforeScan);
        }
      } else if (
        jsxMode === "tag" &&
        !insideTypeArguments &&
        kind === ts.SyntaxKind.Identifier
      ) {
        kind = scanner.scanJsxIdentifier();
      } else if (
        (jsxMode === "standard" || jsxMode === "expression") &&
        (kind === ts.SyntaxKind.SlashToken ||
          kind === ts.SyntaxKind.SlashEqualsToken)
      ) {
        const start = scanner.getTokenStart();
        if (readings.has(start)) read.add(start);
        if (
          readsRegularExpression(
            readings,
            start,
            judgement.beginsExpression(kind, lineBreakBefore),
          )
        ) {
          const errorsBeforeRescan = errors.length;
          const slash = kind;
          kind = scanner.reScanSlashToken();
          // After a `>` the judgement cannot tell type arguments from a
          // comparison, and a regular expression begun there that does not
          // end on its line is none: `a<number> / 2` divides. Anywhere else an
          // operand begins at the slash, and one that does not end is an
          // unterminated regular expression, reported as one.
          if (
            !readings.has(start) &&
            previousSignificantKind === ts.SyntaxKind.GreaterThanToken &&
            scanner.isUnterminated()
          ) {
            errors.splice(errorsBeforeRescan);
            scanner.resetTokenState(start);
            kind = scanner.scan();
            if (kind !== slash)
              throw new Error(
                `Scanning the slash at ${String(start)} again read a ${ts.SyntaxKind[kind]}`,
              );
          }
        }
      }
    }

    if (kind === ts.SyntaxKind.TemplateHead) {
      templateSubstitutions.push({ braceDepth: 0 });
    } else {
      const substitution = templateSubstitutions.at(-1);
      if (substitution !== undefined) {
        if (kind === ts.SyntaxKind.OpenBraceToken) {
          substitution.braceDepth += 1;
        } else if (kind === ts.SyntaxKind.CloseBraceToken) {
          if (substitution.braceDepth > 0) {
            substitution.braceDepth -= 1;
          } else {
            kind = scanner.reScanTemplateToken(false);
            if (kind === ts.SyntaxKind.TemplateTail) {
              templateSubstitutions.pop();
            }
          }
        }
      }
    }

    let modeForToken = modeBeforeScan;
    if (
      variant === "jsx" &&
      (jsxMode === "standard" || jsxMode === "expression") &&
      kind === ts.SyntaxKind.LessThanToken &&
      // JSX can only begin where an expression can begin, which is the same
      // position a regular expression can. After anything that ends one — an
      // identifier, `)`, a literal — a `<` opens type arguments or is a
      // comparison. Deciding from the lookahead alone read the `<T>` of
      // `declare function useState<T>(v: T)` as an element and reported a
      // missing closing tag for a line that is ordinary TSX.
      // Where a reading says what the `<` opens, the enforester found an
      // expression or a type begin there, whatever the token before it led
      // this judgement to expect -- as for a slash.
      (readsAngle(readings, scanner.getTokenStart()) ||
        (judgement.beginsExpression(kind, lineBreakBefore) &&
          // `f?.<string>()` passes type arguments to an optional call: a `<`
          // straight after `?.` opens nothing else.
          previousSignificantKind !== ts.SyntaxKind.QuestionDotToken)) &&
      opensElement(scanner.getTokenStart())
    ) {
      jsxContainers.push({ returnMode: jsxMode, depth: 0 });
      jsxMode = "tag";
      closingTag = false;
      selfClosingTag = false;
      typeArgumentDepth = 0;
      modeForToken = "tag";
    } else if (jsxMode === "text") {
      if (
        kind === ts.SyntaxKind.LessThanToken ||
        kind === ts.SyntaxKind.LessThanSlashToken
      ) {
        closingTag = kind === ts.SyntaxKind.LessThanSlashToken;
        selfClosingTag = false;
        typeArgumentDepth = 0;
        jsxMode = "tag";
        modeForToken = "tag";
      } else if (kind === ts.SyntaxKind.OpenBraceToken) {
        jsxExpressionReturns.push("text");
        jsxExpressionBraceDepth.push(0);
        jsxMode = "expression";
      }
    } else if (
      jsxMode === "tag" &&
      !insideTypeArguments &&
      kind === ts.SyntaxKind.LessThanToken &&
      previousSignificantKind === ts.SyntaxKind.EqualsToken
    ) {
      // An element written as an attribute's value, `<a b=<c />>`. The tag
      // it stands in resumes once it closes, still among its attributes.
      jsxContainers.push({ returnMode: "tag", depth: 0 });
      closingTag = false;
      selfClosingTag = false;
      typeArgumentDepth = 0;
    } else if (jsxMode === "tag") {
      if (kind === ts.SyntaxKind.LessThanSlashToken) {
        closingTag = true;
      } else if (kind === ts.SyntaxKind.SlashToken) {
        selfClosingTag = true;
      } else if (kind === ts.SyntaxKind.OpenBraceToken) {
        jsxExpressionReturns.push("tag");
        jsxExpressionBraceDepth.push(0);
        jsxMode = "expression";
      } else if (kind === ts.SyntaxKind.LessThanToken) {
        typeArgumentDepth += 1;
      } else if (
        typeArgumentDepth > 0 &&
        kind === ts.SyntaxKind.GreaterThanToken
      ) {
        // One angle per token: TypeScript's scanner emits `GreaterThanToken`
        // per character and leaves joining a run of them to
        // `reScanGreaterToken`, which nothing here calls. So
        // `Array<Set<string>>` closes its two type-argument lists with two
        // tokens, one at a time.
        typeArgumentDepth -= 1;
      } else if (kind === ts.SyntaxKind.GreaterThanToken) {
        const container = jsxContainers.at(-1);
        if (container !== undefined) {
          if (closingTag) container.depth -= 1;
          else if (!selfClosingTag) container.depth += 1;
          if (container.depth <= 0) {
            jsxContainers.pop();
            jsxMode = container.returnMode;
            elementEnds = true;
          } else {
            jsxMode = "text";
          }
        }
        closingTag = false;
        selfClosingTag = false;
      }
    } else if (jsxMode === "expression" && templateSubstitutions.length === 0) {
      const expressionIndex = jsxExpressionBraceDepth.length - 1;
      if (kind === ts.SyntaxKind.OpenBraceToken) {
        const depth = jsxExpressionBraceDepth[expressionIndex];
        if (depth !== undefined) {
          jsxExpressionBraceDepth[expressionIndex] = depth + 1;
        }
      } else if (kind === ts.SyntaxKind.CloseBraceToken) {
        const depth = jsxExpressionBraceDepth[expressionIndex];
        if (depth === 0) {
          jsxExpressionBraceDepth.pop();
          jsxMode = jsxExpressionReturns.pop() ?? "standard";
        } else if (depth !== undefined) {
          jsxExpressionBraceDepth[expressionIndex] = depth - 1;
        }
      }
    }

    if (
      insideTypeArguments &&
      modeForToken === "tag" &&
      kind !== ts.SyntaxKind.LessThanToken &&
      kind !== ts.SyntaxKind.GreaterThanToken
    ) {
      modeForToken = "standard";
    }

    const lexicalMode = tokenLexicalMode(kind, modeForToken);
    if (projectTriviaKind(kind) !== undefined) {
      if (/[\r\n\u2028\u2029]/u.test(scanner.getTokenText()))
        lineBreakBefore = true;
    } else {
      // Only the text says nothing of what follows it: the `{` of a
      // container scanned in the text opens an expression, and a slash after
      // it begins one -- `{a}{/re/.test(s)}`.
      judgement.take(
        kind,
        lineBreakBefore,
        kind !== ts.SyntaxKind.JsxText &&
          kind !== ts.SyntaxKind.JsxTextAllWhiteSpaces,
      );
      if (elementEnds) judgement.endOperand();
      lineBreakBefore = false;
      previousSignificantKind = kind;
      if (
        kind === ts.SyntaxKind.OpenBraceToken &&
        (modeBeforeScan === "text" ||
          (modeBeforeScan === "tag" && !insideTypeArguments))
      )
        openGroups.push(ts.SyntaxKind.JsxExpression);
      else if (
        kind === ts.SyntaxKind.OpenParenToken ||
        kind === ts.SyntaxKind.OpenBracketToken ||
        kind === ts.SyntaxKind.OpenBraceToken ||
        kind === ts.SyntaxKind.TemplateHead
      )
        openGroups.push(kind);
      else if (
        kind === ts.SyntaxKind.CloseParenToken ||
        kind === ts.SyntaxKind.CloseBracketToken ||
        kind === ts.SyntaxKind.CloseBraceToken ||
        kind === ts.SyntaxKind.TemplateTail
      )
        openGroups.pop();
    }
    previousKind = kind;
    if (
      kind !== ts.SyntaxKind.EndOfFileToken &&
      scanner.getTextPos() <= scanStart
    ) {
      throw new Error(
        `TypeScript scanner made no progress at offset ${String(scanStart)} in ${jsxMode} mode`,
      );
    }
    tokens.push(
      Object.freeze({
        kind,
        kindName: ts.SyntaxKind[kind] ?? `SyntaxKind(${String(kind)})`,
        projectKind: projectTokenKind(kind, lexicalMode),
        triviaKind: projectTriviaKind(kind),
        lexicalMode,
        start: scanner.getTokenStart(),
        end: scanner.getTokenEnd(),
        raw: scanner.getTokenText(),
        value: scanner.getTokenValue(),
        precededByLineBreak: scanner.hasPrecedingLineBreak(),
        unterminated: scanner.isUnterminated(),
      }),
    );
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
  }
  return Object.freeze({
    tokens: Object.freeze(tokens),
    errors: Object.freeze(errors),
    version: ts.version,
    unread: Object.freeze(
      [...readings.keys()].filter((offset) => !read.has(offset)),
    ),
  });
}
