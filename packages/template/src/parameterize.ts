import type { Syntax, TokenSyntax } from "@sweetener/syntax";

/**
 * What `#parameterize(name = replacement) { body }` says between its
 * parentheses.
 *
 * The template language reads the shape, to report a malformed one where the
 * template is written, and the expander reads it again to apply it. Both read
 * it here so the two cannot disagree about what a parameterization names.
 */
export interface Parameterization {
  /** The parameter's spelling, as a definition or an import writes it. */
  readonly spelling: string;
  /** The nodes that name the parameter, for resolving and reporting it. */
  readonly name: readonly Syntax[];
  /** What each use of the parameter stands for inside the body. */
  readonly replacement: readonly Syntax[];
}

function isWord(node: Syntax): node is TokenSyntax {
  return (
    node.tag === "token" &&
    (node.kind === "identifier" || node.kind === "keyword")
  );
}

/**
 * Reads the contents of a `#parameterize` argument group, or answers undefined
 * when they are not one parameterization.
 *
 * The parameter is named the way a definition names it: a word (`it`), a
 * spelling in parentheses (`(%)`, needed when the spelling holds an `=`), or
 * punctuation written together (`%`). The first `=` after the name separates
 * it from the replacement, which may not be empty.
 */
export function readParameterization(
  children: readonly Syntax[],
): Parameterization | undefined {
  const equals = children.findIndex(
    (node) => node.tag === "token" && node.raw === "=",
  );
  if (equals < 1 || equals === children.length - 1) return undefined;
  const name = children.slice(0, equals);
  const replacement = children.slice(equals + 1);
  const only = name.length === 1 ? name[0]! : undefined;
  if (only !== undefined && isWord(only))
    return Object.freeze({
      spelling: only.raw,
      name: Object.freeze(name),
      replacement: Object.freeze(replacement),
    });
  if (
    only?.tag === "group" &&
    only.delimiter === "parenthesis" &&
    only.children.length > 0 &&
    only.children.every((child) => child.tag === "token")
  )
    return Object.freeze({
      spelling: only.children
        .map((child) => (child as TokenSyntax).raw)
        .join(""),
      name: Object.freeze(name),
      replacement: Object.freeze(replacement),
    });
  // Punctuation spelled across several tokens is only that spelling when the
  // tokens are written together, as an operator's is.
  const punctuation = name.every(
    (node, index) =>
      node.tag === "token" &&
      node.kind === "punctuation" &&
      (index === 0 || node.leadingTrivia.length === 0),
  );
  if (!punctuation) return undefined;
  return Object.freeze({
    spelling: name.map((node) => (node as TokenSyntax).raw).join(""),
    name: Object.freeze(name),
    replacement: Object.freeze(replacement),
  });
}
