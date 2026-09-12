import type { SyntaxId } from "@sweetener/shared";
import {
  createPrecedence,
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  spanEnvelope,
  type OriginStore,
  type Precedence,
  type Syntax,
  type SyntaxCursor,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  createConsumerFailure,
  type ConsumerAttempt,
  type ConsumerContext,
  type MacroExtentResolver,
  type SyntaxConsumer,
} from "./consumer.js";
import { consumeBalancedTypeArguments } from "./type-class-element.js";

export const primaryExpressionPrecedence: Precedence = createPrecedence(1_000);

export interface PrimaryExpressionConsumerOptions {
  readonly allocateSyntaxId: () => SyntaxId;
  readonly origins: OriginStore;
  /**
   * Offers a macro invocation whose extent reaches past the expression the
   * ordinary parse would take — `match (x) { ... }` claims the trailing block,
   * where a call expression would stop at the parentheses and leave the block
   * behind as a separate statement. Consulted only to extend a parse, never to
   * replace one that already covers the same syntax.
   */
  readonly resolveMacro?: MacroExtentResolver | undefined;
  /**
   * Parses an expression standing on its own.
   *
   * An arrow is taken here by measuring how far it reaches, which left its body
   * as the tokens it was written with rather than as the expression it is. A
   * custom operator spelled in it was never offered them, so
   * `[1, 2].map((n) => n |> double)` kept the reading the ordinary parse gives
   * `n | > double`, while `21 |> double` beside it expanded. The body is
   * parsed with this once the arrow's extent is settled, so what the arrow
   * reaches over does not change.
   */
  readonly consumeExpression?:
    | ((cursor: SyntaxCursor, context: ConsumerContext) => ConsumerAttempt)
    | undefined;
}

const literalKinds = new Set<TokenSyntax["kind"]>([
  "identifier",
  "private-identifier",
  "numeric-literal",
  "bigint-literal",
  "string-literal",
  "regular-expression-literal",
  "no-substitution-template",
]);

const literalKeywords = new Set([
  "this",
  "super",
  "null",
  "undefined",
  "true",
  "false",
  "async",
  "import",
  "new",
]);

function isPrimaryAtom(syntax: Syntax | undefined): boolean {
  if (syntax?.tag === "protected") return syntax.category === "expr";
  if (syntax?.tag === "group") {
    if (syntax.delimiter === "parenthesis") return syntax.children.length > 0;
    return (
      syntax.delimiter === "bracket" ||
      syntax.delimiter === "brace" ||
      syntax.delimiter === "template" ||
      syntax.delimiter === "jsx-element" ||
      syntax.delimiter === "jsx-fragment"
    );
  }
  return (
    syntax?.tag === "token" &&
    (literalKinds.has(syntax.kind) ||
      (syntax.kind === "keyword" && literalKeywords.has(syntax.raw)))
  );
}

function functionExpressionWidth(cursor: SyntaxCursor): number | undefined {
  let offset = 0;
  const first = cursor.peek(offset);
  if (first?.tag === "token" && first.raw === "async") offset += 1;
  const keyword = cursor.peek(offset);
  if (keyword?.tag !== "token" || keyword.raw !== "function") return undefined;
  offset += 1;
  const star = cursor.peek(offset);
  if (star?.tag === "token" && star.raw === "*") offset += 1;
  let parametersOffset: number | undefined;
  for (let candidate = offset; candidate < offset + 32; candidate += 1) {
    const node = cursor.peek(candidate);
    if (node === undefined) return undefined;
    if (node.tag === "group" && node.delimiter === "parenthesis") {
      parametersOffset = candidate;
      break;
    }
  }
  if (parametersOffset === undefined) return undefined;
  for (
    let candidate = parametersOffset + 1;
    candidate < parametersOffset + 33;
    candidate += 1
  ) {
    const node = cursor.peek(candidate);
    if (node === undefined) return undefined;
    if (node.tag === "group" && node.delimiter === "brace")
      return candidate + 1;
  }
  return undefined;
}

function classExpressionWidth(cursor: SyntaxCursor): number | undefined {
  const first = cursor.peek();
  if (first?.tag !== "token" || first.raw !== "class") return undefined;
  for (let candidate = 1; candidate < 33; candidate += 1) {
    const node = cursor.peek(candidate);
    if (node === undefined) return undefined;
    if (node.tag === "group" && node.delimiter === "brace")
      return candidate + 1;
  }
  return undefined;
}

/**
 * How wide an arrow function is, from `(` or `async` or `<` to its body.
 *
 * Only generic arrows were recognised here. A plain `(x) => x` fell through to
 * the pratt `=>` infix operator, which protects what stands to its left as an
 * expression — so a parameter list came back wrapped in its own parentheses and
 * the emitted TypeScript did not parse. `() => x` was worse: an empty
 * parenthesis group is not a primary atom, so nothing could begin it at all.
 */
interface ArrowExtent {
  readonly width: number;
  /** Offset of the first node after `=>`. */
  readonly bodyStart: number;
}

function arrowWidth(
  cursor: SyntaxCursor,
  context: ConsumerContext,
): ArrowExtent | undefined {
  let offset = 0;
  const head = cursor.peek();
  if (head?.tag === "token" && head.raw === "async") {
    const after = cursor.peek(1);
    // `async` alone is an ordinary identifier; only a parameter list or type
    // parameters after it begin an arrow.
    if (
      !(after?.tag === "group" && after.delimiter === "parenthesis") &&
      !(after?.tag === "token" && after.raw === "<")
    )
      return undefined;
    offset = 1;
  }
  const rest = cursor.fork();
  rest.advance(offset);
  const typeParameters = consumeBalancedTypeArguments(rest, context);
  if (typeParameters !== undefined) offset += typeParameters.width;
  const parameters = cursor.peek(offset);
  if (parameters?.tag !== "group" || parameters.delimiter !== "parenthesis")
    return undefined;
  offset += 1;
  // A return type annotation may stand between the parameters and the arrow.
  const limit = offset + 64;
  while (offset < limit) {
    const node = cursor.peek(offset);
    if (node === undefined) return undefined;
    if (node.tag === "token" && node.raw === "=>") {
      // Only a concise body. Those did not parse here at all, and fell to the
      // infix `=>`, which protects what is left of it as an expression and
      // emitted a parameter list wrapped in its own parentheses. A block body
      // still goes that way: taking it here protects a statement list as an
      // expression, which mangles it at a call site. Written in a template, a
      // block-bodied arrow is still emitted wrongly — that is unchanged, and
      // not something this can fix without breaking the call site.
      const body = cursor.peek(offset + 1);
      if (body?.tag === "group" && body.delimiter === "brace") return undefined;
      const width = arrowBodyEnd(cursor, offset + 1);
      return width === undefined ? undefined : { width, bodyStart: offset + 1 };
    }
    // Anything that cannot appear in a return type means this is not an arrow.
    if (node.tag === "group" && node.delimiter === "brace") return undefined;
    offset += 1;
  }
  return undefined;
}

/**
 * Where an arrow's body ends, which is the end of an expression rather than
 * one node. Taking a single node made `(x) => x + 1` parse as
 * `((x) => x) + 1`, and the `+ 1` moved outside the function.
 */
function arrowBodyEnd(
  cursor: SyntaxCursor,
  bodyStart: number,
): number | undefined {
  if (cursor.peek(bodyStart) === undefined) return undefined;
  let offset = bodyStart;
  while (true) {
    const node = cursor.peek(offset);
    if (node === undefined) break;
    // Groups are already balanced, so only a separator at this level ends it.
    if (
      node.tag === "token" &&
      (node.raw === "," || node.raw === ";" || node.raw === ":")
    )
      break;
    offset += 1;
  }
  return offset === bodyStart ? undefined : offset;
}

function isPropertyName(syntax: Syntax | undefined): boolean {
  return (
    syntax?.tag === "token" &&
    (syntax.kind === "identifier" ||
      syntax.kind === "private-identifier" ||
      syntax.kind === "keyword")
  );
}

function isPunctuation(syntax: Syntax | undefined, raw: string): boolean {
  return (
    syntax?.tag === "token" &&
    syntax.kind === "punctuation" &&
    syntax.raw === raw
  );
}

function failure(
  cursor: SyntaxCursor,
  start: number,
  expectations: readonly string[],
  specificity: number,
): ConsumerAttempt {
  return Object.freeze({
    matched: false,
    failure: createConsumerFailure({
      category: "expr",
      cursor: cursor.identity,
      progress: cursor.index - start,
      specificity,
      expectations,
    }),
  });
}

function outputOrigin(origins: OriginStore, syntax: readonly Syntax[]) {
  const unique = [...new Set(syntax.map((node) => node.origin))];
  return unique.length === 1 ? unique[0]! : origins.composed(unique);
}

function consumePostfix(
  cursor: SyntaxCursor,
  context: ConsumerContext,
  start: number,
  optionalChain: boolean,
): ConsumerAttempt | undefined {
  const next = cursor.peek();
  if (context.stopSet.matches(cursor) || next === undefined) return undefined;
  if (isPunctuation(next, ".")) {
    cursor.advance();
    if (!isPropertyName(cursor.peek())) {
      return failure(cursor, start, ["property name after '.'"], 20);
    }
    cursor.advance();
    return undefined;
  }
  if (isPunctuation(next, "?.")) {
    cursor.advance();
    const target = cursor.peek();
    if (
      isPropertyName(target) ||
      (target?.tag === "group" &&
        (target.delimiter === "parenthesis" ||
          (target.delimiter === "bracket" && target.children.length > 0)))
    ) {
      cursor.advance();
      return undefined;
    }
    return failure(cursor, start, ["property, index, or call after '?.'"], 20);
  }
  if (next.tag === "group" && next.delimiter === "bracket") {
    if (next.children.length === 0) {
      cursor.advance();
      return failure(cursor, start, ["expression inside index access"], 20);
    }
    cursor.advance();
    return undefined;
  }
  if (isPunctuation(next, "<")) {
    const typeArguments = consumeBalancedTypeArguments(cursor, context);
    const following =
      typeArguments === undefined
        ? undefined
        : cursor.peek(typeArguments.width);
    if (
      typeArguments !== undefined &&
      following?.tag === "group" &&
      (following.delimiter === "parenthesis" ||
        following.delimiter === "template")
    ) {
      cursor.advance(typeArguments.width + 1);
      return undefined;
    }
  }
  if (
    next.tag === "group" &&
    (next.delimiter === "parenthesis" || next.delimiter === "template")
  ) {
    if (next.delimiter === "template" && optionalChain) {
      return failure(
        cursor,
        start,
        ["tagged template outside an optional chain"],
        20,
      );
    }
    cursor.advance();
    return undefined;
  }
  if (isPunctuation(next, "!")) {
    cursor.advance();
    return undefined;
  }
  if (next.tag === "token" && next.kind === "no-substitution-template") {
    if (optionalChain) {
      return failure(
        cursor,
        start,
        ["tagged template outside an optional chain"],
        20,
      );
    }
    cursor.advance();
    return undefined;
  }
  return undefined;
}

/**
 * An arrow's nodes with its body parsed, or the nodes as they were when it
 * cannot be. Falling back keeps a body this cannot read printed as written.
 */
function arrowChildren(
  raw: readonly Syntax[],
  arrow: ArrowExtent,
  options: PrimaryExpressionConsumerOptions,
  context: ConsumerContext,
): readonly Syntax[] {
  const consumeExpression = options.consumeExpression;
  const body = raw.slice(arrow.bodyStart);
  if (consumeExpression === undefined || body.length < 2) return raw;
  const attempt = consumeExpression(
    createSyntaxCursor(createSyntaxSequence(body)),
    context,
  );
  if (!attempt.matched || !attempt.cursor.atEnd) return raw;
  return [...raw.slice(0, arrow.bodyStart), attempt.syntax];
}

class PrimaryExpressionConsumer implements SyntaxConsumer {
  constructor(readonly options: PrimaryExpressionConsumerOptions) {
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    const protectedExpression = cursor.peek();
    if (
      protectedExpression?.tag === "protected" &&
      protectedExpression.category === "expr"
    ) {
      cursor.advance();
      // A protected expression is a complete operand, but what stands after it
      // may still be postfix. A template writing `$value.every(check)` splices
      // a captured expression here and then reads a member off it, and a
      // capture of more than one node arrives protected. Returning the operand
      // on its own left `.every(check)` for a caller with nowhere to put it,
      // and the expansion was reported as not being one expression.
      let chained = false;
      while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
        const before = cursor.index;
        const beginsOptional = isPunctuation(cursor.peek(), "?.");
        const failed = consumePostfix(cursor, context, start, chained);
        if (failed !== undefined) return failed;
        if (cursor.index === before) break;
        if (beginsOptional) chained = true;
      }
      if (cursor.index === start + 1)
        return Object.freeze({
          matched: true,
          syntax: protectedExpression,
          cursor,
        });
      const consumed = cursor
        .fork()
        .remainingRange()
        .sequence.slice(start, cursor.index);
      return Object.freeze({
        matched: true,
        syntax: createProtectedSyntax({
          id: this.options.allocateSyntaxId(),
          span: spanEnvelope(consumed.map(({ span }) => span)),
          origin: outputOrigin(this.options.origins, consumed),
          scopes: protectedExpression.scopes,
          category: "expr",
          precedence: primaryExpressionPrecedence,
          children: consumed,
        }),
        cursor,
      });
    }
    // Asked before the parse moves, so the fork still sits at the head; the
    // answer is only used if it reaches past what the parse takes.
    const macroAttempt = this.options.resolveMacro?.(
      "expr",
      cursor.fork(),
      context,
    );
    const functionWidth = functionExpressionWidth(cursor);
    const classWidth = classExpressionWidth(cursor);
    const arrow = arrowWidth(cursor, context);
    if (
      functionWidth === undefined &&
      classWidth === undefined &&
      arrow === undefined &&
      !isPrimaryAtom(cursor.peek())
    ) {
      return failure(
        cursor,
        start,
        [
          "identifier, literal, function, array, object, template, or parenthesized expression",
        ],
        1,
      );
    }
    cursor.advance(functionWidth ?? classWidth ?? arrow?.width ?? 1);
    // Postfix parsing runs first so the macro extent is compared against the
    // whole expression, not just its head.
    let optionalChain = false;
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      const before = cursor.index;
      const beginsOptional = isPunctuation(cursor.peek(), "?.");
      const failed = consumePostfix(cursor, context, start, optionalChain);
      if (failed !== undefined) return failed;
      if (cursor.index === before) break;
      if (beginsOptional) optionalChain = true;
    }
    if (
      macroAttempt?.matched === true &&
      macroAttempt.cursor.index > cursor.index
    ) {
      if (macroAttempt.syntax.category !== "expr") {
        throw new TypeError("Macro expr resolver returned a non-expression");
      }
      cursor.advance(macroAttempt.cursor.index - cursor.index);
      return Object.freeze({
        matched: true,
        syntax: macroAttempt.syntax,
        cursor,
      });
    }
    const raw = cursor
      .fork()
      .remainingRange()
      .sequence.slice(start, cursor.index);
    // Only when the arrow is the whole of what was taken: anything postfix
    // reached past its body, and the slice would no longer line up.
    const consumed =
      arrow !== undefined && cursor.index === start + arrow.width
        ? arrowChildren(raw, arrow, this.options, context)
        : raw;
    const first = consumed[0]!;
    return Object.freeze({
      matched: true,
      syntax: createProtectedSyntax({
        id: this.options.allocateSyntaxId(),
        span: spanEnvelope(consumed.map(({ span }) => span)),
        origin: outputOrigin(this.options.origins, consumed),
        scopes: first.scopes,
        category: "expr",
        precedence: primaryExpressionPrecedence,
        children: consumed,
      }),
      cursor,
    });
  }
}

export function createPrimaryExpressionConsumer(
  options: PrimaryExpressionConsumerOptions,
): SyntaxConsumer {
  return Object.freeze(new PrimaryExpressionConsumer(options));
}
