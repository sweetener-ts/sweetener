import type { SlashReading, SlashReadings } from "@sweetener/syntax";
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
 * Whether reading the slash at `offset` as `reading`, on top of `readings`,
 * changes how `source` is read only as far as the end of the regular
 * expression the slash begins one way: every token from there on is read
 * alike either way, and neither way opens or closes a group in between.
 *
 * A slash read the wrong way usually reads a few names and operators where a
 * regular expression stands -- `/re/` as `/`, `re`, `/` -- and the source is
 * read alike again where the expression ends. Then the syntax after it is the
 * syntax the enforester read, and what it found there still holds once the
 * slash is read the other way. Where the two ways part for good -- a quote, a
 * bracket or a comment's opening inside the expression, read as what it is
 * outside one -- nothing found after the slash can be trusted until the
 * source has been read again.
 */
export function slashReadingIsLocal(
  source: string,
  variant: ScannerLanguageVariant,
  readings: SlashReadings,
  offset: number,
  reading: SlashReading,
): boolean {
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
    new Map([...readings, [offset, reading]]),
  ).tokens;
  const expression = (reading === "regular-expression" ? after : before).find(
    (token) => token.start === offset,
  );
  if (expression === undefined)
    throw new RangeError(`No slash at offset ${String(offset)}`);
  const end = expression.end;
  const from = (tokens: readonly TypeScriptScannedToken[]) =>
    tokens.findIndex((token) => token.start >= end);
  const resumeBefore = from(before);
  const resumeAfter = from(after);
  if (
    resumeBefore < 0 ||
    resumeAfter < 0 ||
    before[resumeBefore]!.start !== end ||
    after[resumeAfter]!.start !== end ||
    before.length - resumeBefore !== after.length - resumeAfter
  )
    return false;
  for (let index = 0; resumeBefore + index < before.length; index += 1)
    if (!alike(before[resumeBefore + index]!, after[resumeAfter + index]!))
      return false;
  const between = (tokens: readonly TypeScriptScannedToken[]) =>
    tokens.filter((token) => token.start >= offset && token.start < end);
  return ![...between(before), ...between(after)].some(delimits);
}

/**
 * What to read `source` with next: `readings`, which it was read with, and
 * the slashes `misread` names, which the enforester found read the other way
 * from the grammar.
 *
 * The misreadings are taken in source order, and the first is always sound:
 * everything in front of it was read as the grammar reads it. A later one was
 * found in syntax read after an earlier misreading, which holds only where
 * that misreading was local (see `slashReadingIsLocal`). So they are taken up
 * to and including the first that was not, and the rest are left for the
 * read after this one to find again if they still stand.
 */
export function nextSlashReadings(
  source: string,
  variant: ScannerLanguageVariant,
  readings: SlashReadings,
  misread: SlashReadings,
): SlashReadings {
  const next = new Map(readings);
  for (const [offset, reading] of [...misread].sort(
    ([left], [right]) => left - right,
  )) {
    // A slash read as the grammar asked is read that way, and is never
    // found misread again: finding it so means the enforester read the same
    // slash both ways.
    if (readings.has(offset))
      throw new RangeError(
        `The slash at offset ${String(offset)} was read as ${String(readings.get(offset))} and then found misread as ${reading}`,
      );
    const local = slashReadingIsLocal(source, variant, next, offset, reading);
    next.set(offset, reading);
    if (!local) break;
  }
  return next;
}
