import type { OriginId, SyntaxClassId } from "@sweetener/shared";
import type { CursorIdentity, DelimiterKind } from "@sweetener/syntax";
import type { LiteralKey, LookaheadPredicate } from "./ast.js";

export type MatcherExpectation =
  | { readonly kind: "description"; readonly description: string }
  | { readonly kind: "literal"; readonly literal: LiteralKey }
  | { readonly kind: "class"; readonly classId: SyntaxClassId }
  | { readonly kind: "group"; readonly delimiter: DelimiterKind }
  | { readonly kind: "lookahead"; readonly predicate: LookaheadPredicate }
  | { readonly kind: "end-of-group" };

export interface MatchFailure {
  readonly offset: number;
  readonly cursor: CursorIdentity;
  /**
   * The syntax the failure stood at, for reporting it there. Absent only when
   * the input was empty and there was nothing to point at.
   */
  readonly at: OriginId | undefined;
  readonly specificity: number;
  readonly expectations: readonly MatcherExpectation[];
  readonly origins: readonly OriginId[];
}

/**
 * The farthest of several failures, with what each wanted there merged.
 *
 * Failures rank by how far into the input they reached: the attempt that got
 * furthest is the one that says most about what was meant. At the same offset
 * the expectations are merged and the most specific one sets the rank.
 */
export function farthestFailure(
  failures: readonly MatchFailure[],
): MatchFailure | undefined {
  if (failures.length === 0) return undefined;
  const farthest = Math.max(...failures.map((failure) => failure.offset));
  const atOffset = failures.filter((failure) => failure.offset === farthest);
  const specificity = Math.max(
    ...atOffset.map((failure) => failure.specificity),
  );
  const best = atOffset.filter(
    (failure) => failure.specificity === specificity,
  );
  const expectations = new Map(
    best.flatMap((failure) =>
      failure.expectations.map(
        (expectation) => [expectationKey(expectation), expectation] as const,
      ),
    ),
  );
  const first = [...best].sort((left, right) =>
    left.cursor.localeCompare(right.cursor),
  )[0]!;
  return Object.freeze({
    offset: farthest,
    cursor: first.cursor,
    at: first.at ?? best.find((failure) => failure.at !== undefined)?.at,
    specificity,
    expectations: Object.freeze(
      [...expectations]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => value),
    ),
    origins: Object.freeze(
      [...new Set(best.flatMap((failure) => failure.origins))].sort(
        (left, right) => left - right,
      ),
    ),
  });
}

/**
 * A failure put in the words of what was being read when it happened.
 *
 * A syntax class or a rule with an `expect` names what belongs where it
 * failed. The innermost description is the most exact one, so a failure that
 * already carries a description -- a class inside this one said what it
 * wanted -- keeps it, and only a failure described by nothing but the tokens
 * and classes it wanted takes this one.
 */
export function describeFailureAs(
  failure: MatchFailure,
  description: string,
): MatchFailure {
  const described = failure.expectations.filter(
    (expectation) => expectation.kind === "description",
  );
  return Object.freeze({
    ...failure,
    specificity: Math.max(
      failure.specificity,
      expectationSpecificity({ kind: "description", description }),
    ),
    expectations: Object.freeze(
      described.length > 0
        ? described
        : [Object.freeze({ kind: "description" as const, description })],
    ),
  });
}

export function expectationSpecificity(
  expectation: MatcherExpectation,
): number {
  switch (expectation.kind) {
    case "description":
      return 7;
    case "end-of-group":
      return 6;
    case "literal":
      return expectation.literal.kind === "binding" ? 5 : 4;
    case "group":
    case "lookahead":
      return 3;
    case "class":
      return 2;
  }
}

export function expectationKey(expectation: MatcherExpectation): string {
  switch (expectation.kind) {
    case "description":
      return `description:${expectation.description}`;
    case "end-of-group":
      return "end-of-group";
    case "class":
      return `class:${String(expectation.classId)}`;
    case "group":
      return `group:${expectation.delimiter}`;
    case "literal":
      return expectation.literal.kind === "binding"
        ? `literal:binding:${String(expectation.literal.binding)}:${expectation.literal.spelling}`
        : `literal:token:${expectation.literal.tokenKind}:${expectation.literal.raw}`;
    case "lookahead":
      return `lookahead:${JSON.stringify(expectation.predicate)}`;
  }
}

const delimiterPhrases: Readonly<Record<DelimiterKind, string>> = Object.freeze(
  {
    parenthesis: "a parenthesised group",
    bracket: "a bracketed group",
    brace: "a braced group",
    template: "a template literal",
    "jsx-element": "a JSX element",
    "jsx-fragment": "a JSX fragment",
  },
);

function phrase(
  expectation: MatcherExpectation,
  describeClass: ((classId: SyntaxClassId) => string | undefined) | undefined,
): string | undefined {
  switch (expectation.kind) {
    case "description":
      return expectation.description;
    case "literal":
      return expectation.literal.kind === "binding"
        ? `\`${expectation.literal.spelling}\``
        : `\`${expectation.literal.raw}\``;
    case "group":
      return delimiterPhrases[expectation.delimiter];
    case "class": {
      // Written as the author would write it in a pattern, without an article,
      // which would have to agree with a name this code cannot inspect.
      const name = describeClass?.(expectation.classId);
      return name === undefined ? undefined : `\`${name}\``;
    }
    case "end-of-group":
      return "the end of the group";
    // A lookahead constrains what may follow rather than naming something the
    // author could have written, so it says nothing useful on its own.
    case "lookahead":
      return undefined;
  }
}

/**
 * What the closest rule was still waiting for, as a phrase for a person.
 *
 * How many rules were tried would say only that something is wrong. The
 * matcher records what each rule wanted where it stopped; this is that, in the
 * order it would be written.
 */
export function describeExpectations(
  expectations: readonly MatcherExpectation[],
  describeClass?: (classId: SyntaxClassId) => string | undefined,
): string | undefined {
  const phrases = [
    ...new Set(
      expectations.flatMap((expectation) => {
        const text = phrase(expectation, describeClass);
        return text === undefined ? [] : [text];
      }),
    ),
  ];
  if (phrases.length === 0) return undefined;
  if (phrases.length === 1) return `expected ${phrases[0]!}`;
  const last = phrases.at(-1)!;
  return `expected ${phrases.slice(0, -1).join(", ")} or ${last}`;
}
