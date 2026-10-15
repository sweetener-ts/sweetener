import type { SlashReading, SlashReadings } from "@sweetener/syntax";
import * as ts from "typescript";
import {
  scanWithSupportedTypeScript,
  type ScannerLanguageVariant,
  type TypeScriptScannedToken,
} from "./typescript-version/adapter.js";

/** The spellings that open or close a group the reader builds. */
const delimiters = new Set(["(", ")", "[", "]", "{", "}"]);

/** Whether `token` opens, closes or continues a group the reader builds. */
function delimits(token: TypeScriptScannedToken): boolean {
  return (
    delimiters.has(token.raw) ||
    token.projectKind === "template-head" ||
    token.projectKind === "template-middle" ||
    token.projectKind === "template-tail" ||
    token.lexicalMode === "jsx-tag" ||
    token.lexicalMode === "jsx-text"
  );
}

function alike(
  left: TypeScriptScannedToken,
  right: TypeScriptScannedToken,
): boolean {
  return (
    left.start === right.start &&
    left.end === right.end &&
    left.kind === right.kind &&
    left.lexicalMode === right.lexicalMode
  );
}

/**
 * What to read `source` with next: `readings`, which it was read with, and
 * the slashes `misread` names, which the enforester found read the other way
 * from the grammar.
 *
 * The misreadings are taken in source order, and the first is always sound:
 * everything in front of it was read as the grammar reads it. A later one was
 * found in syntax read after an earlier misreading, and holds only where that
 * misreading was local: reading the slash the other way changed the read only
 * as far as the end of the regular expression it begins one way -- `/re/`
 * read as `/`, `re`, `/` -- without opening or closing a group in between,
 * and every token from there on is read alike either way. Where the two ways
 * part for good -- a quote, a bracket or a comment's opening inside the
 * expression, read as what it is outside one -- nothing found after the slash
 * can be trusted until the source has been read again. So the misreadings are
 * taken up to and including the first that was not local, and the rest are
 * left for the read after this one to find again if they still stand.
 *
 * Whether each was local is read off two scans of the whole source, one each
 * way, however many misreadings there are.
 */
export function nextSlashReadings(
  source: string,
  variant: ScannerLanguageVariant,
  readings: SlashReadings,
  misread: SlashReadings,
): SlashReadings {
  const candidates = [...misread].sort(([left], [right]) => left - right);
  for (const [offset, reading] of candidates)
    // A slash read as the grammar asked is read that way, and is never
    // found misread again: finding it so means the enforester read the same
    // slash both ways.
    if (readings.has(offset))
      throw new RangeError(
        `The slash at offset ${String(offset)} was read as ${String(readings.get(offset))} and then found misread as ${reading}`,
      );
  const before = scanWithSupportedTypeScript(
    source,
    variant,
    undefined,
    readings,
  ).tokens;
  const after = scanWithSupportedTypeScript(
    source,
    variant,
    undefined,
    new Map([...readings, ...candidates]),
  ).tokens;
  const next = new Map(readings);
  let inBefore = 0;
  let inAfter = 0;
  for (const [offset, reading] of candidates) {
    // Read alike up to this slash, or an earlier misreading was not local
    // after all and this one was found in syntax that is not there.
    while (
      before[inBefore] !== undefined &&
      after[inAfter] !== undefined &&
      before[inBefore]!.start < offset &&
      alike(before[inBefore]!, after[inAfter]!)
    ) {
      inBefore += 1;
      inAfter += 1;
    }
    if (before[inBefore]?.start !== offset || after[inAfter]?.start !== offset)
      break;
    next.set(offset, reading);
    const expression =
      reading === "regular-expression" ? after[inAfter]! : before[inBefore]!;
    const end = expression.end;
    let delimited = false;
    for (; before[inBefore] !== undefined; inBefore += 1) {
      if (before[inBefore]!.start >= end) break;
      if (delimits(before[inBefore]!)) delimited = true;
    }
    for (; after[inAfter] !== undefined; inAfter += 1) {
      if (after[inAfter]!.start >= end) break;
      if (delimits(after[inAfter]!)) delimited = true;
    }
    const resumes = (tokens: readonly TypeScriptScannedToken[], at: number) =>
      tokens[at] === undefined || tokens[at]!.start === end;
    if (delimited || !resumes(before, inBefore) || !resumes(after, inAfter))
      break;
  }
  return next;
}

/**
 * How TypeScript's own parser reads each slash of `source`, for a reader
 * that has no enforester to ask.
 *
 * The parser rescans a slash as a regular expression where it expects an
 * operand, so the regular expressions in the tree it builds are where
 * TypeScript read one. A Sweetener source is not TypeScript where it writes a
 * macro's own syntax, and there the parser reads what it recovers to; so this
 * is the answer only for what TypeScript's grammar reads, and it costs a parse
 * of the whole source. Only the slashes the reader read the other way are
 * returned.
 */
export function typescriptSlashReadings(
  source: string,
  variant: ScannerLanguageVariant,
): SlashReadings {
  const expressions = new Set(parsedRegularExpressions(source, variant));
  let readings: SlashReadings = new Map();
  // Read again until the read agrees with the parser, taking the slashes it
  // disagrees about as the enforester's findings are taken.
  for (;;) {
    const misread = new Map<number, SlashReading>();
    for (const token of scanWithSupportedTypeScript(
      source,
      variant,
      undefined,
      readings,
    ).tokens) {
      if (
        token.projectKind === "regular-expression-literal" &&
        !expressions.has(token.start)
      )
        misread.set(token.start, "division");
      if (
        token.projectKind === "punctuation" &&
        (token.raw === "/" || token.raw === "/=") &&
        expressions.has(token.start)
      )
        misread.set(token.start, "regular-expression");
    }
    if (misread.size === 0) return readings;
    readings = nextSlashReadings(source, variant, readings, misread);
  }
}

/** Where TypeScript's parser read a regular expression in `source`. */
function parsedRegularExpressions(
  source: string,
  variant: ScannerLanguageVariant,
): readonly number[] {
  const file = ts.createSourceFile(
    variant === "jsx" ? "source.tsx" : "source.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
    variant === "jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral)
      found.push(node.getStart(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
