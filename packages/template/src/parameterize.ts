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
  /**
   * Whether the body must use the parameter, as a Hack pipe's body must use
   * its topic. Written `#parameterize(required % = topic)`.
   */
  readonly required: boolean;
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
 * it from the replacement, which may not be empty. `required` before the name
 * says the body must use it; a parameter that is itself named `required` is
 * the whole name, as in `#parameterize(required = x)`.
 */
export function readParameterization(
  children: readonly Syntax[],
): Parameterization | undefined {
  const equals = children.findIndex(
    (node) => node.tag === "token" && node.raw === "=",
  );
  if (equals < 1 || equals === children.length - 1) return undefined;
  const first = children[0]!;
  const required =
    equals > 1 &&
    first.tag === "token" &&
    first.kind === "identifier" &&
    first.raw === "required";
  const name = children.slice(required ? 1 : 0, equals);
  const replacement = children.slice(equals + 1);
  const only = name.length === 1 ? name[0]! : undefined;
  if (only !== undefined && isWord(only))
    return Object.freeze({
      spelling: only.raw,
      name: Object.freeze(name),
      replacement: Object.freeze(replacement),
      required,
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
      required,
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
    required,
  });
}

/** What `#let(name = value) { body }` says between its parentheses. */
export interface LetBinding {
  /** The name the body refers to the value by. */
  readonly name: TokenSyntax;
  /** The expression evaluated once, before the body. */
  readonly value: readonly Syntax[];
}

/**
 * Reads the contents of a `#let` argument group, or answers undefined when
 * they are not one binding: a single identifier, `=`, and a value that is not
 * empty.
 */
export function readLetBinding(
  children: readonly Syntax[],
): LetBinding | undefined {
  const [name, equals, ...value] = children;
  if (
    name?.tag !== "token" ||
    name.kind !== "identifier" ||
    equals?.tag !== "token" ||
    equals.raw !== "=" ||
    value.length === 0
  )
    return undefined;
  return Object.freeze({ name, value: Object.freeze(value) });
}
