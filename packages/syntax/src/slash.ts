import type { Syntax, TokenSyntax } from "./syntax.js";

/**
 * How a `/` or `/=` is read: as the start of a regular expression, or as a
 * division.
 */
export type SlashReading = "regular-expression" | "division";

/**
 * How the slashes at given offsets of one source are read, overriding the
 * reader's own judgement for each.
 *
 * Which of the two a slash begins is the parser's to say, not the scanner's:
 * TypeScript rescans a `/` as a regular expression where it expects an
 * operand, and leaves it a division where it expects an operator. A reader
 * that runs ahead of its parser can judge only from the token before -- after
 * a name, a literal or a closer, a division -- and that judgement is wrong
 * where the grammar says otherwise: `let x: T` and the `/re/.test(s);` under
 * it, or `x as const / 2 / 3`. The enforester is the parser here, and it says
 * which. Where its answer changes only the tokens of one expression it reads
 * them so in place; where it changes the groups the reader built, the reader
 * reads the source again with its answer, given as these.
 */
export type SlashReadings = ReadonlyMap<number, SlashReading>;

/** Whether `syntax` is a slash read as a division: a `/` or a `/=`. */
export function divisionSlash(
  syntax: Syntax | undefined,
): syntax is TokenSyntax {
  return (
    syntax?.tag === "token" &&
    syntax.kind === "punctuation" &&
    (syntax.raw === "/" || syntax.raw === "/=")
  );
}

/** Whether `syntax` is a regular expression literal. */
export function regularExpression(
  syntax: Syntax | undefined,
): syntax is TokenSyntax {
  return (
    syntax?.tag === "token" && syntax.kind === "regular-expression-literal"
  );
}
