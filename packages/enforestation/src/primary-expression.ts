import type { SyntaxId } from "@sweetener/shared";
import {
  angleWidth,
  createPrecedence,
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  isIdentifierToken,
  leadingLineBreak,
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
import {
  expressionContinuedBy,
  operandExpectedAfter,
} from "./core-operators.js";
import {
  consumeBalancedTypeArguments,
  typeOperandFollows,
} from "./type-class-element.js";

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
   * An arrow is taken here by measuring how far it reaches, which on its own
   * leaves its body as the tokens it was written with rather than as the
   * expression it is. A custom operator spelled in it would never be offered
   * them, so `[1, 2].map((n) => n |> double)` would keep the reading the
   * ordinary parse gives `n | > double`, while `21 |> double` beside it
   * expands. The body is parsed with this once the arrow's extent is settled,
   * so what the arrow reaches over does not change.
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

/**
 * The words that head an expression as operators and stand in it as names.
 * Each is reserved only inside the function that suspends, so `const await =
 * 1` and `const x = yield;` are both legal TypeScript outside one.
 *
 * The expression parser offers them here only where no operand of their own
 * stands beside them -- a `yield` cannot take one across a line break, and
 * outside the function that admits it either word takes only an identifier, a
 * keyword or a literal written on its line -- so the word left alone is read
 * as the name it is rather than as an operator with nothing to apply.
 */
const suspendingWords = new Set(["await", "yield"]);

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
      (syntax.kind === "keyword" &&
        // A contextual keyword is an ordinary name in an expression:
        // `from`, `of` and `type` are all common parameter names.
        (literalKeywords.has(syntax.raw) ||
          suspendingWords.has(syntax.raw) ||
          isIdentifierToken(syntax))))
  );
}

/**
 * How many nodes a template marker that stands for an expression takes:
 * `#let(name = value) { body }` or `#parameterize(name = value) { body }`.
 * The expander replaces each with the expression it builds, but an operator's
 * rule reads its operands before that happens -- the right operand of a pipe
 * can be another pipe's expansion, still holding its marker.
 */
function expressionMarkerWidth(cursor: SyntaxCursor): number | undefined {
  const marker = cursor.peek();
  if (marker?.tag !== "token") return undefined;
  const split =
    marker.raw === "#" &&
    cursor.peek(1)?.tag === "token" &&
    ["let", "parameterize"].includes((cursor.peek(1) as TokenSyntax).raw);
  if (!split && marker.raw !== "#let" && marker.raw !== "#parameterize")
    return undefined;
  const offset = split ? 2 : 1;
  const argumentsGroup = cursor.peek(offset);
  const body = cursor.peek(offset + 1);
  return argumentsGroup?.tag === "group" &&
    argumentsGroup.delimiter === "parenthesis" &&
    body?.tag === "group" &&
    body.delimiter === "brace"
    ? offset + 2
    : undefined;
}

function functionExpressionWidth(cursor: SyntaxCursor): number | undefined {
  let offset = 0;
  // `async` modifies the `function` after it only on the same line; alone on
  // its line it is an ordinary name, as it is in front of an arrow's
  // parameters.
  if (asyncModifies(cursor.peek(0), cursor.peek(1))) offset += 1;
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
    // A brace where the return type is written is an object type.
    if (
      node.tag === "group" &&
      node.delimiter === "brace" &&
      !typeOperandFollows(cursor.peek(candidate - 1))
    )
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
 * Every parenthesized arrow is measured here, not only a generic one. Left to
 * the pratt `=>` infix operator, which protects what stands to its left as an
 * expression, a plain `(x) => x` would come back with its parameter list
 * wrapped in its own parentheses and the emitted TypeScript would not parse.
 * `() => x` could not be read at all: an empty parenthesis group is not a
 * primary atom, so nothing could begin it.
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
  // `v => body` is left to the infix `=>`, which reads the body the same way.
  // `async v => body` cannot be: `async` and the name are two operands, only
  // the name stands beside the `=>`, and that route would read the `async` as
  // an operand of its own and leave the arrow behind.
  const bodyStart =
    asyncNamedArrowBodyStart(cursor) ??
    parenthesizedArrowBodyStart(cursor, context);
  if (bodyStart === undefined) return undefined;
  // A block body goes to the infix `=>` wherever that route can read it:
  // taking it here would protect a statement list as an expression, which
  // mangles it at a call site. Written in a template, a block-bodied arrow is
  // emitted wrongly by that route, and this cannot fix it without breaking the
  // call site.
  //
  // That route reads only the arrows `infixArrowReadsHead` names, so
  // `() => {}`, `<T,>(v: T) => {}` and `(v): T => {}` could not be read at
  // all: nothing could begin the expression, the statement holding the arrow
  // did not parse, and the whole statement list fell back to a raw token walk
  // where no macro beside it resolves. Those are measured here, where the
  // arrow is read from its parameters rather than from what precedes it.
  const body = cursor.peek(bodyStart);
  if (
    body?.tag === "group" &&
    body.delimiter === "brace" &&
    infixArrowReadsHead(cursor, bodyStart)
  )
    return undefined;
  const width = arrowBodyEnd(cursor, bodyStart, context);
  return width === undefined ? undefined : { width, bodyStart };
}

/**
 * Whether the infix `=>` can read the arrow whose body begins at `bodyStart`.
 *
 * That route protects what stands to the arrow's left as its parameters, so it
 * reads exactly the heads that are one operand and then `=>`: `v => …` and
 * `(v) => …`. Nothing an expression can begin with stands in front of the `=>`
 * of `() => …` or `<T,>(v: T) => …`; a return type stands between the
 * parameters and the `=>` of `(v): T => …`; and `async v => …` puts two
 * operands there, of which only the name would be taken.
 */
function infixArrowReadsHead(cursor: SyntaxCursor, bodyStart: number): boolean {
  return bodyStart === 2 && isPrimaryAtom(cursor.peek());
}

/**
 * Where an arrow function's body begins, if one begins at the cursor: the
 * offset just past its `=>`. Parameters may be a list, generic, or a single
 * name, and `async` may stand before any of them.
 */
export function arrowBodyStart(
  cursor: SyntaxCursor,
  context: ConsumerContext,
): number | undefined {
  return (
    bareNamedArrowBodyStart(cursor) ??
    asyncNamedArrowBodyStart(cursor) ??
    parenthesizedArrowBodyStart(cursor, context)
  );
}

/**
 * Whether the node at `offset` is a name and the one after it is `=>`.
 *
 * An arrow's one unparenthesized parameter is named by the rule every binder
 * is named by: any word TypeScript does not reserve. Asked for the
 * `identifier` label instead, with `async` written back in as the one
 * exception, this refused `async type => type` and the thirty-seven other
 * contextual keywords -- and a refused arrow is not read as a closure at all,
 * so its body inherited whatever function stood around it.
 */
function namedArrowFollows(cursor: SyntaxCursor, offset: number): boolean {
  const name = cursor.peek(offset);
  const arrow = cursor.peek(offset + 1);
  return (
    name?.tag === "token" &&
    isIdentifierToken(name) &&
    arrow?.tag === "token" &&
    arrow.raw === "=>"
  );
}

/**
 * Where the body of `v => …` begins, the arrow whose one parameter is a bare
 * name. `async => …` is this arrow, with a parameter named `async`.
 */
function bareNamedArrowBodyStart(cursor: SyntaxCursor): number | undefined {
  return namedArrowFollows(cursor, 0) ? 2 : undefined;
}

/** Where the body of `async v => …` begins. */
function asyncNamedArrowBodyStart(cursor: SyntaxCursor): number | undefined {
  return asyncNamedArrow(cursor.peek(), cursor.peek(1), cursor.peek(2))
    ? 3
    : undefined;
}

/**
 * Whether these three nodes head `async v =>`, the async arrow whose one
 * parameter is written without parentheses.
 *
 * `async` modifies what follows it only on the same line, and TypeScript
 * applies `[no LineTerminator here]` before the `=>` of this form alone: it
 * reads `async v` and then a syntax error under it, while `(v)\n=> v` and
 * `async (v)\n=> v` are both arrows. Both readers of an arrow ask this, so the
 * asymmetry is stated here once.
 */
export function asyncNamedArrow(
  modifier: Syntax | undefined,
  name: Syntax | undefined,
  arrow: Syntax | undefined,
): boolean {
  return (
    asyncModifies(modifier, name) &&
    name?.tag === "token" &&
    isIdentifierToken(name) &&
    arrow?.tag === "token" &&
    arrow.raw === "=>" &&
    !leadingLineBreak(arrow)
  );
}

/**
 * Whether `modifier` is an `async` that modifies `modified` rather than an
 * ordinary name standing beside it. The grammar allows no line break between
 * `async` and what it modifies, so `async` alone on its line is a name and the
 * arrow written under it is one of its own: TypeScript reads no `await` in the
 * body of `async \n v => await load()`.
 *
 * Every reader of an arrow asks this -- the one that measures an arrow from
 * its head and the one that walks a closure written as loose tokens -- so it
 * is stated here once, over the two nodes rather than over either's way of
 * reaching them.
 */
export function asyncModifies(
  modifier: Syntax | undefined,
  modified: Syntax | undefined,
): boolean {
  return (
    modifier?.tag === "token" &&
    modifier.raw === "async" &&
    !leadingLineBreak(modified)
  );
}

/** Whether the `async` at the cursor modifies the parameters after it. */
function asyncArrowModifier(cursor: SyntaxCursor): boolean {
  return asyncModifies(cursor.peek(), cursor.peek(1));
}

/**
 * Whether the arrow these nodes are is async: `async` written in front of its
 * parameters, with no line break between the two.
 *
 * The nodes arrive in either of two shapes. Measured from its head an arrow is
 * flat -- `async`, the parameters, `=>`, the body -- while read through the
 * infix `=>` it is one operand, `=>` and the body, with the parameters already
 * protected. Both are answered by the same question, because `async` is the
 * modifier only where parameters rather than the `=>` stand after it: an arrow
 * whose one parameter is itself named `async` is `async =>`, in either shape.
 */
export function asyncArrowHead(head: readonly Syntax[]): boolean {
  const after = head[1];
  if (after?.tag === "token" && after.raw === "=>") return false;
  return asyncModifies(head[0], after);
}

function parenthesizedArrowBodyStart(
  cursor: SyntaxCursor,
  context: ConsumerContext,
): number | undefined {
  let offset = 0;
  if (asyncArrowModifier(cursor)) {
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
  const after = cursor.peek(offset);
  if (after?.tag === "token" && after.raw === "=>") return offset + 1;
  // Otherwise only a return type annotation may stand between the parameters
  // and the arrow, and it begins with `:`. Looking further for any `=>` would
  // read `(1) |> f; const g = () => 1;` as an arrow whose parameter list is
  // `(1)`, reaching into the next statement for its `=>`.
  if (after?.tag !== "token" || after.raw !== ":") return undefined;
  // A `:` the surrounding parse stops at is not this arrow's: it is where
  // what holds the parameters ends, which for a conditional's consequent is
  // the conditional's own `:`. There a return type reads only under the rule
  // `returnTypeReadsInConsequent` states.
  const colon = cursor.fork();
  colon.advance(offset);
  const stops = context.stopSet.matches(colon);
  offset += 1;
  const limit = offset + 64;
  while (offset < limit) {
    const node = cursor.peek(offset);
    if (node === undefined) return undefined;
    if (node.tag === "token" && node.raw === "=>") {
      return stops &&
        !returnTypeReadsInConsequent((at) => cursor.peek(at), offset)
        ? undefined
        : offset + 1;
    }
    // Anything that cannot appear in a return type means this is not an arrow.
    // A brace can, as an object type, only where a type is written.
    if (
      node.tag === "group" &&
      node.delimiter === "brace" &&
      !typeOperandFollows(cursor.peek(offset - 1))
    )
      return undefined;
    if (node.tag === "token" && (node.raw === ";" || node.raw === "="))
      return undefined;
    offset += 1;
  }
  return undefined;
}

/**
 * Whether a return type stands between parameters and the `=>` at `arrow`,
 * where those parameters are written at the head of a conditional's
 * consequent.
 *
 * A `(x)` there may be the consequent itself, with the conditional's `:` after
 * it and an arrow in the alternate: TypeScript reads `c ? (x) : (y) => y` that
 * way. It reads a return type only where the arrow the parameters head ends at
 * the conditional's own `:`, as in `c ? (x): T => x : y`.
 *
 * TypeScript decides that by parsing the body and looking at the token after
 * it; `arrowBodyExtent` instead counts the `?` and `:` written beside the
 * body, which comes to the same reading. Both readers of an arrow ask this --
 * the one that measures an arrow from its head and the one that walks a
 * closure written as loose tokens -- so it is stated here once, over an offset
 * either can answer.
 */
export function returnTypeReadsInConsequent(
  nodeAt: (offset: number) => Syntax | undefined,
  arrow: number,
): boolean {
  return arrowBodyExtent(nodeAt, arrow + 1).conditional;
}

export interface ArrowBodyExtent {
  /** The offset just past the body. */
  readonly end: number;
  /** Whether a conditional's `:` is what ended it. */
  readonly conditional: boolean;
}

/**
 * Where a concise arrow body beginning at `from` ends, among the nodes `nodeAt`
 * reads by offset. A body is the end of an expression rather than one node:
 * taking a single node made `(x) => x + 1` parse as `((x) => x) + 1`, and the
 * `+ 1` moved outside the function.
 *
 * It ends at a `,` or `;` standing beside it, or at a `:` paired with no `?` of
 * its own -- the `:` of a conditional written around the arrow. Every group is
 * one node here, so a `?` or `:` at this level belongs to a conditional: an
 * object literal's, an annotation's and a type's are all inside a group, and
 * `??` and `?.` are each one token. Counting the `?` written beside the body
 * pairs them exactly as the grammar nests them, so `(v) => v ? 1 : 2` keeps its
 * own alternate; ending at the first `:` left `: 2` outside the arrow.
 *
 * It also ends where a line break stands in front of syntax that carries
 * nothing on, which is automatic semicolon insertion read inside an
 * expression: `const h = () => f` and the `label: g()` written under it are
 * two statements, and the body reaching past the line break swallowed the
 * label and its `:` ended the body instead.
 *
 * `stopsBefore` is where the surrounding parse ends: an arrow that is a pipe's
 * operand ends where the pipe continues. It is not asked while a conditional is
 * pending, because a pending `?` puts the body inside a consequent that runs to
 * its own `:` -- which is the very boundary the surrounding parse would report
 * when the arrow is itself a conditional's consequent. Neither is the line
 * break, for the same reason: a `?` still awaiting its `:` is an expression
 * nothing can end.
 *
 * Both readers of an arrow ask this, one over a cursor and one over an array,
 * so it is stated here once, over an offset either can answer.
 */
export function arrowBodyExtent(
  nodeAt: (offset: number) => Syntax | undefined,
  from: number,
  stopsBefore: (offset: number) => boolean = () => false,
): ArrowBodyExtent {
  let conditionals = 0;
  for (let offset = from; ; offset += 1) {
    const node = nodeAt(offset);
    if (node === undefined) return { end: offset, conditional: false };
    if (offset > from && conditionals === 0) {
      if (stopsBefore(offset)) return { end: offset, conditional: false };
      if (endsAtLineBreak(nodeAt, offset))
        return { end: offset, conditional: false };
    }
    if (node.tag !== "token") continue;
    if (node.raw === "?") conditionals += 1;
    else if (node.raw === ":") {
      if (conditionals === 0) return { end: offset, conditional: true };
      conditionals -= 1;
    } else if (node.raw === "," || node.raw === ";")
      return { end: offset, conditional: false };
  }
}

/**
 * Whether the expression being scanned ends before the node at `offset`: a
 * line break stands in front of it, what stands behind it expects no operand,
 * and it carries nothing on.
 */
function endsAtLineBreak(
  nodeAt: (offset: number) => Syntax | undefined,
  offset: number,
): boolean {
  const node = nodeAt(offset);
  if (node === undefined || !leadingLineBreak(node)) return false;
  const previous = nodeAt(offset - 1);
  if (previous?.tag === "token" && operandExpectedAfter.has(previous.raw))
    return false;
  return !continuesExpression(node);
}

/**
 * Whether `node`, standing after a whole operand, carries the expression on:
 * an operator that takes it as its left operand, or the parentheses, brackets
 * or template of a call, an index or a tagged template.
 *
 * A brace is none of those. `const h = () => f` and the `{ }` written under it
 * are an arrow and a block, and reading the brace as an object literal's put
 * the whole of the rest of the file inside the arrow.
 */
function continuesExpression(node: Syntax): boolean {
  if (node.tag === "group")
    return (
      node.delimiter === "parenthesis" ||
      node.delimiter === "bracket" ||
      node.delimiter === "template"
    );
  if (node.tag !== "token") return false;
  return (
    node.kind === "no-substitution-template" ||
    expressionContinuedBy.has(node.raw)
  );
}

/** Where the body of the arrow at the cursor ends, or undefined where it is empty. */
function arrowBodyEnd(
  cursor: SyntaxCursor,
  bodyStart: number,
  context: ConsumerContext,
): number | undefined {
  const at = cursor.fork();
  const origin = at.mark();
  const { end } = arrowBodyExtent(
    (offset) => cursor.peek(offset),
    bodyStart,
    (offset) => {
      at.reset(origin);
      at.advance(offset);
      return context.stopSet.matches(at);
    },
  );
  return end === bodyStart ? undefined : end;
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

/**
 * The words that begin an expression although they are reserved: every one
 * TypeScript lists as the head of a left-hand-side expression or of a unary
 * one. Every word it does not reserve begins an expression too, as the name it
 * is.
 */
const expressionHeadWords = new Set([
  "await",
  "class",
  "delete",
  "false",
  "function",
  "import",
  "new",
  "null",
  "super",
  "this",
  "true",
  "typeof",
  "void",
  "yield",
]);

/**
 * The punctuation an expression begins with: the prefix operators, the `@` of
 * a decorated class expression, and the `<` of a type assertion.
 */
const expressionHeadPunctuation = new Set([
  "!",
  "+",
  "++",
  "-",
  "--",
  "~",
  "@",
  "<",
]);

/** Whether an expression can begin at `syntax`. */
function beginsExpression(syntax: Syntax): boolean {
  if (syntax.tag !== "token") return true;
  if (syntax.kind === "keyword")
    return expressionHeadWords.has(syntax.raw) || isIdentifierToken(syntax);
  if (syntax.kind === "punctuation")
    return expressionHeadPunctuation.has(syntax.raw);
  return syntax.kind !== "end-of-file" && syntax.kind !== "unknown";
}

/**
 * Whether a call or a tagged template stands after a `<...>` that has closed,
 * so that the angles hold the type arguments of that call.
 */
function callFollowsTypeArguments(following: Syntax | undefined): boolean {
  if (following === undefined) return false;
  if (following.tag === "group")
    return (
      following.delimiter === "parenthesis" ||
      following.delimiter === "template"
    );
  return (
    following.tag === "token" && following.kind === "no-substitution-template"
  );
}

/**
 * Whether a `<...>` that has closed holds type arguments rather than being a
 * pair of comparisons, `following` being what stands after it and no call
 * standing there.
 *
 * This is where an instantiation expression is told from `a < b > c`, and the
 * rule is TypeScript's: a `<` after a type argument list never makes sense and
 * a `>` is ambiguous with a re-scanned `>>`, so both disqualify it, and so do
 * `+` and `-`, which read as arithmetic on the comparison. Otherwise the
 * angles hold type arguments wherever a line break, a binary operator, or
 * something that cannot begin an operand follows them.
 */
function typeArgumentsFollow(following: Syntax | undefined): boolean {
  if (following === undefined) return true;
  const spelling = following.tag === "token" ? following.raw : undefined;
  if (spelling !== undefined) {
    if (
      angleWidth(spelling, "<") > 0 ||
      angleWidth(spelling, ">") > 0 ||
      spelling === "+" ||
      spelling === "-"
    )
      return false;
    if (expressionContinuedBy.has(spelling)) return true;
  }
  return leadingLineBreak(following) || !beginsExpression(following);
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
    if (typeArguments !== undefined) {
      if (callFollowsTypeArguments(following)) {
        cursor.advance(typeArguments.width + 1);
        return undefined;
      }
      // An instantiation expression: a generic value with its type arguments
      // supplied and no call after them. The type arguments are taken and the
      // operand read on from, so `const f = y<string>;` reads as the
      // declaration TypeScript reads rather than being refused.
      if (typeArgumentsFollow(following)) {
        cursor.advance(typeArguments.width);
        return undefined;
      }
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
    // An arrow is never a generator, so `yield` is not an expression in its
    // body even inside one; `await` is one there only when the arrow itself
    // is written `async`.
    Object.freeze({
      ...context,
      allowYield: false,
      allowAwait: asyncArrowHead(raw.slice(0, arrow.bodyStart)),
    }),
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
      // on its own would leave `.every(check)` for a caller with nowhere to put
      // it, and the expansion would be reported as not being one expression.
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
    const markerWidth = expressionMarkerWidth(cursor);
    const classWidth = classExpressionWidth(cursor);
    const arrow = arrowWidth(cursor, context);
    // A macro may be named by punctuation that begins no ordinary operand --
    // a syntax parameter spelled `%` stands where an operand does. Only the
    // macro's own extent says it is one; the tokens it takes are left for the
    // expander, and what follows is read as postfix as it is for any operand.
    const macroOperand =
      functionWidth === undefined &&
      markerWidth === undefined &&
      classWidth === undefined &&
      arrow === undefined &&
      !isPrimaryAtom(cursor.peek()) &&
      macroAttempt?.matched === true &&
      macroAttempt.cursor.index > cursor.index
        ? macroAttempt.cursor.index - cursor.index
        : undefined;
    if (
      functionWidth === undefined &&
      markerWidth === undefined &&
      classWidth === undefined &&
      arrow === undefined &&
      macroOperand === undefined &&
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
    cursor.advance(
      functionWidth ??
        markerWidth ??
        classWidth ??
        arrow?.width ??
        macroOperand ??
        1,
    );
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
    const wholeArrow =
      arrow !== undefined && cursor.index === start + arrow.width;
    const consumed = wholeArrow
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
        form: wholeArrow ? "arrow" : undefined,
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
