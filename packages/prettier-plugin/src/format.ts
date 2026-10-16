import {
  readSyntax,
  regularExpressionEnd,
  typescriptSlashes,
} from "@sweetener/reader";
import type { ScopeSetId, SourceId } from "@sweetener/shared";
import {
  divisionSlash,
  type GroupSyntax,
  type RootSyntax,
  type Span,
  type Syntax,
  type TokenSyntax,
  type Trivia,
} from "@sweetener/syntax";

export interface SweetenerFormatOptions {
  readonly filepath?: string | undefined;
  readonly printWidth?: number | undefined;
  readonly tabWidth?: number | undefined;
  readonly useTabs?: boolean | undefined;
  readonly semi?: boolean | undefined;
  readonly singleQuote?: boolean | undefined;
  readonly jsxSingleQuote?: boolean | undefined;
  readonly quoteProps?: "as-needed" | "consistent" | "preserve" | undefined;
  readonly bracketSpacing?: boolean | undefined;
  readonly bracketSameLine?: boolean | undefined;
  readonly arrowParens?: "always" | "avoid" | undefined;
  readonly endOfLine?: "lf" | "crlf" | "cr" | "auto" | undefined;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const sourceId = 0 as SourceId;
const scopes = 0 as ScopeSetId;

function lineEnding(
  source: string,
  option: SweetenerFormatOptions["endOfLine"],
): string {
  switch (option) {
    case "cr":
      return "\r";
    case "crlf":
      return "\r\n";
    case "auto":
      return source.includes("\r\n")
        ? "\r\n"
        : source.includes("\r")
          ? "\r"
          : "\n";
    case "lf":
    case undefined:
      return "\n";
  }
}

function indentation(depth: number, options: SweetenerFormatOptions): string {
  if (options.useTabs === true) return "\t".repeat(depth);
  return " ".repeat(depth * (options.tabWidth ?? 2));
}

function formatMultilineWhitespace(
  raw: string,
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
): string {
  const breaks = raw.match(/\r\n|[\n\r\u2028\u2029]/gu)?.length ?? 0;
  return eol.repeat(Math.min(breaks, 2)) + indentation(depth, options);
}

function isLineBreak(trivia: Trivia | undefined): boolean {
  return trivia?.kind === "whitespace" && trivia.hasLineBreak;
}

/**
 * Lays out the whitespace in front of one token.
 *
 * Only whitespace a macro cannot see changes. The reader and matcher look at
 * whether a token has any trivia before it, which is how an operator spelled
 * across several tokens is rejoined, and at whether it begins a line, which is
 * where an item ends. A run of spaces stays a space and a line break stays a
 * line break; what changes is how wide they are.
 */
function collectTrivia(
  trivia: readonly Trivia[],
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
  replacements: Replacement[],
  startsFile: boolean,
): void {
  let followsLineBreak = startsFile;
  for (let index = 0; index < trivia.length; index += 1) {
    const item = trivia[index]!;
    if (item.kind === "whitespace") {
      if (item.hasLineBreak) {
        let anotherLineBreakFollows = false;
        for (const following of trivia.slice(index + 1)) {
          if (following.kind !== "whitespace") break;
          if (following.hasLineBreak) {
            anotherLineBreakFollows = true;
            break;
          }
        }
        replacements.push({
          start: item.span.start,
          end: item.span.end,
          text: anotherLineBreakFollows
            ? eol.repeat(
                Math.min(
                  item.raw.match(/\r\n|[\n\r\u2028\u2029]/gu)?.length ?? 0,
                  2,
                ),
              )
            : formatMultilineWhitespace(item.raw, depth, options, eol),
        });
        followsLineBreak = true;
      } else {
        // Leading indentation is replaced by the line break before it, and
        // spaces at the end of a line are dropped. Anything else is a gap
        // between two things on one line, and one space is enough.
        replacements.push({
          start: item.span.start,
          end: item.span.end,
          text: followsLineBreak || isLineBreak(trivia[index + 1]) ? "" : " ",
        });
      }
      continue;
    }
    followsLineBreak = false;
  }
}

function collectToken(
  token: TokenSyntax,
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
  replacements: Replacement[],
): void {
  const startsFile = token.span.start === 0;
  collectTrivia(
    token.leadingTrivia,
    depth,
    options,
    eol,
    replacements,
    startsFile,
  );
  collectTrivia(token.trailingTrivia, depth, options, eol, replacements, false);
}

/**
 * Puts a closing brace on its own line when the block it closes was opened
 * onto one.
 *
 * `{` followed by a line break is a block laid out over lines, and the `}`
 * closing it belongs at the block's own indentation rather than trailing its
 * last line. A break in front of `}` is safe to add: nothing starts at a
 * closing delimiter, so no item boundary moves. The same is not true of a
 * break after `{`, which would make the first thing inside begin a line, so a
 * block opened on the same line as its content keeps that layout.
 */
function collectClosingBrace(
  group: GroupSyntax,
  close: TokenSyntax,
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
  replacements: Replacement[],
): void {
  const first = group.children[0];
  const firstToken = first?.tag === "group" ? first.open : first;
  const opensOntoLine =
    firstToken?.tag === "token" && firstToken.leadingTrivia.some(isLineBreak);
  if (!opensOntoLine || close.leadingTrivia.some(isLineBreak)) {
    collectToken(close, depth, options, eol, replacements);
    return;
  }
  // Whitespace directly before the brace becomes the line break; any comment
  // there stays on the last line, where it was written.
  let kept = close.leadingTrivia.length;
  while (kept > 0 && close.leadingTrivia[kept - 1]!.kind === "whitespace")
    kept -= 1;
  collectTrivia(
    close.leadingTrivia.slice(0, kept),
    depth,
    options,
    eol,
    replacements,
    false,
  );
  const start = close.leadingTrivia[kept]?.span.start ?? close.span.start;
  replacements.push({
    start,
    end: close.span.start,
    text: eol + indentation(depth, options),
  });
}

/**
 * Separates a brace from a name or parameter list it directly follows.
 *
 * `class Name{` and `function f(){` read as one word; Prettier writes them
 * with a space, and so does every example. A brace group is never part of an
 * operator spelled across adjacent tokens, so giving it leading whitespace
 * does not change how anything is read.
 */
function collectBraceSpacing(
  previous: Syntax | undefined,
  syntax: Syntax,
  replacements: Replacement[],
): void {
  if (
    syntax.tag !== "group" ||
    syntax.delimiter !== "brace" ||
    syntax.open.leadingTrivia.length > 0 ||
    previous === undefined ||
    previous.span.end !== syntax.open.span.start
  )
    return;
  const separable =
    previous.tag === "token"
      ? previous.kind === "identifier" || previous.kind === "keyword"
      : previous.tag === "group" && previous.delimiter === "parenthesis";
  if (!separable) return;
  replacements.push({
    start: syntax.open.span.start,
    end: syntax.open.span.start,
    text: " ",
  });
}

function preservesWhitespace(group: GroupSyntax): boolean {
  return (
    group.delimiter === "template" ||
    group.delimiter === "jsx-element" ||
    group.delimiter === "jsx-fragment"
  );
}

function collectSyntax(
  syntax: Syntax,
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
  replacements: Replacement[],
): void {
  switch (syntax.tag) {
    case "token":
      collectToken(syntax, depth, options, eol, replacements);
      return;
    case "group":
      collectToken(syntax.open, depth, options, eol, replacements);
      if (preservesWhitespace(syntax)) return;
      collectChildren(syntax.children, depth + 1, options, eol, replacements);
      if (syntax.close.tag !== "token") return;
      if (syntax.delimiter === "brace")
        collectClosingBrace(
          syntax,
          syntax.close,
          depth,
          options,
          eol,
          replacements,
        );
      else collectToken(syntax.close, depth, options, eol, replacements);
      return;
    case "protected":
    case "root":
      collectChildren(syntax.children, depth, options, eol, replacements);
  }
}

function collectChildren(
  children: readonly Syntax[],
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
  replacements: Replacement[],
): void {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    collectBraceSpacing(children[index - 1], child, replacements);
    collectSyntax(child, depth, options, eol, replacements);
  }
}

/**
 * The spans of the source a slash read as a division could begin a regular
 * expression over, where one would end on the slash's own line.
 *
 * Which of the two a slash begins is the parser's to say, and the reader can
 * only judge from the token before. Read as a division, the text a regular
 * expression is written with is names and operators with whitespace between
 * them, which this formatter would lay out -- and `/a  b/` would become `/a
 * b/`, another expression. So the source is read with TypeScript's own
 * readings of its slashes wherever one of these stands (see
 * `readForFormatting`), and a regular expression read as one is one token,
 * nothing inside which is laid out.
 */
function possibleRegularExpressions(
  source: string,
  syntax: Syntax,
): readonly { readonly start: number; readonly end: number }[] {
  switch (syntax.tag) {
    case "token": {
      if (!divisionSlash(syntax)) return [];
      const end = regularExpressionEnd(source, syntax.span.start);
      return end === undefined ? [] : [{ start: syntax.span.start, end }];
    }
    case "group":
    case "protected":
    case "root":
      return syntax.children.flatMap((child) =>
        possibleRegularExpressions(source, child),
      );
  }
}

/**
 * `spans` joined where they overlap, in source order. Two slashes may each
 * begin an expression over the other: in `a / b / c` the first ends at the
 * second, and the second reaches past it.
 */
function disjoint(
  spans: readonly { readonly start: number; readonly end: number }[],
): readonly { readonly start: number; readonly end: number }[] {
  const joined: { start: number; end: number }[] = [];
  for (const span of [...spans].sort(
    (left, right) => left.start - right.start,
  )) {
    const last = joined.at(-1);
    if (last !== undefined && span.start < last.end)
      last.end = Math.max(last.end, span.end);
    else joined.push({ ...span });
  }
  return joined;
}

/**
 * Whether `replacement` touches the inside of any of `spans`, which are in
 * source order and do not overlap.
 */
function overlapsAny(
  spans: readonly { readonly start: number; readonly end: number }[],
  replacement: Replacement,
): boolean {
  let low = 0;
  let high = spans.length;
  // The first span ending after the replacement begins.
  while (low < high) {
    const middle = (low + high) >> 1;
    if (spans[middle]!.end <= replacement.start) low = middle + 1;
    else high = middle;
  }
  const span = spans[low];
  return (
    span !== undefined &&
    replacement.end > span.start &&
    replacement.start < span.end
  );
}

function applyReplacements(
  source: string,
  replacements: readonly Replacement[],
): string {
  let result = source;
  for (const replacement of [...replacements].sort(
    (left, right) => right.start - left.start,
  )) {
    result =
      result.slice(0, replacement.start) +
      replacement.text +
      result.slice(replacement.end);
  }
  return result;
}

/**
 * `source` read as the formatter lays it out, and the statements in it
 * TypeScript's parser could not read (see `TypeScriptSlashes.unparsed`).
 *
 * A slash the reader judged a division may begin a regular expression, and
 * one it judged a regular expression may divide. The expansion has the
 * enforester to say which; a formatter has no enforester, so wherever a
 * slash may begin a regular expression it asks TypeScript's parser, and reads
 * each slash as the parser does where the parser read the statement holding
 * it. That also reads `if (c) /(/.test(s)`, where the reader's judgement
 * leaves a bracket unbalanced.
 */
function readForFormatting(
  source: string,
  options: SweetenerFormatOptions,
): { readonly root: RootSyntax; readonly unparsed: readonly Span[] } {
  const variant = options.filepath?.endsWith("x") === true ? "jsx" : "standard";
  const initial = readSyntax(source, { sourceId, scopes, variant });
  const typescript =
    initial.diagnostics.length > 0 ||
    possibleRegularExpressions(source, initial.root).length > 0
      ? typescriptSlashes(source, variant)
      : undefined;
  const result =
    typescript === undefined || typescript.readings.size === 0
      ? initial
      : readSyntax(source, {
          sourceId,
          scopes,
          variant,
          slashReadings: typescript.readings,
        });
  if (result.diagnostics.length > 0) {
    const first = result.diagnostics[0];
    throw new SyntaxError(
      `Sweetener could not format malformed source${
        first === undefined
          ? ""
          : ` at offset ${String(first.primaryOrigin.start)}`
      }`,
    );
  }
  return { root: result.root, unparsed: typescript?.unparsed ?? [] };
}

export function readSweetenerSyntax(
  source: string,
  options: SweetenerFormatOptions,
): RootSyntax {
  return readForFormatting(source, options).root;
}

export function formatSweetener(
  source: string,
  options: SweetenerFormatOptions = {},
): string {
  if (source.length === 0) return "";
  const { root, unparsed } = readForFormatting(source, options);
  const eol = lineEnding(source, options.endOfLine);
  const replacements: Replacement[] = [];
  collectSyntax(root, 0, options, eol, replacements);
  // Where TypeScript read the statement, a slash it reads as a division is
  // one. Where it did not -- a macro's own syntax -- what the macro reads is
  // unknown here, so the text a division-read slash could begin a regular
  // expression over is left as written.
  const kept = disjoint(
    possibleRegularExpressions(source, root).filter(({ start }) =>
      unparsed.some((span) => start >= span.start && start < span.end),
    ),
  );
  const formatted = applyReplacements(
    source,
    replacements.filter((replacement) => !overlapsAny(kept, replacement)),
  );
  return formatted.replace(/[ \t\r\n\u2028\u2029]+$/u, "") + eol;
}
