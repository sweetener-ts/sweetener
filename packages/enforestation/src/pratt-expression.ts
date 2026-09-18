import type { BindingId } from "@sweetener/shared";
import {
  createPrecedence,
  createProtectedSyntax,
  leadingLineBreak,
  spanEnvelope,
  type ExpressionForm,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCursor,
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
import { StopSet } from "./stop-set.js";

export {
  coreExpressionOperators,
  type CoreOperator,
  type PrattAssociativity,
  type PrattFixity,
} from "./core-operators.js";
import {
  coreExpressionOperators,
  type PrattAssociativity,
  type PrattFixity,
} from "./core-operators.js";

const coreByKey = new Map(
  coreExpressionOperators.map((operator) => [
    `${operator.fixity}|${operator.spelling}`,
    operator,
  ]),
);

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
}

interface PrattContext {
  readonly consumer: ConsumerContext;
  readonly options: PrattExpressionConsumerOptions;
  readonly primary: SyntaxConsumer;
  readonly start: number;
  readonly allowComma: boolean;
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
  // `yield*` is one operator of two tokens, and the line break the grammar
  // forbids is the one between `yield` and the whole of what follows it.
  if (operator.spelling === "yield") {
    return (
      leadingLineBreak(next) ||
      (!context.consumer.allowYield && !suspendedOperandBegins(next))
    );
  }
  if (operator.spelling === "await")
    return !context.consumer.allowAwait && !suspendedOperandBegins(next);
  return false;
}

function parsePrefix(
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  checkWork(context);
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
  const prefix =
    resolved !== undefined && suspendingWordAlone(cursor, resolved, context)
      ? undefined
      : resolved;
  if (prefix !== undefined) {
    if (prefix.spelling === "yield" && !context.consumer.allowYield) {
      return fail(cursor, context, ["yield inside a generator"], 9);
    }
    if (prefix.spelling === "await" && !context.consumer.allowAwait) {
      return fail(cursor, context, ["await inside an async function"], 9);
    }
    const operator = consumeOperator(cursor, prefix);
    const right = parseExpression(cursor, prefix.precedence, context);
    if ("matched" in right) return right;
    const coreChildren =
      prefix.spelling === "new"
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
    };
  }
  const attempt = context.primary.consume(cursor, context.consumer);
  if (!attempt.matched) return attempt;
  return {
    syntax: attempt.syntax,
    cursor: attempt.cursor,
    outerPrecedence: attempt.syntax.precedence ?? 1_000,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
  };
}

function parseConditional(
  left: ParsedExpression,
  cursor: SyntaxCursor,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  const question = cursor.consume()!;
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
  const consequent = parseExpression(cursor, 0, consequentContext);
  if ("matched" in consequent) return consequent;
  const colon = cursor.peek();
  if (colon?.tag !== "token" || colon.raw !== ":") {
    return fail(cursor, context, ["':' in conditional expression"], 30);
  }
  cursor.advance();
  const alternate = parseExpression(cursor, 20, context);
  if ("matched" in alternate) return alternate;
  return {
    syntax: protect(
      context.options,
      [left.syntax, question, consequent.syntax, colon, alternate.syntax],
      30,
      "conditional",
    ),
    cursor: alternate.cursor,
    outerPrecedence: 30,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
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
  // `const` is a type only here, so the type consumer does not accept it.
  const spelling = tokenSpelling(cursor);
  if (spelling === "const") {
    const token = cursor.consume();
    if (token !== undefined)
      return {
        syntax: protect(context.options, [token], precedence),
        cursor,
        outerPrecedence: precedence,
        unparenthesizedPrefix: false,
        mixingFamily: undefined,
      };
  }
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
      syntax: protect(context.options, tokens, 1_000),
      cursor,
      outerPrecedence: 1_000,
      unparenthesizedPrefix: false,
      mixingFamily: undefined,
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
    const parsed = parseExpression(cursor, 20, {
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
    syntax: protect(context.options, [...head, body], 20, "arrow"),
    cursor,
    outerPrecedence: 20,
    unparenthesizedPrefix: false,
    mixingFamily: undefined,
  };
}

function parseExpression(
  cursor: SyntaxCursor,
  minimumPrecedence: number,
  context: PrattContext,
): ParsedExpression | ConsumerAttempt {
  const prefixed = parsePrefix(cursor, context);
  if ("matched" in prefixed) return prefixed;
  let left = prefixed;
  while (!cursor.atEnd && !context.consumer.stopSet.matches(cursor)) {
    checkWork(context);
    const spelling = tokenSpelling(cursor);
    if (spelling === "?" && 30 >= minimumPrecedence) {
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
      };
      continue;
    }
    const infix = resolveOperator(cursor, "infix", context);
    if (infix === undefined || infix.precedence < minimumPrecedence) break;
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
        : parseExpression(
            cursor,
            rightMinimum,
            // An arrow read through the infix `=>` has its parameters as the
            // operand to its left, and `async` is never part of one: an
            // operand spelled `async` is the parameter's own name, as in
            // `async => body`.
            infix.spelling === "=>"
              ? arrowBodyContext(context, false)
              : context,
          ));
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
    };
  }
  return left;
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
        const parsed = parseExpression(cursor, 0, {
          consumer: context,
          options,
          primary,
          start: cursor.index,
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
    const parsed = parseExpression(cursor, 0, {
      consumer,
      options: this.options,
      primary: this.#primary,
      start: cursor.index,
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
