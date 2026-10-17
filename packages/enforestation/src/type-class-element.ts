import type { SyntaxId } from "@sweetener/shared";
import {
  createGroup,
  createProtectedSyntax,
  createSyntaxCursor,
  angleWidth,
  createSyntaxSequence,
  isIdentifierToken,
  isPropertyNameToken,
  leadingLineBreak,
  operandExpectedAfter,
  spanEnvelope,
  type GroupSyntax,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCursor,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  createConsumerFailure,
  type ConsumerAttempt,
  type ConsumerContext,
  type SyntaxConsumer,
} from "./consumer.js";
import { asyncModifies } from "./primary-expression.js";
import { StopSet } from "./stop-set.js";

export type TypeClassMacroResolver = (
  category: "type" | "classElement" | "typeMember",
  cursor: SyntaxCursor,
  context: ConsumerContext,
) => ConsumerAttempt | undefined;

/**
 * What the member consumer needs of a resolver: it only ever asks about the
 * one category it reads. Keeping this narrower than TypeClassMacroResolver
 * lets the statement/item extent resolver, which also answers for
 * `typeMember`, be passed straight through.
 */
export type TypeMemberMacroResolver = (
  category: "typeMember",
  cursor: SyntaxCursor,
  context: ConsumerContext,
) => ConsumerAttempt | undefined;

export type TypeClassElementMacroResolver = TypeClassMacroResolver;

export interface TypeClassConsumerOptions {
  readonly allocateSyntaxId: () => SyntaxId;
  readonly origins: OriginStore;
  readonly resolveMacro?: TypeClassMacroResolver | undefined;
  /**
   * Claims a member macro's extent. The member consumer asks this rather than
   * `resolveMacro` so the statement/item extent resolver, which answers for
   * `typeMember` too, can be handed straight to it.
   */
  readonly resolveTypeMemberMacro?: TypeMemberMacroResolver | undefined;
  /**
   * Enforests a class element's brace body as a statement list. Without it the
   * body stays an opaque token tree and macros inside a method never expand.
   */
  readonly enforestStatementBlock?:
    | ((
        block: GroupSyntax,
        context: ConsumerContext,
        allowYield: boolean,
        allowAwait: boolean,
      ) => Syntax)
    | undefined;
  /**
   * Reads a class field's initializer, the expression after its `=`. Without
   * it the initializer is scanned as tokens, which cannot tell where an
   * expression ends: `x = a as B` and the `[k] = 1;` under it are two fields,
   * because nothing but a binary operator carries an expression on past the
   * type an `as` asserts.
   */
  readonly consumeInitializer?: SyntaxConsumer | undefined;
  /**
   * Enforests a brace body as a list of type members. Without it an object
   * type stays an opaque token tree and a member macro written in one never
   * expands.
   */
  readonly enforestTypeMemberBody?:
    ((body: GroupSyntax, context: ConsumerContext) => Syntax) | undefined;
}

const prefixTypeWords = new Set([
  "abstract",
  "asserts",
  "infer",
  "keyof",
  "new",
  "readonly",
  "typeof",
  "unique",
]);

const typeAtoms = new Set([
  "any",
  "bigint",
  "boolean",
  "false",
  "import",
  "never",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "this",
  "true",
  "undefined",
  "unknown",
  "void",
]);

const continuationOperators = new Set(["&", "extends", "is", "|"]);
const parameterFollowers = new Set([":", ",", "?", "?:", "="]);
const hardTypeStops = new Set([",", ";", "="]);
const classModifiers = new Set([
  "abstract",
  "accessor",
  "declare",
  "override",
  "private",
  "protected",
  "public",
  "readonly",
  "static",
]);

function token(
  syntax: Syntax | undefined,
  raw?: string,
): syntax is TokenSyntax {
  return syntax?.tag === "token" && (raw === undefined || syntax.raw === raw);
}

function checkWork(context: ConsumerContext): void {
  context.cancellation.throwIfCancellationRequested();
  context.tracker.checkDeadline();
  context.tracker.chargeMatcherSteps();
}

function originFor(origins: OriginStore, children: readonly Syntax[]) {
  const unique = [...new Set(children.map(({ origin }) => origin))];
  return unique.length === 1 ? unique[0]! : origins.composed(unique);
}

function protect(
  category: "type" | "classElement" | "typeMember",
  options: TypeClassConsumerOptions,
  children: readonly Syntax[],
): ProtectedSyntax {
  const first = children[0];
  if (first === undefined)
    throw new RangeError(`Cannot protect an empty ${category}`);
  return createProtectedSyntax({
    id: options.allocateSyntaxId(),
    span: spanEnvelope(children.map(({ span }) => span)),
    origin: originFor(options.origins, children),
    scopes: first.scopes,
    category,
    children,
  });
}

function failure(
  category: "type" | "classElement" | "typeMember",
  cursor: SyntaxCursor,
  start: number,
  expectations: readonly string[],
  specificity: number,
): ConsumerAttempt {
  return Object.freeze({
    matched: false,
    failure: createConsumerFailure({
      category,
      cursor: cursor.identity,
      progress: cursor.index - start,
      specificity,
      expectations,
    }),
  });
}

/**
 * Takes a macro's extent, leaving `cursor` just past it.
 *
 * A macro is measured on a fork and answers with that fork, while every other
 * reading answers with the cursor it was given, advanced. A caller that reads
 * on from the cursor it passed down would otherwise stand at the invocation
 * still and read it a second time.
 */
function validateMacro(
  attempt: ConsumerAttempt,
  category: "type" | "classElement" | "typeMember",
  cursor: SyntaxCursor,
  start: number,
): ConsumerAttempt {
  if (
    attempt.matched &&
    (attempt.syntax.category !== category || attempt.cursor.index <= start)
  ) {
    throw new TypeError(
      `Macro resolver returned an invalid ${category} extent`,
    );
  }
  if (!attempt.matched || attempt.cursor === cursor) return attempt;
  if (attempt.cursor.index < cursor.index) {
    throw new TypeError(
      `Macro resolver returned a ${category} extent behind the cursor`,
    );
  }
  cursor.advance(attempt.cursor.index - cursor.index);
  return Object.freeze({ ...attempt, cursor });
}

/**
 * Reads one balanced TypeScript angle-delimited region without committing the
 * caller's cursor on failure. Expressions use this to distinguish a generic
 * call such as `useState<number>(0)` from relational operators.
 */
export function consumeBalancedTypeArguments(
  cursor: SyntaxCursor,
  context: ConsumerContext,
) {
  const working = cursor.fork();
  const children: Syntax[] = [];
  const first = working.peek();
  if (!token(first) || angleWidth(first.raw, "<") === 0) return undefined;
  if (!consumeAngles(working, context, children)) return undefined;
  return Object.freeze({
    syntax: createSyntaxSequence(children),
    width: working.index - cursor.index,
  });
}

/**
 * Tokens no angle-delimited list of types holds outside a group of its own,
 * where a `<` that opened one is a comparison after all: `a < b;` and
 * `a < b && c > d`. Read on to the next `>` instead, a comparison scanned
 * every statement after it, and a block of many ran out of steps.
 */
const typeListEndsBefore = new Set([
  ";",
  "&&",
  "||",
  "??",
  "==",
  "===",
  "!=",
  "!==",
]);

/**
 * Reads an angle-delimited list of types, to the `>` that closes it.
 *
 * Outside a group of its own, such a list holds a `:` only as the one of a
 * conditional type, after the `extends` and the `?` that begin it, and a `:`
 * anywhere else ends a comparison's operand: `{ f: v < 1, x, g: v > (2) }`
 * is three properties, where reading on to the `>` read `x` as a type.
 */
function consumeAngles(
  cursor: SyntaxCursor,
  context: ConsumerContext,
  children: Syntax[],
): boolean {
  const { closed, width } = scanAngles(
    (offset) => cursor.peek(offset),
    () => checkWork(context),
  );
  for (let taken = 0; taken < width; taken += 1)
    children.push(cursor.consume()!);
  return closed;
}

/**
 * How many of `nodes` from `at` the angle-delimited list of types opened
 * there spans, as `consumeAngles` reads it; undefined where it does not
 * close. For a reader that has a run of syntax rather than a cursor.
 */
export function anglesWidthAt(
  nodes: readonly Syntax[],
  at: number,
): number | undefined {
  return anglesWidthFrom((offset) => nodes[at + offset]);
}

/** `anglesWidthAt`, over the nodes `peek` gives from the `<` on. */
export function anglesWidthFrom(
  peek: (offset: number) => Syntax | undefined,
): number | undefined {
  const { closed, width } = scanAngles(peek, () => undefined);
  return closed ? width : undefined;
}

/**
 * The scan `consumeAngles` makes, over the nodes `peek` gives from the `<`
 * on: whether the list closed, and how many nodes it read, up to and
 * including the one that closed it or that said it was no list.
 */
function scanAngles(
  peek: (offset: number) => Syntax | undefined,
  work: () => void,
): { readonly closed: boolean; readonly width: number } {
  let depth = 0;
  // Conditional types begun with `extends` and not yet given their `?`, and
  // those given one and awaiting their `:`.
  let awaitingQuestion = 0;
  let awaitingColon = 0;
  for (let offset = 0; ; offset += 1) {
    work();
    const next = peek(offset);
    if (next === undefined) return { closed: false, width: offset };
    if (!token(next)) continue;
    const width = offset + 1;
    if (typeListEndsBefore.has(next.raw)) return { closed: false, width };
    if (next.raw === "extends") awaitingQuestion += 1;
    else if (next.raw === "?" && awaitingQuestion > 0) {
      awaitingQuestion -= 1;
      awaitingColon += 1;
    } else if (next.raw === ":") {
      if (awaitingColon === 0) return { closed: false, width };
      awaitingColon -= 1;
    }
    depth += angleWidth(next.raw, "<");
    depth -= angleWidth(next.raw, ">");
    if (depth === 0) return { closed: true, width };
    if (depth < 0) return { closed: false, width };
  }
}

/**
 * Whether `node` may begin a parameter: a name -- in any script, `π` as
 * readily as `x` -- or `this`, or the brace or bracket of a destructuring
 * pattern. A capture spliced in is asked of what it holds: a binding begins
 * one, and a capture of one node is that node. Nothing else begins a
 * parameter, so a group opening with anything else is a parenthesized type.
 */
function beginsParameter(node: Syntax): boolean {
  switch (node.tag) {
    case "token":
      return isIdentifierToken(node) || node.raw === "this";
    case "group":
      return node.delimiter === "brace" || node.delimiter === "bracket";
    case "protected":
      if (node.category === "binding") return true;
      return node.children.length === 1 && beginsParameter(node.children[0]!);
    case "root":
      return false;
  }
}

/**
 * A parenthesis standing where a type is expected is either a parenthesized
 * type or the parameter list of a function type, and only a parameter list may
 * be followed by `=>`. This follows TypeScript's own reading: an empty list, a
 * rest parameter, or a name followed by `:`, `,`, `?`, or `=` can only be
 * parameters; a lone name is either one, decided by whether `=>` follows. The
 * expander asks the same of a parenthesis it walks where a type is written.
 */
export function readTypeParenthesis(
  group: GroupSyntax,
): "parameters" | "either" | "type" {
  const [first, second] = group.children;
  if (first === undefined) return "parameters";
  if (first.tag === "token" && first.raw === "...") return "parameters";
  if (!beginsParameter(first)) return "type";
  if (second === undefined) return "either";
  return token(second) && parameterFollowers.has(second.raw)
    ? "parameters"
    : "type";
}

class TypeConsumer implements SyntaxConsumer {
  constructor(readonly options: TypeClassConsumerOptions) {
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    const children: Syntax[] = [];
    let expectingOperand = true;
    let conditionalDepth = 0;
    /**
     * How many `extends` of a conditional type were read at this level and
     * wait for their `?`. Only a conditional's `?` carries a type on: one with
     * none waiting -- a tuple's optional element, or the conditional around a
     * type captured from its `extends` on -- ends the type, where reading it
     * as the start of a conditional of its own swallowed `? A : B` into
     * `nullable string`.
     */
    let awaitingQuestion = 0;
    let genericFunctionHead = false;
    let invalidAdjacency = false;
    // Whether the parameter list just read must, or may, be followed by `=>`.
    // One that must is not yet a type, so a caller's stop cannot end it there.
    let arrow: "none" | "allowed" | "required" = "none";
    // What a line break ends is the type grammar's to say, and the tracker
    // every scanning walk asks says it here too: `A` and the `[k]` under it
    // are no array type, nor `A` and the `<B>` under it a generic one.
    const type = createTypeTracker(undefined, false);
    let tracked = 0;

    while (!cursor.atEnd) {
      checkWork(context);
      if (
        children.length > 0 &&
        conditionalDepth === 0 &&
        arrow !== "required" &&
        (context.stopSet.matches(cursor) ||
          // An operator macro after the type asserted in an expression ends
          // it: `x as number <+> y` asserts `number`, and does not give it
          // the type arguments `<+>`.
          (!expectingOperand && context.operatorFollows?.(cursor) === true))
      )
        break;
      const next = cursor.peek()!;
      for (; tracked < children.length; tracked += 1)
        type.take(children[tracked]!);
      if (
        children.length > 0 &&
        leadingLineBreak(next) &&
        !type.continuesAcross(next)
      )
        break;
      // A type macro stands wherever a type operand does, and is one: the
      // whole of the type, or a member of a union, what `keyof` reads, the
      // element of an array type. Asked only of the type's first token, a
      // macro followed by anything -- `L(number)[]`, `L(number) | null` -- or
      // written after an operator -- `keyof L(number)` -- was read as a name
      // with a parenthesis after it, and the capture holding it refused.
      if (expectingOperand && arrow === "none") {
        const operandStart = cursor.index;
        const macro = this.options.resolveMacro?.("type", cursor, context);
        if (macro !== undefined) {
          const extent = validateMacro(macro, "type", cursor, operandStart);
          if (!extent.matched) return extent;
          children.push(extent.syntax);
          expectingOperand = false;
          continue;
        }
      }
      if (arrow !== "none") {
        if (token(next, "=>")) {
          children.push(cursor.consume()!);
          arrow = "none";
          expectingOperand = true;
          continue;
        }
        if (arrow === "required") break;
        arrow = "none";
      }
      if (next.tag === "group") {
        if (expectingOperand) {
          if (
            next.delimiter !== "parenthesis" &&
            next.delimiter !== "bracket" &&
            next.delimiter !== "brace" &&
            next.delimiter !== "template"
          )
            break;
          cursor.consume();
          if (next.delimiter === "parenthesis") {
            const reading = readTypeParenthesis(next);
            arrow =
              reading === "parameters"
                ? "required"
                : reading === "either"
                  ? "allowed"
                  : "none";
          }
          // A brace standing where a type is expected is an object type, and
          // its contents are a member list.
          children.push(
            next.delimiter === "brace" &&
              this.options.enforestTypeMemberBody !== undefined
              ? this.options.enforestTypeMemberBody(next, context)
              : next,
          );
          expectingOperand = false;
          continue;
        }
        if (next.delimiter === "bracket") {
          children.push(cursor.consume()!);
          continue;
        }
        const lastWord = [...children].reverse().find((item) => token(item));
        if (
          next.delimiter === "parenthesis" &&
          (lastWord?.raw === "import" || genericFunctionHead)
        ) {
          children.push(cursor.consume()!);
          if (genericFunctionHead) arrow = "required";
          genericFunctionHead = false;
          continue;
        }
        break;
      }

      // A type macro that already expanded stands here as one protected type
      // rather than as its tokens. Reading it as the end of the type left the
      // whole expansion unconsumed, so `maybe<string>` -- expanded to
      // `string | undefined` and kept whole so nothing around it re-associates
      // -- would not enforest back into the one type it is.
      if (next.tag === "protected") {
        if (!expectingOperand || next.category !== "type") break;
        children.push(cursor.consume()!);
        expectingOperand = false;
        continue;
      }

      if (!token(next)) break;
      const spelling = next.raw;
      if (
        conditionalDepth === 0 &&
        hardTypeStops.has(spelling) &&
        children.length > 0
      )
        break;
      if (expectingOperand && namesType(next, cursor.peek(1))) {
        children.push(cursor.consume()!);
        expectingOperand = false;
        continue;
      }
      // A `-` is a type only in front of the number it negates, which
      // TypeScript reads wherever that number is written: `-1` and `-\n1n`
      // are literal types.
      if (
        expectingOperand &&
        spelling === "-" &&
        numericLiteral(cursor.peek(1))
      ) {
        children.push(cursor.consume()!, cursor.consume()!);
        expectingOperand = false;
        continue;
      }
      if (spelling === ":") {
        if (conditionalDepth === 0 || expectingOperand) break;
        children.push(cursor.consume()!);
        conditionalDepth -= 1;
        expectingOperand = true;
        continue;
      }
      if (spelling === "?") {
        if (expectingOperand || awaitingQuestion === 0) break;
        children.push(cursor.consume()!);
        awaitingQuestion -= 1;
        conditionalDepth += 1;
        expectingOperand = true;
        continue;
      }
      if (continuationOperators.has(spelling)) {
        if (
          expectingOperand &&
          !(children.length === 0 && (spelling === "|" || spelling === "&"))
        )
          break;
        if (spelling === "extends") awaitingQuestion += 1;
        children.push(cursor.consume()!);
        expectingOperand = true;
        continue;
      }
      if (spelling === ".") {
        if (expectingOperand) break;
        children.push(cursor.consume()!);
        expectingOperand = true;
        continue;
      }
      if (spelling.startsWith("<")) {
        const previousWord = [...children]
          .reverse()
          .find((item) => token(item));
        // A generic function type begins a type, follows `new`, and is what
        // a function type may return: `(a: A) => <B>(b: B) => B`. Stopped at
        // the `<` there, an annotation of that type was refused.
        const returned = expectingOperand && token(children.at(-1), "=>");
        if (
          expectingOperand &&
          children.length > 0 &&
          previousWord?.raw !== "new" &&
          !returned
        )
          break;
        const atStart = children.length === 0 || returned;
        if (!consumeAngles(cursor, context, children)) {
          return failure(
            "type",
            cursor,
            start,
            ["balanced type arguments"],
            40,
          );
        }
        expectingOperand = false;
        genericFunctionHead = atStart || previousWord?.raw === "new";
        continue;
      }
      if (prefixTypeWords.has(spelling)) {
        if (!expectingOperand) break;
        children.push(cursor.consume()!);
        // A predicate's `asserts` with no name after it on its line is an
        // ordinary type name, and the type is finished. `let a: asserts` is
        // valid TypeScript declaring a variable of that type.
        if (spelling === "asserts" && !predicateOperandFollows(cursor.peek()))
          expectingOperand = false;
        continue;
      }
      const atom =
        next.kind === "identifier" ||
        next.kind === "string-literal" ||
        next.kind === "numeric-literal" ||
        next.kind === "bigint-literal" ||
        next.kind === "no-substitution-template" ||
        typeAtoms.has(spelling);
      if (!atom) break;
      if (!expectingOperand) {
        invalidAdjacency = true;
        break;
      }
      children.push(cursor.consume()!);
      expectingOperand = false;
    }

    if (
      children.length === 0 ||
      expectingOperand ||
      arrow === "required" ||
      conditionalDepth !== 0 ||
      invalidAdjacency
    ) {
      return failure(
        "type",
        cursor,
        start,
        ["complete TypeScript type"],
        children.length === 0 ? 1 : 40,
      );
    }
    // A type that is one macro and nothing else is that macro's extent.
    const [sole] = children;
    return Object.freeze({
      matched: true,
      syntax:
        children.length === 1 && sole?.tag === "protected"
          ? sole
          : protect("type", this.options, children),
      cursor,
    });
  }
}

/**
 * Whether `node`, written where a type is expected with `following` after it,
 * is the name of a type: a word the type grammar writes no operator with
 * there, reserved or not. TypeScript reads `let x: if`, `let x: extends` and
 * `A.class` as references to types spelled that way, and leaves what they name
 * to the checker.
 *
 * `abstract` is an operator only in front of the `new` of a constructor type,
 * which TypeScript looks for across a line break; anywhere else it names a
 * type. `import` names none: it is no type until its argument is written.
 */
export function namesType(
  node: Syntax,
  following: Syntax | undefined,
): boolean {
  if (!token(node) || node.kind !== "keyword" || node.raw === "import")
    return false;
  if (node.raw === "abstract") return !token(following, "new");
  return !prefixTypeWords.has(node.raw);
}

/** Whether `node` is a number or a bigint, the operands a `-` type takes. */
function numericLiteral(node: Syntax | undefined): boolean {
  return (
    token(node) &&
    (node.kind === "numeric-literal" || node.kind === "bigint-literal")
  );
}

/**
 * Whether the name a predicate's `asserts` is about stands after it.
 *
 * TypeScript writes `asserts [no LineTerminator here] IdentifierOrThis`: with
 * a line break between them the type ends at `asserts`, and `function f(x):
 * asserts` with its `x` on the next line is reported rather than read. So this
 * asks for a name on the same line, and `asserts` with anything else after it
 * -- or nothing -- is an ordinary type name.
 */
function predicateOperandFollows(operand: Syntax | undefined): boolean {
  return (
    token(operand) &&
    !leadingLineBreak(operand) &&
    (operand.kind === "identifier" || operand.raw === "this")
  );
}

/**
 * Tokens after which a type is written: an annotation's `:`, a union or
 * intersection, type arguments, a conditional type's branches, a function
 * type's `=>`, a type operator, a predicate's `is`, and the heritage a class
 * implements or an interface extends.
 *
 * A predicate's `asserts` is not among them, though it is a type operator of a
 * sort: TypeScript writes `asserts [no LineTerminator here] IdentifierOrThis`,
 * so a line can end after it and the name it is about is never a brace.
 * Unconditionally an operand head, it held `let a: asserts` open across the
 * break and swallowed the statement below -- where a macro then never ran.
 * `predicateOperandFollows` is the rule instead.
 */
const typeOperandHeads = new Set([
  ":",
  "|",
  "&",
  "<",
  ",",
  "?",
  "=>",
  "extends",
  "implements",
  "keyof",
  "readonly",
  "unique",
  "infer",
  "is",
]);

/**
 * Spellings a line cannot end after inside a type, because the type is not
 * finished: the tokens the type grammar writes a type after, the `-` of a
 * negative literal, the `.` of a qualified name, the `=` an alias's body and a
 * type parameter's default are written after, the `typeof` of a type query,
 * the `new` of a constructor type, and the `import` of `import("m").A`, which
 * is no type until its argument is written.
 *
 * They are the type grammar's own. A word the expression grammar writes as an
 * operator -- `as`, `in`, `await` -- names a type where a type is written and
 * finishes it, and an expression's operators are asked of the expression
 * table: a class field's initializer is an expression.
 */
const typeOperandExpectedAfter: ReadonlySet<string> = new Set([
  ...typeOperandHeads,
  "-",
  ".",
  "=",
  "typeof",
  "new",
  "import",
]);

/**
 * Whether what is written after `previous` is a type. A brace group there is
 * an object type, not the body of the declaration whose header holds it:
 * `m(): { a: number } {`, `(): () => { a: number } {`, `value is { a: number }
 * {`, `T extends { a: infer U } ? { u: U } : {} {`. The body is the brace
 * after the whole type.
 */
export function typeOperandFollows(previous: Syntax | undefined): boolean {
  return token(previous) && typeOperandHeads.has(previous.raw);
}

/**
 * What may carry a type on across a line break: the operators the type grammar
 * writes between two types, and the `,`, `=` and `;` that end a declarator's
 * or a member's annotation where it is written.
 *
 * An array type's `[` is not among them. TypeScript writes
 * `PrimaryType [no LineTerminator here] [ ]`, and reads `let x: A` and the
 * `[b] = c;` under it as two statements.
 *
 * Nor is a conditional type's `extends`. TypeScript writes
 * `CheckType [no LineTerminator here] extends`, and reads `let x: A` and the
 * `extends B ? C : D = e;` under it as two statements. The `extends` that
 * gives a type parameter its constraint carries no such restriction, and it is
 * written inside the `<` this walk holds open, where no line break ends
 * anything; the `extends` of a class or interface heritage clause is written
 * in a declaration's header rather than in a type, and is not read here.
 */
const typeContinuedBy = new Set(["|", "&", "?", ":", ",", "=>", ".", "=", ";"]);

/**
 * Whether the keyword `next` carries a type on across a line break after the
 * two nodes read before it, `before` and `previous`. Each of these words is a
 * name of its own anywhere else, and the line under a finished type may begin
 * with one: `let x: Foo` and the `is(x);` under it are two statements.
 *
 * - The `extends` of `infer R extends C` gives `R` its constraint, which
 *   TypeScript reads wherever it is written. Only a conditional's `extends`
 *   needs its check type on its own line.
 * - The `is` of `asserts x is T` belongs to the predicate. The `is` of `x is
 *   T` does not cross a line break, but nothing stops this one.
 * - `abstract` with `new` after it is a constructor type, however the two are
 *   broken across lines. With anything else after it, it is a type named
 *   `abstract`.
 */
function typeKeywordContinues(
  before: Syntax | undefined,
  previous: Syntax | undefined,
  next: string,
): boolean {
  switch (next) {
    case "extends":
      return token(before, "infer");
    case "is":
      return token(before, "asserts") && predicateName(previous);
    case "new":
      return token(previous, "abstract");
    default:
      return false;
  }
}

/**
 * Whether `node` is a name a type predicate may be about: a parameter's, or
 * `this`.
 */
function predicateName(node: Syntax | undefined): boolean {
  return token(node) && (node.kind === "identifier" || node.raw === "this");
}

/** Whether a type still expects an operand after `previous`. */
function typeExpectsOperand(previous: Syntax | undefined): boolean {
  return token(previous) && typeOperandExpectedAfter.has(previous.raw);
}

/**
 * A type read one node at a time by a walk that scans it, and where a line
 * break ends it. `opening` is what the type is written after: an annotation's
 * or a return type's `:`, or an alias's `=`; a type read on its own has none.
 * `returnType` says whether it is a return type, which may begin with a type
 * predicate.
 *
 * Every walk that scans a type asks this one tracker -- a declarator's
 * annotation, an alias's body, a function's return type and a class or
 * interface member's annotation alike -- so what a line break ends inside a
 * type is decided once. Each node is taken once, in constant time.
 */
export function createTypeTracker(
  opening: Syntax | undefined,
  returnType: boolean,
) {
  /**
   * How deep in type parameters or arguments the walk stands. A `<` still open
   * encloses whatever is written under it, so `let x: Array<\nnumber\n>` is one
   * type however its lines are broken, and an `=` or a `,` there -- `<T =
   * string>`, `Map<K, V>` -- is the type's own.
   */
  let typeArguments = 0;
  /**
   * Whether the outermost `<` the walk last opened was written where a type
   * was expected. Such a `<` opens a generic function type's type parameters
   * rather than type arguments, and the parameter list after its `>` belongs
   * to the same type: `<T>` and the `(x: T) => T` under it are one.
   */
  let typeParameters = false;
  /** The last two nodes taken, the one before `previous` first. */
  let before: Syntax | undefined;
  let previous: Syntax | undefined = opening;
  /**
   * Whether `previous` was read where a type was expected and names one. A
   * word the grammar writes as an operator elsewhere is a name there and
   * finishes the type: `keyof extends` and the statement under it are two,
   * where `A extends` waits for the type it compares against. `abstract` is
   * taken before what follows it is seen, and the `new` that makes it an
   * operator carries the type on by `typeKeywordContinues`.
   */
  let named = false;
  /**
   * Whether the type still expects an operand where the walk stands, so that
   * the line break in front of the next node ends nothing, whatever that node
   * begins: `function f():` and the `import("m").T` written under it are one
   * signature.
   */
  const expectsType = (): boolean =>
    !named &&
    (previous === undefined ||
      (typeParameters && typeArguments === 0 && angles(previous, ">") > 0) ||
      typeExpectsOperand(previous));
  /**
   * Whether the type is unfinished where the walk stands: it still expects an
   * operand, or a `<` it opened is still open. A word that begins a statement
   * begins a type there instead: `let x:` and the `import("m").T;` under it
   * are one declaration.
   */
  const unfinished = (): boolean => typeArguments !== 0 || expectsType();
  /**
   * Whether `node` is the `is` of a type predicate, `previous` being the name
   * written in front of it and `before` what that name was written after.
   * TypeScript reads a predicate where a return type begins -- after a
   * signature's `:`, or a function type's `=>` -- and before it reads a type
   * there: the name may be any identifier, so `keyof is` and `infer is` begin
   * predicates about parameters spelled that way rather than finishing a
   * type.
   */
  const predicateIs = (
    before: Syntax | undefined,
    previous: Syntax | undefined,
    node: Syntax,
  ): boolean =>
    token(node, "is") &&
    !leadingLineBreak(node) &&
    ((before === opening && returnType) || token(before, "=>")) &&
    token(previous) &&
    isIdentifierToken(previous);
  return Object.freeze({
    unfinished,
    /** Whether the walk stands inside type parameters or arguments. */
    nested(): boolean {
      return typeArguments !== 0;
    },
    /**
     * Whether the type carries on across a line break in front of `next`: where
     * it still expects an operand, and where `next` is one of the few things
     * that may stand in a type there, or a keyword the two nodes before it
     * carry on. A line cannot end after `keyof`, `infer` or `extends` any more
     * than after `|`.
     */
    continuesAcross(next: Syntax): boolean {
      return (
        unfinished() ||
        (next.tag === "token" &&
          (typeContinuedBy.has(next.raw) ||
            typeKeywordContinues(before, previous, next.raw)))
      );
    },
    /** Takes a node the walk has read. */
    take(node: Syntax): void {
      const operand = expectsType();
      if (typeArguments === 0 && angles(node, "<") > 0)
        typeParameters = operand;
      typeArguments += angles(node, "<");
      typeArguments = Math.max(0, typeArguments - angles(node, ">"));
      named =
        operand &&
        !predicateIs(before, previous, node) &&
        namesType(node, undefined);
      before = previous;
      previous = node;
    },
  });
}

export type TypeTracker = ReturnType<typeof createTypeTracker>;

/**
 * How many nodes the decorator beginning at offset 0 takes, reading nodes with
 * `peek`; undefined where no well-formed decorator begins there. A decorator is
 * `@` and then a parenthesized expression, `@(expr)`, or a name and the members
 * read off it, `@a.b.c`, which may be called once with type arguments and
 * arguments: `@a.b<T>(x)`.
 */
export function decoratorWidth(
  peek: (offset: number) => Syntax | undefined,
): number | undefined {
  if (!token(peek(0), "@")) return undefined;
  const target = peek(1);
  if (target?.tag === "group")
    return target.delimiter === "parenthesis" ? 2 : undefined;
  if (!token(target) || !isIdentifierToken(target)) return undefined;
  let width = 2;
  while (token(peek(width), ".")) {
    const member = peek(width + 1);
    if (
      !token(member) ||
      (member.kind !== "identifier" &&
        member.kind !== "keyword" &&
        member.kind !== "private-identifier")
    )
      return undefined;
    width += 2;
  }
  let call = width;
  const opening = peek(call);
  // Counted with `angles`, because the reader emits `<<` and `>>` as single
  // tokens and each stands for two. Counted one token at a time, a `<<` in
  // `@dec<Shift<1 << 2>>()` moved the depth by nothing, the scan ran off the
  // end of the input, and the decorator came back as the bare `@dec` with the
  // rest of it read as something else.
  if (opening !== undefined && angles(opening, "<") > 0) {
    let depth = 0;
    for (; ; call += 1) {
      const node = peek(call);
      if (node === undefined) return width;
      depth += angles(node, "<");
      depth = Math.max(0, depth - angles(node, ">"));
      if (depth === 0) break;
    }
    call += 1;
  }
  const arguments_ = peek(call);
  return arguments_?.tag === "group" && arguments_.delimiter === "parenthesis"
    ? call + 1
    : width;
}

/** How many nodes the decorators written one after another take. */
function decoratorsWidth(peek: (offset: number) => Syntax | undefined): number {
  let index = 0;
  for (;;) {
    const width = decoratorWidth((offset) => peek(index + offset));
    if (width === undefined) return index;
    index += width;
  }
}

/** How many nodes the decorators at the start of `children` take. */
function decoratorPrefixLength(children: readonly Syntax[]): number {
  return decoratorsWidth((offset) => children[offset]);
}

/**
 * Whether the function these nodes head is async: a declaration, a method or
 * an accessor, read from its start. `async` is written among the words in
 * front of the parameter list -- `export async function name(`, `static async
 * *[key](` -- so the words are read until that list, which is the first node
 * that is not one, past any decorators.
 *
 * A function named `async` writes its parameter list or its type parameters
 * where the name the modifier stands in front of would otherwise be, so
 * `async(` and `async<` are a name rather than a modifier -- and so is an
 * `async` left at the end of its line, which `asyncModifies` answers for here
 * as it does wherever else an `async` is read.
 */
export function declaresAsync(nodes: readonly Syntax[]): boolean {
  const declaration = nodes.slice(decoratorPrefixLength(nodes));
  for (const [index, node] of declaration.entries()) {
    if (!token(node)) return false;
    if (node.raw !== "async") continue;
    const after = declaration[index + 1];
    return (
      asyncModifies(node, after) &&
      !(
        (after?.tag === "group" && after.delimiter === "parenthesis") ||
        token(after, "<")
      )
    );
  }
  return false;
}

/**
 * Whether a class member can begin with `syntax`: a decorator, a generator's
 * `*`, a name -- a word, a private name, a string or number, or a computed
 * name in brackets.
 */
function beginsClassMember(syntax: Syntax): boolean {
  if (syntax.tag === "group") return syntax.delimiter === "bracket";
  if (syntax.tag !== "token") return false;
  return (
    syntax.raw === "@" || syntax.raw === "*" || isPropertyNameToken(syntax)
  );
}

/**
 * The words that may stand before a member's name, and those of them
 * TypeScript reads across a line break. Any other modifier word ending a line
 * is the member's name instead: `readonly` alone on a line declares a field
 * called `readonly`.
 */
interface MemberModifiers {
  readonly written: ReadonlySet<string>;
  readonly continuing: ReadonlySet<string>;
}

/**
 * The spellings a class field's initializer cannot end a line after: the
 * expression grammar's, but for `await` and `yield`. An initializer is
 * evaluated as a function of its own, where neither is an expression, so each
 * is a name there and finishes the initializer: TypeScript reads `x = await`
 * and the `b` under it as two members.
 */
const initializerOperandExpectedAfter: ReadonlySet<string> = new Set(
  [...operandExpectedAfter].filter(
    (spelling) => spelling !== "await" && spelling !== "yield",
  ),
);

/** Whether `node` is a parenthesized group: a parameter list, in a header. */
function parenthesis(node: Syntax | undefined): boolean {
  return node?.tag === "group" && node.delimiter === "parenthesis";
}

/**
 * Whether `next` stands where a member's signature carries on: a parameter
 * list, or the `<` of type parameters. TypeScript reads either after a
 * member's name wherever it is written, so `m` and the `(x): void` under it
 * are one method signature.
 */
function signatureFollows(next: Syntax): boolean {
  return parenthesis(next) || angles(next, "<") > 0;
}

/**
 * A class or interface member read one node at a time, and whether a line
 * break may end it where the walk stands.
 *
 * A member is written in up to three parts, and a line break ends each by a
 * grammar of its own. Its header -- decorators, modifiers, name, type
 * parameters and parameters -- ends where no modifier TypeScript carries
 * across a line break is left waiting and no signature is still to come. Its
 * annotation after a `:` is a type, which the type tracker answers for as it
 * does for a declaration, so `x: <T>` and the `(v: T) => T` under it are one
 * member, and `x: is` and the `y: 1` under it are two. A class field's
 * initializer after an `=` is an expression. Each node is taken once.
 */
function createMemberTracker(modifiers: MemberModifiers) {
  const nodes: Syntax[] = [];
  /** How deep in the header's type parameters the walk stands. */
  let typeParameters = 0;
  /** The member's annotation, once the `:` that opens it is read. */
  let annotation: TypeTracker | undefined;
  /** Whether the walk has read the `=` that opens a field's initializer. */
  let initialized = false;
  /**
   * The type an `as` or a `satisfies` in the initializer asserts, while the
   * walk stands in it: how many conditional types' `extends` still wait for
   * their `?`, and how many of those `?`s for their `:` -- a `?` and a `:`
   * outside them are the expression's -- and the two nodes it took last.
   */
  let asserted:
    | {
        readonly type: TypeTracker;
        awaitingQuestion: number;
        awaitingColon: number;
        taken: number;
        previous: Syntax | undefined;
        beforePrevious: Syntax | undefined;
      }
    | undefined;
  /**
   * Where the last parenthesized group read before any initializer stands,
   * and the last of those read in the header outside its type parameters:
   * a parameter list, where it stands after the decorators. -1 for none.
   */
  let lastParenthesis = -1;
  let lastParameters = -1;
  /**
   * Where the last node that is no modifier stands, and where the last one
   * in front of the latest node stood. A member's name follows nodes that
   * are all modifiers after its decorators, and the decorators are written
   * first, so those nodes are modifiers wherever no node after the
   * decorators is not one.
   */
  let lastOther = -1;
  let lastOtherBeforeLatest = -1;
  /**
   * How many nodes the member's decorators take of its first `length`. A
   * decorator is read from the start of the member and ends within a few
   * nodes, so this reads only the decorators, whatever follows them.
   */
  const decorated = (length: number): number =>
    decoratorsWidth((offset) => (offset < length ? nodes[offset] : undefined));
  /** Whether the member's name follows its first `length` nodes. */
  const nameFollowsAfter = (length: number, other: number): boolean =>
    other < decorated(length);
  /**
   * Takes a node of a field's initializer, `previous` being the node before
   * it. An `as` or a `satisfies` written after an operand opens the type it
   * asserts, which the type tracker reads, and the type ends at the first
   * token no type holds where it stands: an operator of the expression around
   * it, or a `?` or a `:` outside a conditional type.
   */
  const takeInitializer = (node: Syntax, previous: Syntax | undefined) => {
    if (
      token(node) &&
      (node.raw === "as" || node.raw === "satisfies") &&
      !(token(previous) && initializerOperandExpectedAfter.has(previous.raw))
    ) {
      asserted = {
        type: createTypeTracker(undefined, false),
        awaitingQuestion: 0,
        awaitingColon: 0,
        taken: 0,
        previous: undefined,
        beforePrevious: undefined,
      };
      return;
    }
    if (asserted === undefined) return;
    // No type begins with these, so the word before them was a name spelled
    // `as`: the parameter of `async as => as`, or a binding's.
    if (asserted.taken === 0 && token(node) && namedAs.has(node.raw)) {
      asserted = undefined;
      return;
    }
    // A type still expecting an operand takes what follows as one: the `-`
    // of `as -1` is a literal's sign. Nested in type arguments, a `>` closes
    // them and a `,` separates them.
    if (!asserted.type.nested() && !asserted.type.unfinished() && token(node)) {
      if (node.raw === "extends") {
        // `infer U extends C` constrains `U`, and opens no conditional.
        if (!token(asserted.beforePrevious, "infer"))
          asserted.awaitingQuestion += 1;
      } else if (node.raw === "?" && asserted.awaitingQuestion > 0) {
        asserted.awaitingQuestion -= 1;
        asserted.awaitingColon += 1;
      } else if (node.raw === ":" && asserted.awaitingColon > 0) {
        asserted.awaitingColon -= 1;
      } else if (
        endsAssertedType.has(node.raw) ||
        node.raw === "?" ||
        node.raw === ":"
      ) {
        asserted = undefined;
        return;
      }
    }
    asserted.type.take(node);
    asserted.taken += 1;
    asserted.beforePrevious = asserted.previous;
    asserted.previous = node;
  };
  return Object.freeze({
    /** The member read so far. */
    nodes: nodes as readonly Syntax[],
    /** Whether the walk stands in a field's initializer. */
    initialized(): boolean {
      return initialized;
    },
    /**
     * Whether the walk stands inside type parameters or arguments, where a `,`
     * is theirs: `first: Map<string, number>` is one member.
     */
    nested(): boolean {
      return (
        typeParameters !== 0 ||
        (!initialized && annotation !== undefined && annotation.nested())
      );
    },
    /**
     * Whether the member's name is written next: what was read holds only
     * decorators and modifiers.
     */
    nameFollows(): boolean {
      return nameFollowsAfter(nodes.length, lastOther);
    },
    /**
     * Whether the member is whole at the brace it last took: a method's or an
     * accessor's body, or a static block. A brace after an initializer's `=`
     * is an object literal, and one where a type is still expected an object
     * type.
     */
    endsAtBrace(): boolean {
      const brace = nodes.at(-1);
      if (brace?.tag !== "group" || brace.delimiter !== "brace") return false;
      if (initialized || typeOperandFollows(nodes.at(-2))) return false;
      const header = decorated(nodes.length - 1);
      if (nodes.length - 1 - header === 1 && token(nodes[header], "static"))
        return true;
      return lastParenthesis >= header;
    },
    /**
     * Whether the initializer ends in a type an `as` or a `satisfies` asserts
     * that a line break in front of `next` ends. Nothing carries an assertion
     * on as an operand -- no member access, call or index -- so a bracket
     * there begins the next member rather than indexing the initializer.
     */
    assertionEndsBefore(next: Syntax): boolean {
      return asserted !== undefined && !asserted.type.continuesAcross(next);
    },
    /** Takes a node the walk has read. */
    take(node: Syntax): void {
      const at = nodes.length;
      const previous = nodes.at(-1);
      nodes.push(node);
      lastOtherBeforeLatest = lastOther;
      if (!token(node) || !modifiers.written.has(node.raw)) lastOther = at;
      if (initialized) {
        takeInitializer(node, previous);
        return;
      }
      if (parenthesis(node)) lastParenthesis = at;
      if (annotation !== undefined) {
        if (token(node, "=") && !annotation.nested()) initialized = true;
        else annotation.take(node);
        return;
      }
      typeParameters += angles(node, "<");
      typeParameters = Math.max(0, typeParameters - angles(node, ">"));
      if (typeParameters !== 0) return;
      if (parenthesis(node)) lastParameters = at;
      if (token(node, ":"))
        annotation = createTypeTracker(node, parenthesis(nodes.at(-2)));
      else if (token(node, "=")) initialized = true;
    },
    /** Whether a line break in front of `next` may end the member. */
    lineCanEnd(next: Syntax): boolean {
      const previous = nodes.at(-1);
      // Inside an asserted type the type grammar says what a line break
      // ends: the `>` closing `as Map<K, V>` compares nothing.
      if (initialized && asserted !== undefined)
        return !asserted.type.continuesAcross(next);
      if (initialized)
        return !(
          token(previous) && initializerOperandExpectedAfter.has(previous.raw)
        );
      if (annotation !== undefined) return !annotation.continuesAcross(next);
      if (typeParameters !== 0) return false;
      if (signatureFollows(next) && lastParameters < decorated(nodes.length))
        return false;
      if (
        token(previous) &&
        nameFollowsAfter(nodes.length - 1, lastOtherBeforeLatest)
      )
        return !modifiers.continuing.has(previous.raw);
      return true;
    },
  });
}

type MemberTracker = ReturnType<typeof createMemberTracker>;

/**
 * What follows a word spelled `as` where it is a name rather than the
 * operator: an arrow's parameter, `async as => as`, or something assigned.
 */
const namedAs: ReadonlySet<string> = new Set(["=>", "=", ","]);

/**
 * The tokens that end a type an `as` or a `satisfies` asserts, written where
 * it stands outside any type arguments: the expression's own operators, which
 * no type writes there. The reader writes each `>` as a token of its own, so
 * a `>` that closes no type arguments compares, and `>>` and `>=` begin with
 * one. A `?` and a `:` end it too outside a conditional type.
 */
const endsAssertedType: ReadonlySet<string> = new Set([
  ">",
  ",",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "&&",
  "||",
  "??",
  "==",
  "===",
  "!=",
  "!==",
  "<=",
  "<<",
  "^",
  "in",
  "instanceof",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "&&=",
  "||=",
  "??=",
  "<<=",
  "&=",
  "|=",
  "^=",
]);

/**
 * Whether `next`, which could begin a member, instead carries an initializer
 * on from the line before: `*` multiplies, a bracket indexes, `in` and
 * `instanceof` compare.
 */
function continuesInitializer(next: Syntax): boolean {
  if (next.tag === "group") return next.delimiter === "bracket";
  return (
    token(next) &&
    (next.raw === "*" || next.raw === "in" || next.raw === "instanceof")
  );
}

const classMemberModifiers: MemberModifiers = {
  written: new Set([...classModifiers, "async", "get", "set", "*"]),
  continuing: new Set(["static", "get", "set", "*"]),
};

/** What may follow a class member's name, where a modifier cannot. */
const memberAfterName = new Set(["<", "=", ";", ":", "?", "!"]);

/**
 * Whether the class member `member` is static: `static` written among the
 * modifiers in front of its name, or a static block. A member named `static`
 * is not, and TypeScript tells the two apart by what follows the word: the
 * member's name, its body or another modifier, where the name it is stands
 * before a parameter list, a type, an initializer or the member's end.
 */
export function staticClassMember(member: readonly Syntax[]): boolean {
  const declaration = member.slice(decoratorPrefixLength(member));
  for (let at = 0; at < declaration.length; at += 1) {
    const node = declaration[at]!;
    if (!token(node) || !classMemberModifiers.written.has(node.raw))
      return false;
    if (node.raw !== "static") continue;
    const next = declaration[at + 1];
    return (
      next !== undefined &&
      !(next.tag === "group" && next.delimiter === "parenthesis") &&
      !(token(next) && memberAfterName.has(next.raw))
    );
  }
  return false;
}

/**
 * Whether `next` begins a new class member after `member`, the member a walk
 * has read so far. A member ends at its `;`, at the body of a method or
 * static block, or -- by automatic semicolon insertion, as TypeScript reads a
 * class body -- at a line break before syntax that begins another member.
 * It does not end there where the line cannot end: after decorators alone,
 * after a modifier TypeScript carries onto the next line, or inside a type or
 * an initializer that carries on across the break. Nor does it end where what
 * begins the next line carries a field's initializer on.
 */
function classMemberEndsBefore(member: MemberTracker, next: Syntax): boolean {
  const { nodes } = member;
  if (nodes.length === 0) return false;
  if (token(nodes.at(-1), ";") || member.endsAtBrace()) return true;
  return (
    leadingLineBreak(next) &&
    beginsClassMember(next) &&
    decoratorPrefixLength(nodes) !== nodes.length &&
    member.lineCanEnd(next) &&
    !(
      member.initialized() &&
      continuesInitializer(next) &&
      !(next.tag === "group" && member.assertionEndsBefore(next))
    )
  );
}

/**
 * A class body's members, read one node at a time: where each ends and what
 * stands at the head of the one being read. Each node is taken once, so a
 * long member costs its length rather than its square.
 */
export interface ClassMemberWalk {
  /** The member read so far. */
  readonly nodes: readonly Syntax[];
  /** Whether the member read so far ends in front of `next`. */
  endsBefore(next: Syntax): boolean;
  /** Takes the next node of the member being read. */
  take(node: Syntax): void;
  /** Begins the next member, with nothing read of it. */
  restart(): void;
  /**
   * Whether the member's name is written next: what was read of it holds only
   * decorators and modifiers.
   */
  nameFollows(): boolean;
}

/** A walk over a class body, standing at the start of its first member. */
export function createClassMemberWalk(): ClassMemberWalk {
  let member = createMemberTracker(classMemberModifiers);
  return Object.freeze({
    get nodes() {
      return member.nodes;
    },
    endsBefore: (next: Syntax) => classMemberEndsBefore(member, next),
    take: (node: Syntax) => {
      member.take(node);
    },
    restart: () => {
      member = createMemberTracker(classMemberModifiers);
    },
    nameFollows: () => member.nameFollows(),
  });
}

class ClassElementConsumer implements SyntaxConsumer {
  constructor(readonly options: TypeClassConsumerOptions) {
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    const macro = this.options.resolveMacro?.("classElement", cursor, context);
    if (macro !== undefined)
      return validateMacro(macro, "classElement", cursor, start);
    const decorators = decoratorsWidth((offset) => cursor.peek(offset));
    if (token(cursor.peek(decorators), "@")) {
      return failure(
        "classElement",
        cursor,
        start,
        ["decorator expression after '@'"],
        40,
      );
    }
    const member = createMemberTracker(classMemberModifiers);
    const children: Syntax[] = [];
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (classMemberEndsBefore(member, next)) break;
      const initializes = !member.initialized();
      member.take(next);
      children.push(cursor.consume()!);
      const consumeInitializer = this.options.consumeInitializer;
      if (
        initializes &&
        member.initialized() &&
        consumeInitializer !== undefined
      ) {
        // An initializer is evaluated as a function of its own, where
        // neither `yield` nor `await` is an expression, and the field ends
        // where its expression does: at a `;`, or at the line break TypeScript
        // inserts one at.
        const initializer = consumeInitializer.consume(cursor, {
          ...context,
          category: "expr",
          allowYield: false,
          allowAwait: false,
          stopSet: context.stopSet.union(
            new StopSet([{ kind: "token", raw: ";" }]),
          ),
        });
        if (!initializer.matched)
          return failure(
            "classElement",
            cursor,
            start,
            initializer.failure.expectations,
            initializer.failure.specificity,
          );
        children.push(initializer.syntax);
        if (token(cursor.peek(), ";")) children.push(cursor.consume()!);
        break;
      }
      if (member.endsAtBrace()) {
        // The element ended at its body; enforest that body so macros inside a
        // method are reached.
        const enforest = this.options.enforestStatementBlock;
        if (enforest !== undefined && next.tag === "group")
          children[children.length - 1] = enforest(
            next,
            context,
            // A generator method is written `*name() {}`, so the star appears
            // among the tokens scanned before the parameter list.
            children.some((node) => token(node, "*")),
            declaresAsync(children),
          );
        break;
      }
    }
    if (children.length === 0) {
      return failure("classElement", cursor, start, ["class element"], 1);
    }
    if (
      token(children[0], "@") &&
      (children.length < 3 || token(children[1], ";"))
    ) {
      return failure(
        "classElement",
        cursor,
        start,
        ["complete decorated class element"],
        40,
      );
    }
    const last = children.at(-1);
    const explicit = token(last, ";");
    const body = member.endsAtBrace();
    const automatic = cursor.atEnd || leadingLineBreak(cursor.peek());
    if (!explicit && !body && !automatic) {
      return failure(
        "classElement",
        cursor,
        start,
        ["class-element body or terminator"],
        30,
      );
    }
    return Object.freeze({
      matched: true,
      syntax: protect("classElement", this.options, children),
      cursor,
    });
  }
}

/**
 * The words before the name of an interface's member. A construct signature
 * opens with `new`, and TypeScript reads `new`, `get` and `set` across a line
 * break the way it reads a class's `static`.
 */
const typeMemberModifiers: MemberModifiers = {
  written: new Set(["readonly", "new", "get", "set"]),
  continuing: new Set(["new", "get", "set"]),
};

/** How many angles of `character` a node opens or closes. */
function angles(node: Syntax, character: "<" | ">"): number {
  return token(node) ? angleWidth(node.raw, character) : 0;
}

/**
 * Whether `next` begins a new member of an interface or object type after
 * `member`, the member read so far: a line break before syntax that begins a
 * member, where the line can end.
 */
function typeMemberEndsBefore(member: MemberTracker, next: Syntax): boolean {
  return (
    member.nodes.length > 0 &&
    leadingLineBreak(next) &&
    likelyNextTypeMember(next) &&
    member.lineCanEnd(next)
  );
}

/**
 * Whether `separator` ends the member read so far. A `,` inside type
 * arguments belongs to them: `first: Map<string, number>` is one member.
 */
function separatesTypeMembers(
  member: MemberTracker,
  separator: Syntax,
): boolean {
  if (token(separator, ";")) return true;
  return token(separator, ",") && !member.nested();
}

/**
 * Whether this node can open the next member of an interface or object type.
 * A member is named by an identifier, a keyword used as a name, a string or
 * numeric literal key, or a computed key in brackets; a call signature opens
 * with its parameter list or its type parameters, and a construct signature
 * with `new`.
 */
function likelyNextTypeMember(syntax: Syntax | undefined): boolean {
  if (token(syntax)) {
    return (
      syntax.kind === "identifier" ||
      syntax.kind === "keyword" ||
      syntax.kind === "string-literal" ||
      syntax.kind === "numeric-literal" ||
      angles(syntax, "<") > 0
    );
  }
  return (
    syntax?.tag === "group" &&
    (syntax.delimiter === "bracket" ||
      syntax.delimiter === "parenthesis" ||
      syntax.delimiter === "template")
  );
}

/**
 * The nodes of the member beginning at the cursor, bounded the way TypeScript
 * bounds one without a terminator: at `;`, or at the line break before the
 * next member.
 *
 * A `,` is not a bound here. It separates members only when the member is
 * ordinary syntax; a macro's invocation may contain one of its own, and where
 * a macro stands it is the macro's rule that says where the member ends. The
 * slice exists so the rule is matched against this member alone -- run against
 * the rest of the body, a trailing `$($kind:type),*` reads the next member's
 * name as one more type, fails, and silently claims less than was written.
 */
function memberSlice(
  cursor: SyntaxCursor,
  context: ConsumerContext,
): readonly Syntax[] {
  const scan = cursor.fork();
  const member = createMemberTracker(typeMemberModifiers);
  while (!scan.atEnd && !context.stopSet.matches(scan)) {
    checkWork(context);
    const next = scan.peek()!;
    if (typeMemberEndsBefore(member, next)) break;
    member.take(scan.consume()!);
    if (token(next, ";")) break;
  }
  return member.nodes;
}

/**
 * Whether the cursor stands on a member's own key rather than on a macro head.
 * A property is written `name: T` and a method `name(...)`, and either may be
 * spelled like a macro without meaning it.
 */
function namesTypeMember(cursor: SyntaxCursor): boolean {
  const head = cursor.peek();
  if (!token(head) || head.kind !== "identifier") return false;
  const next = cursor.peek(1);
  if (next === undefined) return false;
  if (next.tag === "group")
    return next.delimiter === "parenthesis" || next.delimiter === "bracket";
  return token(next) && [":", "?", "<", "!"].includes(next.raw);
}

/**
 * Reads one member of an interface or object type.
 *
 * A type member carries no body, so unlike a class element it always ends at
 * its terminator: `;`, `,`, or the line break before the next member. The
 * separator is kept with the member it follows, so a run of members prints
 * back exactly as it was written.
 */
class TypeMemberConsumer implements SyntaxConsumer {
  constructor(readonly options: TypeClassConsumerOptions) {
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    // A member's extent is measured by the macro's own rule when one stands
    // here, because a member list separates on `,` and a macro's invocation
    // may contain one: `overloaded parse over string, number` is one member,
    // not a member ending at the comma.
    //
    // A member may also be named like a macro without invoking it, so the
    // macro is only offered where the name cannot be the member's own key.
    if (
      this.options.resolveTypeMemberMacro !== undefined &&
      !namesTypeMember(cursor)
    ) {
      const slice = memberSlice(cursor, context);
      if (slice.length > 0) {
        const bounded = createSyntaxCursor(createSyntaxSequence(slice));
        const macro = this.options.resolveTypeMemberMacro(
          "typeMember",
          bounded,
          context,
        );
        if (macro !== undefined) {
          const taken = validateMacro(macro, "typeMember", bounded, 0);
          if (taken.matched) {
            cursor.advance(taken.cursor.index);
            return Object.freeze({
              matched: true,
              syntax: taken.syntax,
              cursor,
            });
          }
          return taken;
        }
      }
    }
    const member = createMemberTracker(typeMemberModifiers);
    const children: Syntax[] = [];
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (typeMemberEndsBefore(member, next)) break;
      const separates = separatesTypeMembers(member, next);
      member.take(next);
      cursor.consume();
      // A member's type may itself be an object type, whose contents are
      // another member list.
      children.push(
        next.tag === "group" &&
          next.delimiter === "brace" &&
          this.options.enforestTypeMemberBody !== undefined
          ? this.options.enforestTypeMemberBody(next, context)
          : next,
      );
      if (separates) break;
    }
    if (children.length === 0)
      return failure("typeMember", cursor, start, ["type member"], 1);
    const last = children.at(-1);
    const terminated = token(last, ";") || token(last, ",");
    const automatic = cursor.atEnd || leadingLineBreak(cursor.peek());
    if (!terminated && !automatic)
      return failure(
        "typeMember",
        cursor,
        start,
        ["type-member terminator"],
        30,
      );
    return Object.freeze({
      matched: true,
      syntax: protect("typeMember", this.options, children),
      cursor,
    });
  }
}

/**
 * Builds the type and type-member consumers as one pair.
 *
 * The two are mutually recursive: an object type's body is a member list, and
 * a member's own type may be another object type. Built separately, whichever
 * was built first would have no way to reach the other, so a member macro
 * written one level in would never be dispatched.
 */
export function createTypeConsumers(options: TypeClassConsumerOptions): {
  readonly type: SyntaxConsumer;
  readonly typeMember: SyntaxConsumer;
} {
  // The member consumer does not exist yet when the type consumer is built, so
  // the two meet through this holder rather than through a forward reference.
  const pair: { typeMember?: SyntaxConsumer } = {};
  const enforestTypeMemberBody = (
    body: GroupSyntax,
    context: ConsumerContext,
  ): Syntax => {
    const members = pair.typeMember;
    if (members === undefined || body.children.length === 0) return body;
    let inner = createSyntaxCursor(body.children);
    const consumed: Syntax[] = [];
    const memberContext = Object.freeze({
      ...context,
      category: "typeMember" as const,
      stopSet: StopSet.empty,
    });
    while (!inner.atEnd) {
      const before = inner.index;
      const attempt = members.consume(inner, memberContext);
      // A body that does not read as a member list is left exactly as it was;
      // TypeScript reports anything genuinely malformed.
      if (!attempt.matched || attempt.cursor.index <= before) return body;
      consumed.push(attempt.syntax);
      inner = attempt.cursor;
    }
    return createGroup({
      ...body,
      id: options.allocateSyntaxId(),
      children: createSyntaxSequence(consumed),
    });
  };
  const linked: TypeClassConsumerOptions = {
    ...options,
    enforestTypeMemberBody,
  };
  const type = Object.freeze(new TypeConsumer(linked));
  pair.typeMember = Object.freeze(new TypeMemberConsumer(linked));
  return Object.freeze({ type, typeMember: pair.typeMember });
}

export function createTypeConsumer(
  options: TypeClassConsumerOptions,
): SyntaxConsumer {
  return createTypeConsumers(options).type;
}

export function createTypeMemberConsumer(
  options: TypeClassConsumerOptions,
): SyntaxConsumer {
  return createTypeConsumers(options).typeMember;
}

export function createClassElementConsumer(
  options: TypeClassConsumerOptions,
): SyntaxConsumer {
  return Object.freeze(new ClassElementConsumer(options));
}
