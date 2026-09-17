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
    160,
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
