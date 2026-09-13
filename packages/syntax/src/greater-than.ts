import type { Syntax } from "./syntax.js";

/** The operators TypeScript's scanner reads as a run of `>` and `=` tokens. */
const greaterThanSpellings: ReadonlySet<string> = new Set([
  ">",
  ">=",
  ">>",
  ">>=",
  ">>>",
  ">>>=",
]);

/**
 * How many tokens spell the one operator that begins here, when it is one of
 * the `>` family, or zero when it is not.
 *
 * The scanner leaves `>=`, `>>`, `>>=`, `>>>` and `>>>=` as single-character
 * tokens, because a `>` may close a list of type arguments, and only a parser
 * knows which. Anything that reads a token by itself -- a `token` capture, a
 * spelling refinement -- would otherwise take `>` out of `>=` and leave the
 * `=` for whatever comes next. The pieces are one operator only when written
 * together, so `> =` is two tokens.
 */
export function greaterThanTokenWidth(
  peek: (offset: number) => Syntax | undefined,
): number {
  let spelling = "";
  let width = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const syntax = peek(offset);
    if (syntax?.tag !== "token" || syntax.kind !== "punctuation") break;
    if (offset > 0 && syntax.leadingTrivia.length > 0) break;
    const candidate = spelling + syntax.raw;
    if (!greaterThanSpellings.has(candidate)) break;
    spelling = candidate;
    width = offset + 1;
  }
  return width;
}
