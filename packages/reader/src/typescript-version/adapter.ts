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
 * each was a chain of comparisons that ended, for the commonest answers —
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

/** How many `>` a merged closing-angle token spells, or zero if it is not one. */
function closingAngleWidth(kind: ts.SyntaxKind): number {
  switch (kind) {
    case ts.SyntaxKind.GreaterThanToken:
      return 1;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return 2;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return 3;
    default:
      return 0;
  }
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
const identifierPart = /[\p{ID_Continue}.$:-]/u;

/**
 * Whether the `<` at `start` opens a JSX element rather than type arguments.
 *
 * Read directly out of the source rather than by slicing it and matching two
 * regular expressions against the slice. Both are linear — V8 slices a long
 * string by taking a view of it, not by copying — but this runs at every `<`
 * in expression position, and doing it without allocating is about twice as
 * fast on element-dense source.
 */
function looksLikeJsxStart(source: string, start: number): boolean {
  if (source.charCodeAt(start + 1) === 0x3e /* > */) return true;
  const nameStart = start + 1;
  if (nameStart >= source.length || !identifierStart.test(source[nameStart]!))
    return false;
  // A comma or an `extends` before the closing `>` means type parameters:
  // `<T,>` and `<T extends U>` are the two spellings that are unambiguous in
  // TSX, and neither is an element.
  for (let index = nameStart + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === ">") return true;
    if (character === ",") return false;
    if (
      character === "e" &&
      source.startsWith("extends", index) &&
      !identifierPart.test(source[index - 1] ?? "") &&
      !identifierPart.test(source[index + 7] ?? "")
    )
      return false;
  }
  return false;
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
   * its type arguments is not the one that ends the tag. Counting the tag's own
   * `>` there moved the scanner into text mode, so the attributes after it were
   * scanned as JSX text and a `>` among them was reported as needing escaping.
   */
  let typeArgumentDepth = 0;
  let regularExpressionAllowed = true;
  while (true) {
    beforeToken();
    const scanStart = scanner.getTextPos();
    const errorsBeforeScan = errors.length;
    const modeBeforeScan = jsxMode;
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
      } else if (jsxMode === "tag" && kind === ts.SyntaxKind.Identifier) {
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
      looksLikeJsxStart(source, scanner.getTokenStart())
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
      } else if (typeArgumentDepth > 0 && closingAngleWidth(kind) > 0) {
        // `Array<Set<string>>` closes two at once: outside JSX text the
        // scanner merges the run of `>` into one token.
        typeArgumentDepth = Math.max(
          0,
          typeArgumentDepth - closingAngleWidth(kind),
        );
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
