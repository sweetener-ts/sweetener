import { readSyntax } from "@sweetener/reader";
import type { ScopeSetId, SourceId } from "@sweetener/shared";
import type {
  GroupSyntax,
  RootSyntax,
  Syntax,
  TokenSyntax,
  Trivia,
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

function collectTrivia(
  trivia: readonly Trivia[],
  depth: number,
  options: SweetenerFormatOptions,
  eol: string,
  replacements: Replacement[],
): void {
  let followsLineBreak = false;
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
      } else if (followsLineBreak) {
        replacements.push({
          start: item.span.start,
          end: item.span.end,
          text: "",
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
  collectTrivia(token.leadingTrivia, depth, options, eol, replacements);
  collectTrivia(token.trailingTrivia, depth, options, eol, replacements);
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
      for (const child of syntax.children)
        collectSyntax(child, depth + 1, options, eol, replacements);
      if (syntax.close.tag === "token")
        collectToken(syntax.close, depth, options, eol, replacements);
      return;
    case "protected":
    case "root":
      for (const child of syntax.children)
        collectSyntax(child, depth, options, eol, replacements);
  }
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

export function readSweetenerSyntax(
  source: string,
  options: SweetenerFormatOptions,
): RootSyntax {
  const result = readSyntax(source, {
    sourceId,
    scopes,
    variant: options.filepath?.endsWith("x") === true ? "jsx" : "standard",
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
  return result.root;
}

export function formatSweetener(
  source: string,
  options: SweetenerFormatOptions = {},
): string {
  if (source.length === 0) return "";
  const root = readSweetenerSyntax(source, options);
  const eol = lineEnding(source, options.endOfLine);
  const replacements: Replacement[] = [];
  collectSyntax(root, 0, options, eol, replacements);
  const formatted = applyReplacements(source, replacements);
  return formatted.replace(/[ \t\r\n\u2028\u2029]+$/u, "") + eol;
}
