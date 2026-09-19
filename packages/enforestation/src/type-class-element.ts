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
import { operandExpectedAfter as expressionOperandExpectedAfter } from "./core-operators.js";
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

function consumeAngles(
  cursor: SyntaxCursor,
  context: ConsumerContext,
  children: Syntax[],
): boolean {
  let depth = 0;
  while (!cursor.atEnd) {
    checkWork(context);
    const next = cursor.consume()!;
    children.push(next);
    if (!token(next)) continue;
    depth += angleWidth(next.raw, "<");
    depth -= angleWidth(next.raw, ">");
    if (depth === 0) return true;
    if (depth < 0) return false;
  }
  return false;
}

/**
 * A parenthesis standing where a type is expected is either a parenthesized
 * type or the parameter list of a function type, and only a parameter list may
 * be followed by `=>`. This follows TypeScript's own reading: an empty list, a
 * rest parameter, or a name followed by `:`, `,`, `?`, or `=` can only be
 * parameters; a lone name is either one, decided by whether `=>` follows.
 */
function readParenthesis(group: GroupSyntax): "parameters" | "either" | "type" {
  const [first, second] = group.children;
  if (first === undefined) return "parameters";
  if (first.tag === "token" && first.raw === "...") return "parameters";
  const startsParameter = token(first)
    ? /^[A-Za-z_$][\w$]*$/u.test(first.raw)
    : first.tag === "group" &&
      (first.delimiter === "brace" || first.delimiter === "bracket");
  if (!startsParameter) return "type";
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
    const macro = this.options.resolveMacro?.("type", cursor, context);
    if (macro !== undefined) return validateMacro(macro, "type", cursor, start);
    const children: Syntax[] = [];
    let expectingOperand = true;
    let conditionalDepth = 0;
    let genericFunctionHead = false;
    let invalidAdjacency = false;
    // Whether the parameter list just read must, or may, be followed by `=>`.
    // One that must is not yet a type, so a caller's stop cannot end it there.
    let arrow: "none" | "allowed" | "required" = "none";

    while (!cursor.atEnd) {
      checkWork(context);
      if (
        children.length > 0 &&
        conditionalDepth === 0 &&
        arrow !== "required" &&
        context.stopSet.matches(cursor)
      )
        break;
      const next = cursor.peek()!;
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
            const reading = readParenthesis(next);
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
      if (spelling === ":") {
        if (conditionalDepth === 0 || expectingOperand) break;
        children.push(cursor.consume()!);
        conditionalDepth -= 1;
        expectingOperand = true;
        continue;
      }
      if (spelling === "?") {
        if (expectingOperand) break;
        children.push(cursor.consume()!);
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
        if (
          expectingOperand &&
          children.length > 0 &&
          previousWord?.raw !== "new"
        )
          break;
        const atStart = children.length === 0;
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
    return Object.freeze({
      matched: true,
      syntax: protect("type", this.options, children),
      cursor,
    });
  }
}

/**
 * Tokens after which a type is written: an annotation's `:`, a union or
 * intersection, type arguments, a conditional type's branches, a function
 * type's `=>`, a type operator, a predicate's `is`, and the heritage a class
 * implements or an interface extends.
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
  "asserts",
  "is",
]);

/**
 * Spellings an expression expects an operand after which a type does not, so
 * that the expression table is not read for them. `void` is a whole type
 * rather than a prefix operator, and the type grammar has no infix `>` at all:
 * a `>` in a type closes type arguments, and closing them finishes the type
 * they belong to.
 *
 * Taken from the expression table, each held a finished type open across the
 * line break under it: `let v: Array<string>` and the `foo();` written beneath
 * were measured as one annotation, which the type reader then refused -- and a
 * refused item leaves its module to be walked as raw tokens, with every macro
 * in it unreached.
 */
const expressionOnlyOperands = new Set(["void", ">"]);

/**
 * Spellings a line cannot end after inside a type, because the type is not
 * finished: the ones an expression cannot end after that a type cannot either
 * -- `typeof` and the `new` of a constructor type are written in both
 * grammars -- the tokens the type grammar writes a type after, and the
 * `import` of `import("m").A`, which is no type until its argument is written.
 *
 * A class member's annotation and a declarator's are the same type grammar
 * read in two places, so the reader of each asks this one question of what it
 * last read.
 */
export const typeOperandExpectedAfter: ReadonlySet<string> = new Set([
  ...[...expressionOperandExpectedAfter].filter(
    (spelling) => !expressionOnlyOperands.has(spelling),
  ),
  ...typeOperandHeads,
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

function classElementCanEndAtBrace(children: readonly Syntax[]): boolean {
  const brace = children.at(-1);
  if (brace?.tag !== "group" || brace.delimiter !== "brace") return false;
  const before = children.slice(0, -1);
  if (before.some((item) => token(item, "="))) return false;
  if (typeOperandFollows(before.at(-1))) return false;
  const declaration = before.slice(decoratorPrefixLength(before));
  if (declaration.length === 1 && token(declaration[0], "static")) return true;
  return declaration.some(
    (item) => item.tag === "group" && item.delimiter === "parenthesis",
  );
}

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
  if (token(peek(call), "<")) {
    let depth = 0;
    for (; ; call += 1) {
      const node = peek(call);
      if (node === undefined) return width;
      if (token(node, "<")) depth += 1;
      else if (token(node, ">")) depth -= 1;
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

/** Whether a line can end after `member`, the syntax of a member read so far. */
function lineCanEndAfter(
  member: readonly Syntax[],
  modifiers: MemberModifiers,
): boolean {
  const previous = member.at(-1);
  if (!token(previous)) return true;
  if (memberNameFollows(member.slice(0, -1), modifiers))
    return !modifiers.continuing.has(previous.raw);
  // `?` straight after a member's name marks it optional, and ends it.
  if (previous.raw === "?" && memberNameFollows(member.slice(0, -2), modifiers))
    return true;
  // A `>` closing type arguments ends a type; any other is an operator.
  if (angleWidth(previous.raw, ">") > 0) {
    return (
      typeArgumentDepth(member) === 0 &&
      member.some((node) => angles(node, "<") > 0)
    );
  }
  return !typeOperandExpectedAfter.has(previous.raw);
}

/**
 * Whether `member` has an initializer: an `=` outside the type parameters and
 * arguments written in it.
 */
function hasInitializer(member: readonly Syntax[]): boolean {
  let depth = 0;
  for (const node of member) {
    depth += angles(node, "<");
    depth = Math.max(0, depth - angles(node, ">"));
    if (depth === 0 && token(node, "=")) return true;
  }
  return false;
}

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

/**
 * Whether the name of a member is written next after `member`, the syntax of
 * the member read so far: it holds only decorators and modifiers.
 */
function memberNameFollows(
  member: readonly Syntax[],
  modifiers: MemberModifiers,
): boolean {
  return member
    .slice(decoratorPrefixLength(member))
    .every((node) => token(node) && modifiers.written.has(node.raw));
}

/**
 * Whether the name of a class member is written next after `member`, the
 * syntax of the member read so far: it holds only decorators and modifiers.
 */
export function classMemberNameFollows(member: readonly Syntax[]): boolean {
  return memberNameFollows(member, classMemberModifiers);
}

/**
 * Whether `next` begins a new class member after `member`, the syntax of the
 * member read so far. A member ends at its `;`, at the body of a method or
 * static block, or -- by automatic semicolon insertion, as TypeScript reads a
 * class body -- at a line break before syntax that begins another member.
 * It does not end there where the line cannot end: after decorators alone,
 * after a modifier TypeScript carries onto the next line, or after an operator
 * waiting for its operand. Nor does it end where what begins the next line
 * carries a field's initializer on.
 */
export function classElementEndsBefore(
  member: readonly Syntax[],
  next: Syntax,
): boolean {
  if (member.length === 0) return false;
  if (token(member.at(-1), ";") || classElementCanEndAtBrace(member))
    return true;
  return (
    leadingLineBreak(next) &&
    beginsClassMember(next) &&
    decoratorPrefixLength(member) !== member.length &&
    lineCanEndAfter(member, classMemberModifiers) &&
    !(hasInitializer(member) && continuesInitializer(next))
  );
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
    const children: Syntax[] = [];
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (classElementEndsBefore(children, next)) break;
      children.push(cursor.consume()!);
      if (classElementCanEndAtBrace(children)) {
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
    const body = classElementCanEndAtBrace(children);
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
 * Modifiers that may open a type member. A line beginning with one of these
 * continues the member being read rather than starting the next.
 */
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

/** How deep in type arguments the end of `nodes` stands. */
function typeArgumentDepth(nodes: readonly Syntax[]): number {
  let depth = 0;
  for (const node of nodes) {
    depth += angles(node, "<");
    depth = Math.max(0, depth - angles(node, ">"));
  }
  return depth;
}

/**
 * Whether `next` begins a new member of an interface or object type after
 * `member`, the syntax of the member read so far: a line break before syntax
 * that begins a member, where the line can end.
 */
function typeMemberEndsBefore(
  member: readonly Syntax[],
  next: Syntax,
): boolean {
  return (
    member.length > 0 &&
    leadingLineBreak(next) &&
    likelyNextTypeMember(next) &&
    lineCanEndAfter(member, typeMemberModifiers)
  );
}

/**
 * Whether `separator` ends the member read so far. A `,` inside type
 * arguments belongs to them: `first: Map<string, number>` is one member.
 */
function separatesTypeMembers(
  member: readonly Syntax[],
  separator: Syntax,
): boolean {
  if (token(separator, ";")) return true;
  return token(separator, ",") && typeArgumentDepth(member) === 0;
}

/**
 * Whether this node can open the next member of an interface or object type.
 * A member is named by an identifier, a keyword used as a name, a string or
 * numeric literal key, or a computed key in brackets; a call signature opens
 * with its parameter list, and a construct signature with `new`.
 */
function likelyNextTypeMember(syntax: Syntax | undefined): boolean {
  if (token(syntax)) {
    return (
      syntax.kind === "identifier" ||
      syntax.kind === "keyword" ||
      syntax.kind === "string-literal" ||
      syntax.kind === "numeric-literal"
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
  const nodes: Syntax[] = [];
  while (!scan.atEnd && !context.stopSet.matches(scan)) {
    checkWork(context);
    const next = scan.peek()!;
    if (typeMemberEndsBefore(nodes, next)) break;
    nodes.push(scan.consume()!);
    if (token(next, ";")) break;
  }
  return nodes;
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
    const children: Syntax[] = [];
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (typeMemberEndsBefore(children, next)) break;
      const separates = separatesTypeMembers(children, next);
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
