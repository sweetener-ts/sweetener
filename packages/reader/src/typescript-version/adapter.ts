import type { LexicalMode, TokenKind, TriviaKind } from "@sweetener/syntax";
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
  readonly returnMode: "standard" | "expression";
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
): ts.SyntaxKind {
  let kind = lookahead.scan();
  if (
    regularExpressionAllowed &&
    (kind === ts.SyntaxKind.SlashToken ||
      kind === ts.SyntaxKind.SlashEqualsToken)
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

/** Whether a token opens a parenthesis, bracket or brace group. */
function opensGroup(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.OpenParenToken ||
    kind === ts.SyntaxKind.OpenBracketToken ||
    kind === ts.SyntaxKind.OpenBraceToken
  );
}

/** Whether a token closes one. */
function closesGroup(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.CloseParenToken ||
    kind === ts.SyntaxKind.CloseBracketToken ||
    kind === ts.SyntaxKind.CloseBraceToken
  );
}

/**
 * Whether a `>` closes the type parameters of a function type rather than a
 * JSX opening tag: `<T>(v: T) => T`, which is how a generic function type is
 * written in an annotation or a type alias. An element with children can have
 * a `(` next too -- `<div>(text)</div>` -- but its parentheses are text and no
 * `=>` follows them, so the arrow is what tells the two apart.
 *
 * TypeScript decides this from the parser's position rather than by lookahead,
 * knowing whether a type or an expression is expected. A token-level scanner
 * does not know, and after `:` or `=` either one may begin.
 *
 * The lookahead stands at the `>` its caller has just read, and reads on from
 * there.
 */
function functionTypeFollows(
  lookahead: ts.Scanner,
  templates: TemplateSubstitutions,
): boolean {
  if (
    nextLookaheadToken(lookahead, templates, false) !==
    ts.SyntaxKind.OpenParenToken
  )
    return false;
  let depth = 1;
  let regularExpressionAllowed = true;
  while (depth > 0) {
    const kind = nextLookaheadToken(
      lookahead,
      templates,
      regularExpressionAllowed,
    );
    if (kind === ts.SyntaxKind.EndOfFileToken) return false;
    if (kind === ts.SyntaxKind.OpenParenToken) depth += 1;
    else if (kind === ts.SyntaxKind.CloseParenToken) depth -= 1;
    regularExpressionAllowed = !tokenCanEndExpression(kind);
  }
  return (
    nextLookaheadToken(lookahead, templates, false) ===
    ts.SyntaxKind.EqualsGreaterThanToken
  );
}

/**
 * Whether the `<` at `start` opens a JSX element rather than the type
 * parameters of a generic arrow.
 *
 * A comma or an `extends` before the closing `>` means type parameters: `<T,>`
 * and `<T extends U>` are the two spellings that are unambiguous in TSX, and
 * neither is an element. Only what is written directly inside this `<` says
 * that: a comma nested in the tag's own type arguments -- `<Comp<A, B> />`,
 * `<Comp<Map<K, V>> />` -- or one inside an attribute value is a comma of that
 * region, and reading it as the `<T,>` of a generic arrow left the element
 * ungrouped, its tag a run of loose tokens that nothing walked.
 *
 * Which comma is which is a question about tokens, so this reads tokens. A
 * character scan cannot tell a regular expression from a division, and a
 * regular expression holding a bracket, a quote or a comment's opening left
 * the scan looking for a region's end that never came: it ran to the end of
 * the file and reported no element, so `<div title={/\(/.source} />` lost its
 * grouping and every one of its tag's lexical modes. Scanning it as TypeScript
 * does costs one rescan and answers exactly.
 *
 * The walk ends at the first token that stands in neither grammar at the top
 * level of a `<`: a `;`, or a closer for a group that was never opened. A tag
 * writes neither, and a type argument list writes a `;` only inside the braces
 * of an object type, so reaching one means this `<` opens nothing -- and the
 * walk stops there rather than reading to the end of the file at every `<`.
 */
function looksLikeJsxStart(
  lookahead: ts.Scanner,
  source: string,
  start: number,
): boolean {
  if (source.charCodeAt(start + 1) === 0x3e /* > */) return true;
  const nameStart = start + 1;
  if (nameStart >= source.length || !identifierStart.test(source[nameStart]!))
    return false;
  lookahead.setText(source, nameStart);
  const templates: TemplateSubstitutions = [];
  /** How many `<` of the tag's own type arguments are still open. */
  let angles = 0;
  /** How many brace, bracket and parenthesis groups the walk stands inside. */
  let groups = 0;
  let regularExpressionAllowed = false;
  for (;;) {
    // An attribute's braces are the only place inside a tag or a type argument
    // list where an expression is written, so they are the only place a `/`
    // can begin a regular expression. Outside them a `/` closes the tag.
    const kind = nextLookaheadToken(
      lookahead,
      templates,
      groups > 0 && regularExpressionAllowed,
    );
    regularExpressionAllowed = !tokenCanEndExpression(kind);
    if (kind === ts.SyntaxKind.EndOfFileToken) return false;
    if (opensGroup(kind)) {
      groups += 1;
      continue;
    }
    if (closesGroup(kind)) {
      if (groups === 0) return false;
      groups -= 1;
      continue;
    }
    if (groups > 0) continue;
    if (kind === ts.SyntaxKind.LessThanToken) {
      angles += 1;
      continue;
    }
    if (kind === ts.SyntaxKind.GreaterThanToken) {
      if (angles > 0) {
        angles -= 1;
        continue;
      }
      return !functionTypeFollows(lookahead, templates);
    }
    if (angles > 0) continue;
    if (
      kind === ts.SyntaxKind.CommaToken ||
      kind === ts.SyntaxKind.ExtendsKeyword ||
      kind === ts.SyntaxKind.SemicolonToken
    )
      return false;
  }
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

export function scanWithSupportedTypeScript(
  source: string,
  variant: ScannerLanguageVariant,
  beforeToken: () => void = () => {},
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
    const end = scanner.getTextPos();
    errors.push(
      Object.freeze({
        start: Math.max(0, end - length),
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
  let regularExpressionAllowed = true;
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
    let kind: ts.SyntaxKind;
    if (jsxMode === "text") {
      kind = scanner.scanJsxToken();
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
        regularExpressionAllowed &&
        (kind === ts.SyntaxKind.SlashToken ||
          kind === ts.SyntaxKind.SlashEqualsToken)
      ) {
        kind = scanner.reScanSlashToken();
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
      regularExpressionAllowed &&
      looksLikeJsxStart(lookahead, source, scanner.getTokenStart())
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
    if (projectTriviaKind(kind) === undefined && lexicalMode !== "jsx-text") {
      regularExpressionAllowed = !tokenCanEndExpression(kind);
    }
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
  });
}
