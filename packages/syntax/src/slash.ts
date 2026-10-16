import type { Syntax, TokenSyntax } from "./syntax.js";

/**
 * How a `/` or `/=` is read: as the start of a regular expression, or as a
 * division.
 */
export type SlashReading = "regular-expression" | "division";

/**
 * How a `<` the reader judged by looking ahead is read in a JSX file: as the
 * start of an element, or as a type parameter list.
 *
 * TypeScript decides between the two from where its parser stands: where an
 * expression is written a `<` opens an element unless the tokens after the
 * name say type parameters (`<T,`, `<T =`, `<T extends U`), and where a type
 * is written there is no element at all. The reader cannot see which is
 * written, and decides a bare `<T>` by what follows it: a parameter list and
 * an arrow make a function type, `<T>(v: T) => T`, and so does the element
 * `<b>(v) => x</b>`, whose text is then read as code.
 */
export type AngleReading = "element" | "type-parameters";

/** How a token the reader judged by its surroundings is read. */
export type TokenReading = SlashReading | AngleReading;

/**
 * How the tokens at given offsets of one source are read, overriding the
 * reader's own judgement for each: a slash's (`SlashReading`) and, in a JSX
 * file, a `<`'s (`AngleReading`).
 *
 * Which a slash begins is the parser's to say, not the scanner's: TypeScript
 * rescans a `/` as a regular expression where it expects an operand, and
 * leaves it a division where it expects an operator. Whether a `<` opens an
 * element is the parser's to say too. A reader that runs ahead of its parser
 * can judge only from the tokens around -- after a name, a literal or a
 * closer, a division -- and that judgement is wrong where the grammar says
 * otherwise: `let x: T` and the `/re/.test(s);` under it, `x as const / 2 /
 * 3`, or an element whose text reads like a function type. The enforester is
 * the parser here, and it says which. Where its answer changes only the
 * tokens of one expression it reads them so in place; where it changes the
 * groups the reader built, the reader reads the source again with its answer,
 * given as these.
 */
export type TokenReadings = ReadonlyMap<number, TokenReading>;

/** Whether `reading` is a `<`'s rather than a slash's. */
export function angleReading(reading: TokenReading): reading is AngleReading {
  return reading === "element" || reading === "type-parameters";
}

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
