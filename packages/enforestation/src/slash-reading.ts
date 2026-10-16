import type {
  CaptureId,
  OriginId,
  SourceId,
  SyntaxId,
} from "@sweetener/shared";
import {
  divisionTokens,
  printLossless,
  regularExpressionEnd,
} from "@sweetener/reader";
import {
  createSpan,
  createToken,
  createTrivia,
  firstToken,
  spanEnvelope,
  type OriginStore,
  type Span,
  type Syntax,
  type SyntaxCursor,
  type TokenSyntax,
  type Trivia,
} from "@sweetener/syntax";

/**
 * What reading a slash read one way as the other leaves to be done where it
 * stands, when it is more than the tokens of the one expression.
 *
 * The reader judges a slash from the token before it (see `SlashReadings`),
 * and the parser finds where it judged wrong. Where reading the slash the
 * other way changes only which tokens the expression is made of -- `/re/`
 * read as `/`, `re` and `/`, with nothing between the slashes that opens or
 * closes a group, and every token after it read the same either way -- the
 * parser reads them again where they stand, and nothing else changes. Where
 * it changes more -- a bracket or a quote inside the expression, a comment's
 * opening, the `=` of a `/=` -- the groups and tokens after the slash are not
 * the ones the source holds, and only reading the source again gives them.
 */
export interface Reread {
  readonly kind: "reread";
}

const reread: Reread = Object.freeze({ kind: "reread" });

export interface SlashTokenOptions {
  readonly origins: OriginStore;
  readonly allocateSyntaxId: () => SyntaxId;
}

/** A regular expression the parser read out of tokens read as a division. */
export interface RegularExpressionRead {
  readonly kind: "regular-expression";
  readonly token: TokenSyntax;
  /** How many of the nodes at the cursor it is read from. */
  readonly width: number;
}

/**
 * The regular expression literal the division slash at the cursor begins,
 * where the grammar reads an operand there: `if (c)` and the `/re/.test(s)`
 * under a `let x: T`, or a template's `$k / 2 /g` given `return` for `$k`.
 *
 * Its text is the text of the nodes it is written over, as they stand here,
 * so a template's slashes are read as each use of it writes them. Undefined
 * where no regular expression ends on the slash's line, which is no operand
 * at all.
 */
export function regularExpressionAt(
  cursor: SyntaxCursor,
  options: SlashTokenOptions,
): RegularExpressionRead | Reread | undefined {
  const nodes: Syntax[] = [];
  const ends: number[] = [];
  let text = "";
  /** The trivia written after the node before, which is in front of this one. */
  let tail = "";
  for (let offset = 0; ; offset += 1) {
    const node = cursor.peek(offset);
    if (
      node === undefined ||
      (node.tag === "token" && node.kind === "end-of-file")
    )
      break;
    const written = printLossless(node);
    const head = triviaText(firstToken(node)?.leadingTrivia ?? []);
    const after = triviaText(lastToken(node)?.trailingTrivia ?? []);
    // A regular expression ends on its own line. Read as a division, what it
    // is written with there may be a comment: `/a\/\/b/` is `/`, `a`, `\` and
    // a line comment.
    const between = offset === 0 ? "" : tail + head;
    const lineEnd = between.search(lineBreak);
    if (lineEnd >= 0) {
      text += between.slice(0, lineEnd);
      break;
    }
    text += between;
    const own = written.slice(head.length, written.length - after.length);
    text += own;
    ends.push(text.length);
    nodes.push(node);
    tail = after;
    if (lineBreak.test(own)) break;
  }
  const end = regularExpressionEnd(text, 0);
  if (end === undefined) return undefined;
  const width = ends.indexOf(end) + 1;
  const run = nodes.slice(0, width);
  const following = nodes[width];
  if (
    width === 0 ||
    !run.every(
      (node): node is TokenSyntax =>
        node.tag === "token" &&
        // A delimiter read where nothing opened it, or a character the
        // reader could not read, was reported where it was read.
        !delimiters.has(node.raw) &&
        node.kind !== "unknown",
    ) ||
    // After a division the reader may have read a `<` as the start of an
    // element, which after a regular expression it is not.
    (following?.tag === "group" &&
      (following.delimiter === "jsx-element" ||
        following.delimiter === "jsx-fragment"))
  )
    return reread;
  const first = run[0]!;
  const last = run.at(-1)!;
  const raw = text.slice(0, end);
  return Object.freeze({
    kind: "regular-expression",
    token: createToken({
      id: options.allocateSyntaxId(),
      span: spanEnvelope(run.map(({ span }) => span)),
      origin: joinedOrigin(options.origins, run),
      scopes: first.scopes,
      kind: "regular-expression-literal",
      raw,
      value: raw,
      leadingTrivia: first.leadingTrivia,
      trailingTrivia: last.trailingTrivia,
      lexicalMode: "regular-expression",
    }),
    width,
  });
}

/**
 * The tokens the regular expression literal `token` reads as where its slash
 * is a division, where the grammar takes an operator there: `x = of / 2 / 3`
 * divides a name spelled `of`. `following` is the node after it.
 */
export function divisionAt(
  token: TokenSyntax,
  following: Syntax | undefined,
  options: SlashTokenOptions,
): readonly TokenSyntax[] | Reread {
  // An unterminated literal was reported where it was read.
  if (regularExpressionEnd(token.raw, 0) !== token.raw.length) return reread;
  const scanned = divisionTokens(token.raw);
  if (scanned === undefined) return reread;
  const tokens = scanned.filter(({ kind }) => kind !== "end-of-file");
  const last = tokens.at(-1);
  if (
    last === undefined ||
    tokens.some(
      ({ raw, kind }) =>
        delimiters.has(raw) ||
        kind === "template-head" ||
        kind === "template-middle" ||
        kind === "template-tail",
    ) ||
    // Ending in an operator, the tokens leave an operand to come, and the
    // reader read a slash or a `<` after the literal as an operator. Read
    // after this one it may begin an operand of its own.
    (last.kind === "punctuation" &&
      (firstToken(following)?.raw.startsWith("/") === true ||
        firstToken(following)?.raw === "<"))
  )
    return reread;
  const at = splitPosition(options.origins, token);
  return Object.freeze(
    tokens.map((scannedToken, index) => {
      const span = createSpan(
        token.span.start + scannedToken.span.start,
        token.span.start + scannedToken.span.end,
      );
      return createToken({
        id: options.allocateSyntaxId(),
        span,
        origin: at(scannedToken.span.start, scannedToken.span.end),
        scopes: token.scopes,
        kind: scannedToken.kind,
        raw: scannedToken.raw,
        value: scannedToken.value,
        leadingTrivia:
          index === 0
            ? token.leadingTrivia
            : scannedToken.leadingTrivia.map((trivia) =>
                createTrivia({
                  ...trivia,
                  span: createSpan(
                    token.span.start + trivia.span.start,
                    token.span.start + trivia.span.end,
                  ),
                }),
              ),
        trailingTrivia: index === tokens.length - 1 ? token.trailingTrivia : [],
      });
    }),
  );
}

const delimiters = new Set(["(", ")", "[", "]", "{", "}"]);

const lineBreak = /[\r\n\u2028\u2029]/u;

function triviaText(trivia: readonly Trivia[]): string {
  return trivia.map(({ raw }) => raw).join("");
}

function lastToken(syntax: Syntax): TokenSyntax | undefined {
  switch (syntax.tag) {
    case "token":
      return syntax;
    case "group":
      return syntax.close.tag === "token" ? syntax.close : undefined;
    case "protected":
    case "root": {
      const last = syntax.children.at(-1);
      return last === undefined ? undefined : lastToken(last);
    }
  }
}

/**
 * Where the regular expression read out of `tokens` was written: the source
 * they were all read from, over the whole of it, or a copy of that by the one
 * capture that copied them all, so that what is said about the expression is
 * said about all of it. Tokens from anywhere else -- a template, or a
 * template and a capture both -- are written in more than one place, and the
 * expression was written in all of them.
 */
function joinedOrigin(
  origins: OriginStore,
  tokens: readonly TokenSyntax[],
): OriginId {
  const sources = tokens.map((token) => writtenSpan(origins, token.origin));
  const [first] = sources;
  if (
    first !== undefined &&
    sources.every(
      (source) =>
        source !== undefined &&
        source.sourceId === first.sourceId &&
        source.capture === first.capture,
    )
  ) {
    const span = spanEnvelope(sources.map((source) => source!.span));
    const source = origins.source(first.sourceId, span);
    return first.capture === undefined
      ? source
      : origins.copied(first.capture, source);
  }
  const parts = [...new Set(tokens.map(({ origin }) => origin))];
  return parts.length === 1 ? parts[0]! : origins.composed(parts);
}

/**
 * Where each token split out of `token` was written, by its offsets in the
 * literal's text: a part of the source the literal was read from, or of a
 * copy of it, and otherwise wherever the literal was written.
 */
function splitPosition(
  origins: OriginStore,
  token: TokenSyntax,
): (start: number, end: number) => OriginId {
  const written = writtenSpan(origins, token.origin);
  if (written === undefined) return () => token.origin;
  return (start, end) => {
    const source = origins.source(
      written.sourceId,
      createSpan(written.span.start + start, written.span.start + end),
    );
    return written.capture === undefined
      ? source
      : origins.copied(written.capture, source);
  };
}

/**
 * The source span an origin names, directly or as a capture's copy of it;
 * undefined for anything a template or the expander wrote.
 */
function writtenSpan(
  origins: OriginStore,
  id: OriginId,
):
  | {
      readonly sourceId: SourceId;
      readonly span: Span;
      readonly capture: CaptureId | undefined;
    }
  | undefined {
  const origin = origins.get(id);
  if (origin?.kind === "source")
    return { sourceId: origin.sourceId, span: origin.span, capture: undefined };
  if (origin?.kind !== "copied") return undefined;
  const parent = origins.get(origin.parent);
  return parent?.kind === "source"
    ? { sourceId: parent.sourceId, span: parent.span, capture: origin.capture }
    : undefined;
}
