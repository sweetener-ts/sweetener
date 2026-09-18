/**
 * The operators of TypeScript's expression grammar, with the fixity,
 * precedence and associativity the expression parser reads them with. Kept
 * apart from the parser so that readers which only need to know what an
 * operator is -- whether a line can end after one -- need not depend on it.
 */
export type PrattFixity = "prefix" | "infix" | "postfix";
export type PrattAssociativity = "left" | "right" | "none";

export interface CoreOperator {
  readonly spelling: string;
  readonly fixity: PrattFixity;
  readonly precedence: number;
  readonly associativity: PrattAssociativity;
}

function operators(
  spellings: readonly string[],
  fixity: PrattFixity,
  precedence: number,
  associativity: PrattAssociativity,
): CoreOperator[] {
  return spellings.map((spelling) =>
    Object.freeze({ spelling, fixity, precedence, associativity }),
  );
}

/**
 * What a prefix operator binds its operand at. A prefix type assertion binds
 * at the same strength -- TypeScript writes
 * `TypeAssertion: < Type > UnaryExpression`, which is exactly the operand `!`
 * and `typeof` take -- and is read outside this table, so the number is named
 * here rather than written twice.
 */
export const unaryPrecedence = 160;

export const coreExpressionOperators: readonly CoreOperator[] = Object.freeze([
  ...operators(["++", "--"], "postfix", 170, "none"),
  ...operators(
    [
      "+",
      "-",
      "!",
      "~",
      "typeof",
      "void",
      "delete",
      "await",
      "new",
      "++",
      "--",
    ],
    "prefix",
    unaryPrecedence,
    "right",
  ),
  // `yield` takes a whole assignment expression, so `yield a + b` yields the
  // sum and `yield a ? b : c` the conditional. Read at unary precedence it
  // would yield `a` and add `b` to whatever came back.
  ...operators(["yield"], "prefix", 20, "right"),
  ...operators(["**"], "infix", 150, "right"),
  ...operators(["*", "/", "%"], "infix", 140, "left"),
  ...operators(["+", "-"], "infix", 130, "left"),
  ...operators(["<<", ">>", ">>>"], "infix", 120, "left"),
  ...operators(
    ["<", "<=", ">", ">=", "in", "instanceof", "as", "satisfies"],
    "infix",
    110,
    "left",
  ),
  ...operators(["==", "!=", "===", "!=="], "infix", 100, "left"),
  ...operators(["&"], "infix", 90, "left"),
  ...operators(["^"], "infix", 80, "left"),
  ...operators(["|"], "infix", 70, "left"),
  ...operators(["&&"], "infix", 60, "left"),
  ...operators(["||"], "infix", 50, "left"),
  ...operators(["??"], "infix", 40, "left"),
  ...operators(
    [
      "=",
      "+=",
      "-=",
      "*=",
      "/=",
      "%=",
      "**=",
      "<<=",
      ">>=",
      ">>>=",
      "&=",
      "^=",
      "|=",
      "&&=",
      "||=",
      "??=",
      "=>",
    ],
    "infix",
    20,
    "right",
  ),
  ...operators([","], "infix", 10, "left"),
]);

/** The spellings the table holds with `fixity`. */
function spellingsOf(fixity: PrattFixity): ReadonlySet<string> {
  return new Set(
    coreExpressionOperators
      .filter((operator) => operator.fixity === fixity)
      .map(({ spelling }) => spelling),
  );
}

/**
 * Spellings a line cannot end after in an expression, because an operand is
 * still expected: every prefix and infix operator that is not also postfix --
 * `++` and `--` are, and `!` is a non-null assertion -- and the `.`, `?.`,
 * `?`, `:` and `...` that are written in an expression without being
 * operators of it.
 *
 * Automatic semicolon insertion is this question and the one below, asked of
 * the two tokens a line break stands between. Every reader that has to decide
 * where a line break ends something asks them here: the statement reader, the
 * class-member reader, and the scan that measures a concise arrow body.
 */
export const operandExpectedAfter: ReadonlySet<string> = new Set([
  ...[...spellingsOf("prefix"), ...spellingsOf("infix")].filter(
    (spelling) => spelling !== "!" && !spellingsOf("postfix").has(spelling),
  ),
  ".",
  "?.",
  "?",
  ":",
  "...",
]);

/**
 * Spellings that carry an expression on from the line before, so that a line
 * break in front of one ends nothing: every infix operator, a conditional's
 * `?` and `:`, and a member access.
 *
 * A postfix operator is not among them. The grammar writes
 * `LeftHandSideExpression [no LineTerminator here] ++`, so `a` and the `++b`
 * under it are two statements rather than one.
 */
export const expressionContinuedBy: ReadonlySet<string> = new Set([
  ...spellingsOf("infix"),
  ".",
  "?.",
  "?",
  ":",
]);
