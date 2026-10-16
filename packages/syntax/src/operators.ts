/**
 * The operators of TypeScript's expression grammar, with the fixity,
 * precedence and associativity the expression parser reads them with. Kept
 * apart from the parser so that readers which only need to know what an
 * operator is -- whether a line can end after one, or how tightly an
 * expression it built holds together when printed -- need not depend on it.
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

/**
 * What the operator spelled `spelling` with `fixity` binds at. Asking for one
 * the table does not hold is a mistake in the asker, not a question with a
 * default answer.
 */
export function operatorPrecedence(
  spelling: string,
  fixity: PrattFixity,
): number {
  const found = coreExpressionOperators.find(
    (operator) => operator.spelling === spelling && operator.fixity === fixity,
  );
  if (found === undefined)
    throw new RangeError(`No ${fixity} operator is spelled ${spelling}`);
  return found.precedence;
}

/**
 * The levels of the grammar that are not a single operator's. A conditional
 * binds between `??` and assignment; an assignment expression -- what an
 * argument, an initializer or an arrow's body is -- is the level `=` and `=>`
 * stand at; the comma operator is the loosest of all; and a primary
 * expression is tighter than any operator.
 */
export const conditionalPrecedence = 30;
/**
 * What an operand that no operator joins holds together at: a name, a
 * literal, a call, a member access, anything in brackets. It is a
 * left-hand-side expression, the only kind an assignment may write to.
 */
export const primaryPrecedence = 1_000;
export const assignmentPrecedence = operatorPrecedence("=", "infix");
export const commaPrecedence = operatorPrecedence(",", "infix");

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
 * The infix operators written only on the line of their left operand.
 * TypeScript writes `UnaryExpression [no LineTerminator here] as Type`, and
 * the same of `satisfies`, so an `as` beginning a line names something rather
 * than asserting a type: `x = a` and the `as = 1` under it are two
 * statements, and in a class body two members.
 */
export const sameLineInfix: ReadonlySet<string> = new Set(["as", "satisfies"]);

/**
 * Spellings that carry an expression on from the line before, so that a line
 * break in front of one ends nothing: every infix operator that may begin a
 * line, a conditional's `?` and `:`, and a member access.
 *
 * A postfix operator is not among them. The grammar writes
 * `LeftHandSideExpression [no LineTerminator here] ++`, so `a` and the `++b`
 * under it are two statements rather than one.
 */
export const expressionContinuedBy: ReadonlySet<string> = new Set([
  ...[...spellingsOf("infix")].filter(
    (spelling) => !sameLineInfix.has(spelling),
  ),
  ".",
  "?.",
  "?",
  ":",
]);

/**
 * The operators of TypeScript's type grammar, with what each binds at. A
 * function or constructor type and a conditional type are the loosest -- each
 * runs on as far as it can, so neither stands bare in a union -- then a
 * union, then an intersection, then the prefix operators. Postfix `[]` and an
 * indexed access bind tighter than any of them: `A | B[]` is a union whose
 * second member is an array.
 *
 * `|` and `&` are prefix as well as infix, since a union or an intersection
 * may begin with its own operator. No parser reads types by this table; it
 * says how tightly a type a macro built holds together where it is printed,
 * and which words beside an operand take it as theirs.
 */
export const coreTypeOperators: readonly CoreOperator[] = Object.freeze([
  ...operators(["=>", "extends"], "infix", 10, "right"),
  ...operators(["|"], "infix", 20, "left"),
  ...operators(["|"], "prefix", 20, "right"),
  ...operators(["&"], "infix", 30, "left"),
  ...operators(["&"], "prefix", 30, "right"),
  ...operators(["keyof", "unique", "readonly", "infer"], "prefix", 40, "right"),
]);

/** What `T[]` and `T[K]` bind their operand at: tighter than any operator. */
export const typePostfixPrecedence = 50;

/**
 * Spellings that take what is written directly after them as their operand,
 * in an expression or in a type: every prefix and infix operator, and the
 * `.`, `?.`, `?`, `:` and `...` an operand is written after.
 */
export const operandTakenAfter: ReadonlySet<string> = new Set([
  ...spellingsOf("prefix"),
  ...spellingsOf("infix"),
  ...coreTypeOperators
    .filter(({ fixity }) => fixity !== "postfix")
    .map(({ spelling }) => spelling),
  ".",
  "?.",
  "?",
  ":",
  "...",
]);

/**
 * Spellings that take what is written directly before them as their operand,
 * in an expression or in a type: every infix and postfix operator, a non-null
 * assertion's `!`, and the `.`, `?.`, `?` and `:` written after an operand.
 */
export const operandTakenBefore: ReadonlySet<string> = new Set([
  ...spellingsOf("infix"),
  ...spellingsOf("postfix"),
  ...coreTypeOperators
    .filter(({ fixity }) => fixity === "infix")
    .map(({ spelling }) => spelling),
  "!",
  ".",
  "?.",
  "?",
  ":",
]);
