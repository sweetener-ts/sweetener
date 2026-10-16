import type { BindingId } from "@sweetener/shared";
import {
  assignmentPrecedence,
  conditionalPrecedence,
  coreExpressionOperators,
  createPrecedence,
  createProtectedSyntax,
  createSyntaxSequence,
  primaryPrecedence,
  sameLineInfix,
  unaryPrecedence,
  type PrattAssociativity,
  type PrattFixity,
  leadingLineBreak,
  regularExpression,
  spanEnvelope,
  type ExpressionForm,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCursor,
  type SyntaxSequence,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  createConsumerFailure,
  type ConsumerAttempt,
  type ConsumerContext,
  type SyntaxConsumer,
} from "./consumer.js";
import {
  arrowBodyStart,
  asyncArrowHead,
  createPrimaryExpressionConsumer,
  type PrimaryExpressionConsumerOptions,
} from "./primary-expression.js";
import { divisionAt } from "./slash-reading.js";
import { StopSet } from "./stop-set.js";
import { consumeBalancedTypeArguments } from "./type-class-element.js";

export {
  coreExpressionOperators,
  type CoreOperator,
  type PrattAssociativity,
  type PrattFixity,
} from "@sweetener/syntax";

const coreByKey = new Map(
  coreExpressionOperators.map((operator) => [
    `${operator.fixity}|${operator.spelling}`,
    operator,
  ]),
);

/** What a division binds at. */
const divisionPrecedence = coreByKey.get("infix|/")!.precedence;

export interface MacroOperatorExpansionInput {
  readonly operator: readonly Syntax[];
  readonly left: ProtectedSyntax | undefined;
  readonly right: ProtectedSyntax | undefined;
  readonly context: ConsumerContext;
}

export interface MacroOperatorCandidate {
  readonly binding: BindingId;
  readonly spelling: string;
  readonly fixity: PrattFixity;
  readonly precedence: number;
  readonly associativity: PrattAssociativity;
  readonly width: number;
  readonly shadowsCore?: boolean | undefined;
  /**
   * Token runs a rule takes as its whole right operand, such as `await` in
   * `p |> await`. One is taken only where what follows cannot continue an
   * operand, so `p |> await f` is still read as an expression.
   */
  readonly literalRightOperands?: readonly (readonly string[])[] | undefined;
  /**
   * Whether the right operand may be an unparenthesized arrow function, whose
   * body ends at the next use of this operator.
   */
  readonly arrowOperand?: boolean | undefined;
  readonly expand: (input: MacroOperatorExpansionInput) => ProtectedSyntax;
}

export type MacroOperatorResolver = (
  cursor: SyntaxCursor,
  fixity: PrattFixity,
  context: ConsumerContext,
) => MacroOperatorCandidate | undefined;

export interface PrattExpressionConsumerOptions extends PrimaryExpressionConsumerOptions {
  /**
   * Consumes what stands to the right of `as` and `satisfies`, which is a type
   * and not an expression. Parsed as an expression, `x as const` and
   * `x as string[]` do not parse at all, and the statement holding them fell
   * back to unexpanded tokens with nothing reported.
   */
  readonly consumeType?: SyntaxConsumer | undefined;
  readonly resolveMacroOperator?: MacroOperatorResolver | undefined;
  /** Enables the low-precedence comma operator for full Expression contexts. */
  readonly allowComma?: boolean | undefined;
}

interface PrattOperator {
  readonly spelling: string;
  readonly fixity: PrattFixity;
  readonly precedence: number;
  readonly associativity: PrattAssociativity;
  readonly width: number;
  readonly macro: MacroOperatorCandidate | undefined;
}

interface ParsedExpression {
  readonly syntax: ProtectedSyntax;
  readonly cursor: SyntaxCursor;
  readonly outerPrecedence: number;
  readonly unparenthesizedPrefix: boolean;
  readonly mixingFamily: "logical" | "nullish" | undefined;
  /**
   * Whether `syntax` is one operand as the primary reader read it, with no
   * operator applied to it: the only operand an arrow's parameters can be.
   */
  readonly primary: boolean;
}

interface PrattContext {
  readonly consumer: ConsumerContext;
  readonly options: PrattExpressionConsumerOptions;
  readonly primary: SyntaxConsumer;
  readonly start: number;
  readonly allowComma: boolean;
  /**
   * The regular expressions read where an operator stands that are not to be
   * split into a division here, because the expression would end among the
   * tokens they split into (see `parseExpressionAt`).
   */
  readonly unsplit: ReadonlySet<TokenSyntax>;
}

/**
 * Thrown where the parser reads a regular expression literal where an
 * operator stands, and the literal splits into the tokens of a division: the
 * literal read the other way, in place (see `divisionAt`). Caught where the
 * expression it stands in began to be read from its sequence, which reads the
 * expression again over the tokens the literal splits into.
 */
class DivisionRead extends Error {
  override readonly name = "DivisionRead";

  constructor(
    readonly sequence: SyntaxSequence,
    readonly index: number,
    readonly literal: TokenSyntax,
    readonly tokens: readonly TokenSyntax[],
  ) {
    super("A regular expression literal stands where an operator does");
  }
}

function tokenSpelling(cursor: SyntaxCursor): string | undefined {
  const syntax = cursor.peek();
  return syntax?.tag === "token" ? syntax.raw : undefined;
}

/**
 * The reader always emits `>` as its own token so nested type arguments close
 * without rescanning. Operators spelled with a leading `>` therefore arrive as
 * adjacent single-character tokens and have to be rejoined here.
 */
const greaterThanContinuations = new Set([">", "="]);
const maximumGreaterThanWidth = 4;

function joinGreaterThan(
  cursor: SyntaxCursor,
  fixity: PrattFixity,
): PrattOperator | undefined {
  let spelling = "";
  let previousEnd: number | undefined;
  let widest: PrattOperator | undefined;
  for (let width = 1; width <= maximumGreaterThanWidth; width += 1) {
    const syntax = cursor.peek(width - 1);
    if (syntax?.tag !== "token") break;
    if (width > 1) {
      if (!greaterThanContinuations.has(syntax.raw)) break;
      if (syntax.leadingTrivia.length > 0 || previousEnd !== syntax.span.start)
        break;
    }
    spelling += syntax.raw;
    previousEnd = syntax.span.end;
    const core = coreByKey.get(`${fixity}|${spelling}`);
    if (core !== undefined) widest = { ...core, width, macro: undefined };
  }
  return widest;
}

function resolveOperator(
  cursor: SyntaxCursor,
  fixity: PrattFixity,
  context: PrattContext,
): PrattOperator | undefined {
  const macro = context.options.resolveMacroOperator?.(
    cursor,
    fixity,
    context.consumer,
  );
  if (macro !== undefined) {
    const actualSpelling = Array.from({ length: macro.width }, (_, index) => {
      const syntax = cursor.peek(index);
      return syntax?.tag === "token" ? syntax.raw : "";
    }).join("");
    if (
      macro.fixity !== fixity ||
      !Number.isSafeInteger(macro.width) ||
      macro.width < 1 ||
      actualSpelling !== macro.spelling ||
      !Number.isSafeInteger(macro.precedence) ||
      macro.precedence < 1 ||
      macro.precedence > 1_000_000
    ) {
      throw new TypeError(
        "Macro operator resolver returned an invalid candidate",
      );
    }
    const core = coreByKey.get(`${fixity}|${macro.spelling}`);
    if (core !== undefined && macro.shadowsCore !== true) {
      return { ...core, width: macro.width, macro: undefined };
    }
    return { ...macro, macro };
  }
  const spelling = tokenSpelling(cursor);
  if (spelling === undefined) return undefined;
  if (spelling === ">") return joinGreaterThan(cursor, fixity);
  const core = coreByKey.get(`${fixity}|${spelling}`);
  if (core === undefined) return undefined;
  // `yield*` is one operator written as two tokens. Taken as `yield` and then
  // infix `*`, it never parsed, and the body holding it fell back to
  // unexpanded tokens with nothing reported.
  if (fixity === "prefix" && spelling === "yield") {
    const next = cursor.peek(1);
    if (next?.tag === "token" && next.raw === "*")
      return { ...core, width: 2, macro: undefined };
  }
  return { ...core, width: 1, macro: undefined };
}

function consumeOperator(
  cursor: SyntaxCursor,
  operator: PrattOperator,
): readonly Syntax[] {
  const syntax: Syntax[] = [];
  for (let index = 0; index < operator.width; index += 1) {
    syntax.push(cursor.consume()!);
  }
  return Object.freeze(syntax);
}

function operatorHasLeadingLineBreak(operator: Syntax | undefined): boolean {
  return (
    operator?.tag === "token" &&
    operator.leadingTrivia.some((trivia) => trivia.hasLineBreak)
  );
}

function outputOrigin(origins: OriginStore, children: readonly Syntax[]) {
  const unique = [...new Set(children.map((child) => child.origin))];
  return unique.length === 1 ? unique[0]! : origins.composed(unique);
}

const assignmentOperators = new Set([
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
]);

/** The form a core operator gives the expression it builds, if any. */
function coreForm(
  fixity: PrattFixity,
  spelling: string,
): ExpressionForm | undefined {
  if (fixity === "prefix")
    return spelling === "yield"
      ? "yield"
      : spelling === "await"
        ? "await"
        : undefined;
  if (fixity !== "infix") return undefined;
  if (spelling === "=>") return "arrow";
  return assignmentOperators.has(spelling) ? "assignment" : undefined;
}

/**
 * What ends an expression for the caller to read on from, where the caller
 * reads a chain of one level's operators itself and holds it as one node.
 *
 * Every operand of a right-associative chain -- `a ** b ** c`, `a = b = c` --
 * and the alternate of every conditional in `a ? b : c ? d : e` were read by
 * reading the rest of the chain, one call deeper for each operator, and each
 * was held as a node holding the rest. Fifty thousand of them exhausted the
 * call stack, and the tree they would have made was as deep as the chain was
 * long, which every walk over it then had to be.
 */
interface ChainEnd {
  /** A core right-associative infix operator of this level, other than `=>`. */
  readonly rightAssociative?: number | undefined;
  /** A conditional's `?`. */
  readonly conditional?: boolean | undefined;
}

/**
 * Whether `operator` joins a chain of its level's core operators held as one
 * node: `a + b - c` as `a`, `+`, `b`, `-`, `c`, as a fold builds one. `=>`
 * reads parameters to its left rather than an operand, and `as` and
 * `satisfies` a type to their right, so each stands as a node of its own.
 */
function chains(operator: PrattOperator): boolean {
  return (
    operator.macro === undefined &&
    operator.spelling !== "=>" &&
    operator.spelling !== "as" &&
    operator.spelling !== "satisfies"
  );
}

function protect(
  options: PrattExpressionConsumerOptions,
  children: readonly Syntax[],
  precedence: number,
  form?: ExpressionForm,
): ProtectedSyntax {
  const first = children[0]!;
  return createProtectedSyntax({
    id: options.allocateSyntaxId(),
    span: spanEnvelope(children.map(({ span }) => span)),
    origin: outputOrigin(options.origins, children),
    scopes: first.scopes,
    category: "expr",
    precedence: createPrecedence(precedence),
    form,
    children,
  });
}

function fail(
  cursor: SyntaxCursor,
  context: PrattContext,
  expectations: readonly string[],
  specificity: number,
): ConsumerAttempt {
  return Object.freeze({
    matched: false,
    failure: createConsumerFailure({
      category: "expr",
      cursor: cursor.identity,
      progress: cursor.index - context.start,
      specificity,
      expectations,
    }),
  });
}

function checkWork(context: PrattContext): void {
  context.consumer.cancellation.throwIfCancellationRequested();
  context.consumer.tracker.checkDeadline();
  context.consumer.tracker.chargeMatcherSteps();
}

/**
 * Whether `node` can be nothing but the operand of the `await` or `yield`
 * written in front of it, outside the function that admits the word.
 *
 * TypeScript decides this by the token itself rather than by what it could
 * begin: an identifier, a keyword, or a number, bigint or string standing on
 * the word's own line is its operand, and every other token is read as what
 * follows the name. So `await + 1` and `await * 2` are both sums of the name
 * -- even though `+` also begins an operand of its own -- while `await (v)`
 * calls, `await [v]` indexes, `` await `t` `` tags a template, `await ++x`
 * increments, and `await` written alone is the name itself.
 */
function suspendedOperandBegins(node: Syntax | undefined): boolean {
  if (node?.tag !== "token" || leadingLineBreak(node)) return false;
  return (
    node.kind === "identifier" ||
    node.kind === "keyword" ||
    node.kind === "numeric-literal" ||
    node.kind === "bigint-literal" ||
    node.kind === "string-literal"
  );
}

/**
 * Whether the `yield` at the cursor, in a generator, yields nothing: no
 * operand of its own follows it on its line. The grammar writes `yield [no
 * LineTerminator here] AssignmentExpression` with the operand optional, so
 * `yield` at the end of what is read, before a separator, before what ends
 * the expression around it, or before a line break is the whole expression.
 * Read as one more prefix operator, a macro whose result is `yield` was
 * refused as not one expression.
 */
function yieldsNothing(cursor: SyntaxCursor, context: PrattContext): boolean {
  const after = cursor.fork();
  after.advance();
  const next = after.peek();
  return (
    next === undefined ||
    leadingLineBreak(next) ||
    context.consumer.stopSet.matches(after) ||
    (next.tag === "token" &&
      (next.raw === "," || next.raw === ";" || next.raw === ":"))
  );
}

/**
 * Whether the `yield` or `await` at the cursor stands alone, with no operand
 * of its own after it, so that the word is read as the ordinary word it also
 * is rather than as the operator.
 *
 * `yield` is a restricted production -- the grammar writes `yield
 * [no LineTerminator here] AssignmentExpression` -- so a line break after it
 * ends it wherever it is written, inside a generator as readily as outside
 * one. `await` carries no such restriction inside an async function, where it
 * reaches the next line.
 *
 * `await` and `yield` are ordinary identifiers in the code that does not
 * suspend -- `const await = 1` is legal TypeScript -- and that is what
 * `const x = yield\nv;` ends the declaration at the line break for: the
 * initializer is the name, and `v;` is the statement under it. Outside the
 * function that admits it the word is that name wherever no operand of its
 * own stands beside it, so `const x = await;` and `const x = await + 1;` are
 * a name and a sum. Where an operand does stand there, using the word outside
 * the function that admits it stays the refusal it was.
 */
function suspendingWordAlone(
  cursor: SyntaxCursor,
  operator: PrattOperator,
  context: PrattContext,
): boolean {
  const next = cursor.peek(1);
  // Inside a generator `yield` is never a name: standing alone it is a
  // `yield` of nothing, which `yieldsNothing` reads.
  if (operator.spelling === "yield")
    return !context.consumer.allowYield && !suspendedOperandBegins(next);
  if (operator.spelling === "await")
    return !context.consumer.allowAwait && !suspendedOperandBegins(next);
  return false;
}

/**
 * The prefix operator at the cursor, if one stands there: not the `new` of
 * `new.target`, and not a `yield` or `await` read as the word it also is.
 */
function prefixAt(
  cursor: SyntaxCursor,
  context: PrattContext,
): PrattOperator | undefined {
  const dot = cursor.peek(1);
  const target = cursor.peek(2);
  const newTarget =
    tokenSpelling(cursor) === "new" &&
    dot?.tag === "token" &&
    dot.raw === "." &&
    target?.tag === "token" &&
    target.raw === "target";
  const resolved = newTarget
    ? undefined
    : resolveOperator(cursor, "prefix", context);
  return resolved !== undefined &&
    suspendingWordAlone(cursor, resolved, context)
    ? undefined
    : resolved;
}

/**
 * A run of `first`'s level of core prefix operators and the operand they
 * apply to, held as one node: `!!a` as `!`, `!`, `a`, and `yield yield v` as
 * both `yield`s and `v`. Each operator's operand was read by reading the rest
 * of the run, one call deeper for each and held as a node holding the rest,
 * so fifty thousand of them exhausted the call stack. A `yield` or an `await`
 * that the function refuses, or a `yield` of nothing, ends the run and is
 * read as its operand, where that is decided; so does `new`, whose operand is
 * opened into it.
 */
function parsePrefixRun(
  first: PrattOperator,
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  const children: Syntax[] = [...consumeOperator(cursor, first)];
  for (;;) {
    checkWork(context);
    const next = prefixAt(cursor, context);
    if (
      next === undefined ||
      next.macro !== undefined ||
      next.spelling === "new" ||
      next.precedence !== first.precedence ||
      (next.spelling === "yield" &&
        (!context.consumer.allowYield || yieldsNothing(cursor, context))) ||
      (next.spelling === "await" && !context.consumer.allowAwait)
    )
      break;
    for (const token of consumeOperator(cursor, next)) children.push(token);
  }
  const operand = parseExpression(cursor, first.precedence, context);
  if ("matched" in operand) return operand;
  children.push(operand.syntax);
  return {
    syntax: protect(
      context.options,
      children,
      first.precedence,
      coreForm("prefix", first.spelling),
    ),
    cursor,
    outerPrecedence: first.precedence,
    unparenthesizedPrefix: true,
    mixingFamily: undefined,
    primary: false,
  };
}

function parsePrefix(
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  checkWork(context);
  const prefix = prefixAt(cursor, context);
  if (prefix !== undefined) {
    if (prefix.spelling === "yield" && !context.consumer.allowYield) {
      return fail(cursor, context, ["yield inside a generator"], 9);
    }
    if (prefix.spelling === "yield" && yieldsNothing(cursor, context)) {
      const [word] = consumeOperator(cursor, prefix);
      return {
        syntax: protect(
          context.options,
          [word!],
          prefix.precedence,
          coreForm("prefix", prefix.spelling),
        ),
        cursor,
        outerPrecedence: prefix.precedence,
        unparenthesizedPrefix: true,
        mixingFamily: undefined,
        primary: false,
      };
    }
    if (prefix.spelling === "await" && !context.consumer.allowAwait) {
      return fail(cursor, context, ["await inside an async function"], 9);
    }
    if (prefix.macro === undefined && prefix.spelling !== "new")
      return parsePrefixRun(prefix, cursor, context);
    const operator = consumeOperator(cursor, prefix);
    const operand = cursor.peek();
    const right = parseExpression(cursor, prefix.precedence, context);
    if ("matched" in right) return right;
    // What `new` constructs and the arguments it passes are written as one
    // run, `new F(1)`, so the parse of what follows it is opened into the
    // `new`. An operand that arrived whole -- a capture, an expansion -- is
    // not opened: it is what is constructed, and opened, `new $c` with `$c`
    // bound to `F(1)` constructed `F` with an argument instead.
    const coreChildren =
      prefix.spelling === "new" && right.syntax !== operand
        ? [...operator, ...right.syntax.children]
        : [...operator, right.syntax];
    const syntax =
      prefix.macro?.expand({
        operator,
        left: undefined,
        right: right.syntax,
        context: context.consumer,
      }) ??
      protect(
        context.options,
        coreChildren,
        prefix.precedence,
        coreForm("prefix", prefix.spelling),
      );
    if (syntax.category !== "expr") {
      throw new TypeError(
        "Macro prefix operator returned non-expression syntax",
      );
    }
    return {
      syntax,
      cursor: right.cursor,
      outerPrecedence: prefix.precedence,
      unparenthesizedPrefix: true,
      mixingFamily: undefined,
      primary: false,
    };
  }
  const operandStart = cursor.index;
  const operand = cursor.peek();
  const attempt = context.primary.consume(cursor, context.consumer);
  if (!attempt.matched) {
    // The primary consumer read no operand, and a `<` standing where the
    // operand began is the one thing that still can be one. Asked only where
    // the cursor has not moved: a failure that read part of an operand --
    // `a?.` with no member after it -- leaves the cursor past what it read,
    // and a `<` reached that way begins no operand at all. Read from there,
    // the `a?.` in front of it was dropped from the declaration outright.
    const assertion =
      cursor.index === operandStart
        ? parseTypeAssertion(cursor, context)
        : undefined;
    return assertion ?? attempt;
  }
  return {
    syntax: attempt.syntax,
    cursor: attempt.cursor,
    // An expression already read -- a capture spliced into a template -- is
    // one operand, kept whole however loosely it binds inside. An arrow
    // function written here is an assignment expression, however its body is
    // written, and binds no tighter than the `=>` it is read with elsewhere.
    outerPrecedence:
      attempt.syntax === operand
        ? primaryPrecedence
        : attempt.syntax.form === "arrow"
          ? assignmentPrecedence
          : (attempt.syntax.precedence ?? primaryPrecedence),
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
    primary: true,
  };
}

/**
 * A prefix type assertion -- `<A>value` -- as the `<...>` it is written with
 * and the operand it applies to, or undefined where none stands at the cursor.
 *
 * TypeScript writes `TypeAssertion: < Type > UnaryExpression`, and reads one
 * only where JSX is off: in a `.tsx` file a `<` in an operand position opens
 * an element instead. The consumers are never told which file they are reading
 * and do not need to be, because the reader has already settled it. Reading a
 * `.stsx` file it groups the element -- `<A>y` arrives as one `jsx-element`
 * node, with the diagnostic TypeScript reports for it -- so a `<` still
 * standing here as a token was read from a `.sts` file, where the assertion is
 * what TypeScript reads too.
 *
 * A generic arrow's type parameters are written with the same `<...>`, and
 * TypeScript resolves the ambiguity in the arrow's favour. The primary
 * consumer reads the arrow, so this is asked only where it read nothing.
 */
function parseTypeAssertion(
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | undefined {
  if (tokenSpelling(cursor) !== "<") return undefined;
  const region = consumeBalancedTypeArguments(cursor, context.consumer);
  if (region === undefined) return undefined;
  const working = cursor.fork();
  const asserted: Syntax[] = [];
  for (let taken = 0; taken < region.width; taken += 1)
    asserted.push(working.consume()!);
  // The type between the angles is kept as it was written. Its extent is
  // already fixed by the angles that close it, which is the whole of what this
  // reader needs; the type consumer is asked after `as`, where nothing else
  // says where the type ends.
  const operand = parseExpression(working, unaryPrecedence, context);
  if ("matched" in operand) return undefined;
  // Measured on a fork, so that a `<` this cannot read leaves the cursor where
  // the primary consumer's own failure is reported from. The extent has to be
  // carried onto the cursor the caller passed down, which is the one it reads
  // on from.
  cursor.advance(operand.cursor.index - cursor.index);
  return {
    syntax: protect(
      context.options,
      [...asserted, operand.syntax],
      unaryPrecedence,
    ),
    cursor,
    outerPrecedence: unaryPrecedence,
    unparenthesizedPrefix: true,
    mixingFamily: undefined,
    primary: false,
  };
}

/**
 * The conditional `left` is the test of, and every conditional in alternate
 * position after it, held as one node: `a ? b : c ? d : e` as its tests,
 * consequents and the last alternate, in the order they are written. Each
 * alternate is read up to the `?` of the next, so a chain of any length is
 * read one level deep.
 */
function parseConditional(
  left: ParsedExpression,
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  const consequentContext: PrattContext = {
    ...context,
    allowComma: true,
    consumer: Object.freeze({
      ...context.consumer,
      stopSet: context.consumer.stopSet.union(
        new StopSet([{ kind: "token", raw: ":" }]),
      ),
    }),
  };
  const children: Syntax[] = [left.syntax];
  do {
    const question = cursor.consume()!;
    const consequent = parseExpression(cursor, 0, consequentContext);
    if ("matched" in consequent) return consequent;
    const colon = cursor.peek();
    if (colon?.tag !== "token" || colon.raw !== ":") {
      return fail(
        cursor,
        context,
        ["':' in conditional expression"],
        conditionalPrecedence,
      );
    }
    cursor.advance();
    const alternate = parseExpression(cursor, assignmentPrecedence, context, {
      conditional: true,
    });
    if ("matched" in alternate) return alternate;
    children.push(question, consequent.syntax, colon, alternate.syntax);
  } while (
    !cursor.atEnd &&
    !context.consumer.stopSet.matches(cursor) &&
    tokenSpelling(cursor) === "?"
  );
  return {
    syntax: protect(
      context.options,
      children,
      conditionalPrecedence,
      "conditional",
    ),
    cursor,
    outerPrecedence: conditionalPrecedence,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
    primary: false,
  };
}

/**
 * What stands to the right of `as` or `satisfies`: a type, not an expression.
 *
 * Read as an expression, `x as const` and `x as string[]` do not parse, and
 * the statement holding them would fall back to unexpanded tokens with nothing
 * reported — so one `as const` in a function body would silently stop every
 * macro in it from running.
 */
function parseAssertedType(
  cursor: SyntaxCursor,
  context: PrattContext,
  precedence: number,
): ParsedExpression | ConsumerAttempt {
  const consumer = context.options.consumeType;
  if (consumer === undefined)
    return parseExpression(cursor, precedence + 1, context);
  const attempt = consumer.consume(cursor, context.consumer);
  if (!attempt.matched) return attempt;
  return {
    syntax: attempt.syntax,
    cursor: attempt.cursor,
    outerPrecedence: precedence,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
    primary: false,
  };
}

/**
 * Whether nothing at the cursor continues the operand before it: the end,
 * a stop, a statement or conditional boundary, or an operator that takes an
 * operand on its left.
 */
function endsOperand(cursor: SyntaxCursor, context: PrattContext): boolean {
  if (cursor.atEnd || context.consumer.stopSet.matches(cursor)) return true;
  const next = cursor.peek();
  if (next?.tag === "token" && (next.raw === ";" || next.raw === "?"))
    return true;
  return (
    resolveOperator(cursor, "infix", context) !== undefined ||
    resolveOperator(cursor, "postfix", context) !== undefined
  );
}

/**
 * A right operand one of the operator's rules spells as literal tokens, as
 * `$value:expr |> await` spells `await`. It is taken only where it is the
 * whole operand; `p |> await f` has more after `await`, and is read as the
 * expression it is.
 */
function literalRightOperand(
  cursor: SyntaxCursor,
  macro: MacroOperatorCandidate,
  context: PrattContext,
): ParsedExpression | undefined {
  for (const run of macro.literalRightOperands ?? []) {
    const spelled = run.every((raw, offset) => {
      const node = cursor.peek(offset);
      return node?.tag === "token" && node.raw === raw;
    });
    if (!spelled) continue;
    const after = cursor.fork();
    after.advance(run.length);
    if (!endsOperand(after, context)) continue;
    const tokens = Array.from({ length: run.length }, () => cursor.consume()!);
    return {
      syntax: protect(context.options, tokens, primaryPrecedence),
      cursor,
      outerPrecedence: primaryPrecedence,
      unparenthesizedPrefix: false,
      mixingFamily: undefined,
      primary: false,
    };
  }
  return undefined;
}

/**
 * The context an arrow's body is read in. An arrow is never a generator, so
 * `yield` is not an expression in its body even inside one, and `await` is one
 * there only when the arrow itself is written `async`.
 */
function arrowBodyContext(context: PrattContext, async: boolean): PrattContext {
  return {
    ...context,
    consumer: Object.freeze({
      ...context.consumer,
      allowYield: false,
      allowAwait: async,
    }),
  };
}

/**
 * An arrow function standing unparenthesized as the right operand of an
 * operator declared `operand arrow;`. Its body ends at the next use of the
 * operator, so `x |> n => f(n) |> g` applies `g` to what the arrow returns
 * rather than putting `|> g` inside the arrow. Anything else at the cursor
 * is left to the ordinary operand parse.
 */
function arrowRightOperand(
  cursor: SyntaxCursor,
  macro: MacroOperatorCandidate,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt | undefined {
  const bodyStart = arrowBodyStart(cursor, context.consumer);
  if (bodyStart === undefined) return undefined;
  const head = Array.from({ length: bodyStart }, () => cursor.consume()!);
  const block = cursor.peek();
  let body: Syntax;
  if (block?.tag === "group" && block.delimiter === "brace") {
    body = cursor.consume()!;
  } else {
    const parsed = parseExpression(cursor, assignmentPrecedence, {
      ...context,
      allowComma: false,
      consumer: Object.freeze({
        ...arrowBodyContext(context, asyncArrowHead(head)).consumer,
        stopSet: context.consumer.stopSet.union(
          new StopSet([{ kind: "spelling", raw: macro.spelling }]),
        ),
      }),
    });
    if ("matched" in parsed) return parsed;
    body = parsed.syntax;
  }
  return {
    syntax: protect(
      context.options,
      [...head, body],
      assignmentPrecedence,
      "arrow",
    ),
    cursor,
    outerPrecedence: assignmentPrecedence,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
    primary: false,
  };
}

/**
 * The arrow the infix `=>` reads, with `left` the operand standing to its
 * left: `v => …` and `(v) => …`.
 *
 * That operand is the arrow's parameters, not an expression, so the arrow
 * holds what it was read from rather than the operand itself, as an arrow the
 * primary reader takes does. Held as an expression, the parameters were walked
 * as one, and a parameter spelled like a macro was dispatched: `x => x` in a
 * template, with an expression macro `x` in scope, emitted `99 => 99`. Nothing
 * said the name was a binder, so the `x` in the body was dispatched too. A
 * block body is a statement list, not an operand, and is held as the brace
 * it is for the same reason.
 */
function infixArrow(
  left: ParsedExpression,
  operator: readonly Syntax[],
  precedence: number,
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  const block = cursor.peek();
  let body: Syntax;
  if (block?.tag === "group" && block.delimiter === "brace") {
    body = cursor.consume()!;
  } else {
    // No arrow this route reads is async: an operand spelled `async` is the
    // parameter's own name, as in `async => body`.
    const parsed = parseExpression(
      cursor,
      precedence,
      arrowBodyContext(context, false),
    );
    if ("matched" in parsed) return parsed;
    body = parsed.syntax;
  }
  // An operand an operator built is no parameter list, and the arrow holds
  // it whole rather than taking apart what the operator built.
  const parameters = left.primary ? left.syntax.children : [left.syntax];
  return {
    syntax: protect(
      context.options,
      [...parameters, ...operator, body],
      precedence,
      "arrow",
    ),
    cursor,
    outerPrecedence: precedence,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
    primary: false,
  };
}

/**
 * The chain of `first`'s level of core operators that `left` and `operator`
 * begin, read in one loop and held as one node: `a + b - c` as `a`, `+`, `b`,
 * `-`, `c`, and `a = b += c` as `a`, `=`, `b`, `+=`, `c`. Its operands are
 * read at the level just above it, or for a right-associative level at the
 * level itself up to its next operator, so reading the chain asks for one
 * operand at a time however long it is, and the node is as deep as the
 * levels it is written with rather than as long as it is.
 */
function parseChain(
  left: ParsedExpression,
  first: PrattOperator,
  operator: readonly Syntax[],
  mixingFamily: ParsedExpression["mixingFamily"],
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  const precedence = first.precedence;
  const rightAssociative = first.associativity === "right";
  const children: Syntax[] = [left.syntax, ...operator];
  for (;;) {
    const operand = rightAssociative
      ? parseExpression(cursor, precedence, context, {
          rightAssociative: precedence,
        })
      : parseExpression(cursor, precedence + 1, context);
    if ("matched" in operand) return operand;
    if (
      (mixingFamily === "logical" && operand.mixingFamily === "nullish") ||
      (mixingFamily === "nullish" && operand.mixingFamily === "logical")
    )
      return fail(
        cursor,
        context,
        ["parentheses when mixing '??' with '&&' or '||'"],
        40,
      );
    children.push(operand.syntax);
    if (cursor.atEnd || context.consumer.stopSet.matches(cursor)) break;
    const next = resolveOperator(cursor, "infix", context);
    if (
      next === undefined ||
      next.precedence !== precedence ||
      !chains(next) ||
      (next.spelling === "," && !context.allowComma)
    )
      break;
    if (next.spelling === "**" && operand.unparenthesizedPrefix)
      return fail(
        cursor,
        context,
        ["parentheses around a unary expression before '**'"],
        40,
      );
    checkWork(context);
    for (const token of consumeOperator(cursor, next)) children.push(token);
  }
  return {
    syntax: protect(
      context.options,
      children,
      precedence,
      coreForm("infix", first.spelling),
    ),
    cursor,
    outerPrecedence: precedence,
    unparenthesizedPrefix: false,
    mixingFamily,
    primary: false,
  };
}

function parseExpression(
  cursor: SyntaxCursor,
  minimumPrecedence: number,
  context: PrattContext,
  ends: ChainEnd = {},
): ParsedExpression | ConsumerAttempt {
  const prefixed = parsePrefix(cursor, context);
  if ("matched" in prefixed) return prefixed;
  let left = prefixed;
  while (!cursor.atEnd && !context.consumer.stopSet.matches(cursor)) {
    checkWork(context);
    const spelling = tokenSpelling(cursor);
    if (spelling === "?" && conditionalPrecedence >= minimumPrecedence) {
      if (ends.conditional === true) break;
      const conditional = parseConditional(left, cursor, context);
      if ("matched" in conditional) return conditional;
      left = conditional;
      continue;
    }
    const postfix = resolveOperator(cursor, "postfix", context);
    if (
      postfix !== undefined &&
      postfix.precedence >= minimumPrecedence &&
      !operatorHasLeadingLineBreak(cursor.peek())
    ) {
      if (
        postfix.associativity === "none" &&
        left.outerPrecedence === postfix.precedence
      ) {
        return fail(
          cursor,
          context,
          [`parentheses around repeated postfix '${postfix.spelling}'`],
          40,
        );
      }
      const operator = consumeOperator(cursor, postfix);
      const syntax =
        postfix.macro?.expand({
          operator,
          left: left.syntax,
          right: undefined,
          context: context.consumer,
        }) ??
        protect(
          context.options,
          [left.syntax, ...operator],
          postfix.precedence,
        );
      if (syntax.category !== "expr") {
        throw new TypeError(
          "Macro postfix operator returned non-expression syntax",
        );
      }
      left = {
        syntax,
        cursor,
        outerPrecedence: postfix.precedence,
        unparenthesizedPrefix: false,
        mixingFamily: left.mixingFamily,
        primary: false,
      };
      continue;
    }
    const infix = resolveOperator(cursor, "infix", context);
    // A regular expression where an operator stands is a division, whatever
    // the reader made of it from the token before: `x = y as const / 2 / 3`
    // divides the assertion, where the reader took `const` for a word an
    // operand follows. It is one where a `/` would be taken here: not after
    // an assignment or an arrow function, which take no operator after them,
    // and not in an operand whose operators bind more tightly, where the
    // operand around it takes it.
    const slash = cursor.peek();
    if (
      infix === undefined &&
      regularExpression(slash) &&
      divisionPrecedence >= minimumPrecedence &&
      left.outerPrecedence > assignmentPrecedence
    ) {
      const tokens = context.unsplit.has(slash)
        ? undefined
        : divisionAt(slash, cursor.peek(1), context.options);
      if (tokens !== undefined && !("kind" in tokens))
        throw new DivisionRead(
          cursor.remainingRange().sequence,
          cursor.index,
          slash,
          tokens,
        );
      context.consumer.slashMisread?.(slash, "division");
    }
    if (infix === undefined || infix.precedence < minimumPrecedence) break;
    if (
      ends.rightAssociative === infix.precedence &&
      infix.associativity === "right" &&
      chains(infix)
    )
      break;
    // TypeScript takes no operator but a comma after an assignment
    // expression. One that could have taken the operator already did, inside
    // its right operand; one that could not is an arrow function, whose body
    // ended it. So `x = () => {}` and the `/re/` written under it are two
    // statements rather than a division, and so are `() => {}` and the
    // `/=x/.test(s);` under it rather than a compound assignment.
    if (
      infix.macro === undefined &&
      left.outerPrecedence <= assignmentPrecedence &&
      infix.precedence >= assignmentPrecedence
    )
      break;
    if (
      infix.macro === undefined &&
      sameLineInfix.has(infix.spelling) &&
      leadingLineBreak(cursor.peek())
    )
      break;
    if (infix.spelling === "," && !context.allowComma) break;
    const mixingFamily =
      infix.spelling === "??"
        ? "nullish"
        : infix.spelling === "&&" || infix.spelling === "||"
          ? "logical"
          : undefined;
    if (
      (mixingFamily === "logical" && left.mixingFamily === "nullish") ||
      (mixingFamily === "nullish" && left.mixingFamily === "logical")
    ) {
      return fail(
        cursor,
        context,
        ["parentheses when mixing '??' with '&&' or '||'"],
        40,
      );
    }
    if (infix.spelling === "**" && left.unparenthesizedPrefix) {
      return fail(
        cursor,
        context,
        ["parentheses around a unary expression before '**'"],
        40,
      );
    }
    if (
      infix.associativity === "none" &&
      left.outerPrecedence === infix.precedence
    ) {
      return fail(
        cursor,
        context,
        [`parentheses around repeated nonassociative '${infix.spelling}'`],
        40,
      );
    }
    const operator = consumeOperator(cursor, infix);
    if (infix.macro === undefined && infix.spelling === "=>") {
      const arrow = infixArrow(
        left,
        operator,
        infix.precedence,
        cursor,
        context,
      );
      if ("matched" in arrow) return arrow;
      left = arrow;
      continue;
    }
    if (chains(infix)) {
      const chain = parseChain(
        left,
        infix,
        operator,
        mixingFamily,
        cursor,
        context,
      );
      if ("matched" in chain) return chain;
      left = chain;
      continue;
    }
    const rightMinimum =
      infix.associativity === "right" ? infix.precedence : infix.precedence + 1;
    const macroOperand =
      infix.macro === undefined
        ? undefined
        : (literalRightOperand(cursor, infix.macro, context) ??
          (infix.macro.arrowOperand === true
            ? arrowRightOperand(cursor, infix.macro, context)
            : undefined));
    const right =
      macroOperand ??
      (infix.spelling === "as" || infix.spelling === "satisfies"
        ? parseAssertedType(cursor, context, infix.precedence)
        : parseExpression(cursor, rightMinimum, context));
    if ("matched" in right) return right;
    if (
      (mixingFamily === "logical" && right.mixingFamily === "nullish") ||
      (mixingFamily === "nullish" && right.mixingFamily === "logical")
    ) {
      return fail(
        cursor,
        context,
        ["parentheses when mixing '??' with '&&' or '||'"],
        40,
      );
    }
    const syntax =
      infix.macro?.expand({
        operator,
        left: left.syntax,
        right: right.syntax,
        context: context.consumer,
      }) ??
      protect(
        context.options,
        [left.syntax, ...operator, right.syntax],
        infix.precedence,
        coreForm("infix", infix.spelling),
      );
    if (syntax.category !== "expr") {
      throw new TypeError(
        "Macro infix operator returned non-expression syntax",
      );
    }
    left = {
      syntax,
      cursor: right.cursor,
      outerPrecedence: infix.precedence,
      unparenthesizedPrefix: false,
      mixingFamily,
      primary: false,
    };
  }
  return left;
}

/**
 * The expression at the cursor, read whole: where the cursor began reading
 * its sequence, so that a regular expression read where an operator stands
 * can be split into the division it is.
 *
 * The parser finds such a literal only once it reaches it, and the tokens it
 * splits into carry the expression on in every operand open around it:
 * `x = y as const / 2, 3 / g` reads `, 3 / g` in the outermost one. So the
 * expression is read again from here over its sequence with the literal
 * split, and where it ends is carried back to the sequence the cursor reads.
 * An expression that ends among the tokens a literal split into ends where
 * the source holds more than the one expression: reading it means reading
 * the source again, and the literal is left whole for that.
 */
function parseExpressionAt(
  cursor: SyntaxCursor,
  context: Omit<PrattContext, "start" | "unsplit">,
): ParsedExpression | ConsumerAttempt {
  const written = cursor.remainingRange().sequence;
  const unsplit = new Set<TokenSyntax>();
  let sequence = written;
  let working = cursor.fork();
  /** Each split made, in order, in the sequence it was made in. */
  const splits: {
    readonly index: number;
    readonly width: number;
    readonly literal: TokenSyntax;
  }[] = [];
  for (;;) {
    let parsed: ParsedExpression | ConsumerAttempt;
    try {
      parsed = parseExpression(working, 0, {
        ...context,
        start: cursor.index,
        unsplit,
      });
    } catch (error) {
      if (!(error instanceof DivisionRead) || error.sequence !== sequence)
        throw error;
      splits.push({
        index: error.index,
        width: error.tokens.length,
        literal: error.literal,
      });
      sequence = createSyntaxSequence([
        ...sequence.slice(0, error.index),
        ...error.tokens,
        ...sequence.slice(error.index + 1),
      ]);
      working = cursor.over(sequence);
      continue;
    }
    const end = writtenIndex(working.index, splits);
    if (!("matched" in parsed) && end.inside !== undefined) {
      unsplit.add(end.inside);
      sequence = written;
      working = cursor.fork();
      splits.length = 0;
      continue;
    }
    cursor.advance(end.at - cursor.index);
    return "matched" in parsed ? parsed : { ...parsed, cursor };
  }
}

/**
 * Where `index`, in the sequence the splits made, stands in the sequence they
 * were made from, and the literal it stands among the tokens of, if it does;
 * there it stands at the literal.
 */
function writtenIndex(
  index: number,
  splits: readonly {
    readonly index: number;
    readonly width: number;
    readonly literal: TokenSyntax;
  }[],
): { readonly at: number; readonly inside: TokenSyntax | undefined } {
  let at = index;
  let inside: TokenSyntax | undefined;
  for (let made = splits.length - 1; made >= 0; made -= 1) {
    const split = splits[made]!;
    if (at <= split.index) continue;
    if (at < split.index + split.width) {
      inside = split.literal;
      at = split.index;
    } else at -= split.width - 1;
  }
  return { at, inside };
}

class PrattExpressionConsumer implements SyntaxConsumer {
  readonly #primary: SyntaxConsumer;

  constructor(readonly options: PrattExpressionConsumerOptions) {
    // The primary consumer parses an arrow's body with this, so that a custom
    // operator written in one is dispatched as it is anywhere else. Commas are
    // not taken: a comma ends an arrow's body, as it does in a call's
    // arguments and an array literal.
    const primary: SyntaxConsumer = createPrimaryExpressionConsumer({
      ...options,
      consumeExpression: (cursor, context) => {
        const parsed = parseExpressionAt(cursor, {
          consumer: context,
          options,
          primary,
          allowComma: false,
        });
        return "matched" in parsed
          ? parsed
          : Object.freeze({
              matched: true as const,
              syntax: parsed.syntax,
              cursor: parsed.cursor,
            });
      },
    });
    this.#primary = primary;
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, consumer: ConsumerContext): ConsumerAttempt {
    const parsed = parseExpressionAt(cursor, {
      consumer,
      options: this.options,
      primary: this.#primary,
      allowComma: this.options.allowComma ?? false,
    });
    if ("matched" in parsed) return parsed;
    return Object.freeze({
      matched: true,
      syntax: parsed.syntax,
      cursor: parsed.cursor,
    });
  }
}

export function createPrattExpressionConsumer(
  options: PrattExpressionConsumerOptions,
): SyntaxConsumer {
  return Object.freeze(new PrattExpressionConsumer(options));
}
