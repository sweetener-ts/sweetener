import type { DelimiterKind, SyntaxCursor, TokenKind } from "@sweetener/syntax";

export type StopCondition =
  | {
      readonly kind: "token";
      readonly tokenKind?: TokenKind | undefined;
      readonly raw?: string | undefined;
    }
  | { readonly kind: "group"; readonly delimiter: DelimiterKind }
  /**
   * An operator spelling, which the scanner may split across tokens -- `|>`
   * is `|` then `>`. It stops only where those tokens are written together.
   */
  | { readonly kind: "spelling"; readonly raw: string }
  | { readonly kind: "end" };

function conditionKey(condition: StopCondition): string {
  switch (condition.kind) {
    case "token":
      return `token|${condition.tokenKind ?? "*"}|${condition.raw ?? "*"}`;
    case "group":
      return `group|${condition.delimiter}`;
    case "spelling":
      return `spelling|${condition.raw}`;
    case "end":
      return "end";
  }
}

function createCondition(condition: StopCondition): StopCondition {
  if (
    condition.kind === "token" &&
    condition.tokenKind === undefined &&
    condition.raw === undefined
  ) {
    throw new TypeError("Token stop condition requires a kind or raw spelling");
  }
  if (
    condition.kind === "token" &&
    condition.raw !== undefined &&
    condition.raw.length === 0
  ) {
    throw new RangeError("Token stop spelling must not be empty");
  }
  if (condition.kind === "spelling" && condition.raw.length === 0) {
    throw new RangeError("Stop spelling must not be empty");
  }
  return Object.freeze({ ...condition });
}

function matchesSpelling(cursor: SyntaxCursor, spelling: string): boolean {
  let actual = "";
  for (let offset = 0; actual.length < spelling.length; offset += 1) {
    const node = cursor.peek(offset);
    if (node?.tag !== "token") return false;
    if (offset > 0 && node.leadingTrivia.length > 0) return false;
    actual += node.raw;
    if (!spelling.startsWith(actual)) return false;
  }
  return actual === spelling;
}

function matchesSyntax(
  condition: StopCondition,
  cursor: SyntaxCursor,
): boolean {
  const syntax = cursor.peek();
  switch (condition.kind) {
    case "spelling":
      return matchesSpelling(cursor, condition.raw);
    case "end":
      return syntax === undefined;
    case "group":
      return (
        syntax?.tag === "group" && syntax.delimiter === condition.delimiter
      );
    case "token":
      return (
        syntax?.tag === "token" &&
        (condition.tokenKind === undefined ||
          syntax.kind === condition.tokenKind) &&
        (condition.raw === undefined || syntax.raw === condition.raw)
      );
  }
}

export class StopSet {
  static readonly empty = new StopSet([]);

  readonly conditions: readonly StopCondition[];
  readonly #keys: ReadonlySet<string>;

  constructor(conditions: readonly StopCondition[]) {
    const byKey = new Map<string, StopCondition>();
    for (const input of conditions) {
      const condition = createCondition(input);
      const key = conditionKey(condition);
      if (byKey.has(key))
        throw new RangeError(`Duplicate stop condition ${key}`);
      byKey.set(key, condition);
    }
    this.conditions = Object.freeze(
      [...byKey.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, condition]) => condition),
    );
    this.#keys = new Set(byKey.keys());
    Object.freeze(this);
  }

  matches(cursor: SyntaxCursor): boolean {
    return this.conditions.some((condition) =>
      matchesSyntax(condition, cursor),
    );
  }

  union(other: StopSet): StopSet {
    const additions = other.conditions.filter(
      (condition) => !this.#keys.has(conditionKey(condition)),
    );
    return additions.length === 0
      ? this
      : new StopSet([...this.conditions, ...additions]);
  }
}
