import type { SyntaxId } from "@sweetener/shared";
import {
  createGroup,
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
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
      ) => Syntax)
    | undefined;
  /**
   * Enforests a brace body as a list of type members. Without it an object
   * type stays an opaque token tree and a member macro written in one never
   * expands, the way `interface` bodies behaved before they were read as
   * member lists.
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

const continuationOperators = new Set(["&", "=>", "extends", "is", "|"]);
const hardTypeStops = new Set([",", ";", "="]);
const continuationLineTokens = new Set([
  ".",
  "&",
  "|",
  "?",
  ":",
  "=",
  "=>",
  ",",
]);
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

function leadingLineBreak(syntax: Syntax | undefined): boolean {
  const first = syntax?.tag === "group" ? syntax.open : syntax;
  return (
    first?.tag === "token" &&
    first.leadingTrivia.some((trivia) => trivia.hasLineBreak)
  );
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

function validateMacro(
  attempt: ConsumerAttempt,
  category: "type" | "classElement" | "typeMember",
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
  return attempt;
}

function angleWidth(raw: string, character: "<" | ">") {
  return [...raw].every((item) => item === character) ? raw.length : 0;
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

class TypeConsumer implements SyntaxConsumer {
  constructor(readonly options: TypeClassConsumerOptions) {
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    const macro = this.options.resolveMacro?.("type", cursor, context);
    if (macro !== undefined) return validateMacro(macro, "type", start);
    const children: Syntax[] = [];
    let expectingOperand = true;
    let conditionalDepth = 0;
    let genericFunctionHead = false;
    let invalidAdjacency = false;

    while (!cursor.atEnd) {
      checkWork(context);
      if (
        children.length > 0 &&
        conditionalDepth === 0 &&
        context.stopSet.matches(cursor)
      )
        break;
      const next = cursor.peek()!;
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
        if (expectingOperand) break;
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

function classElementCanEndAtBrace(children: readonly Syntax[]): boolean {
  const brace = children.at(-1);
  if (brace?.tag !== "group" || brace.delimiter !== "brace") return false;
  const before = children.slice(0, -1);
  if (before.some((item) => token(item, "="))) return false;
  const declaration = before.slice(decoratorPrefixLength(before));
  if (declaration.length === 1 && token(declaration[0], "static")) return true;
  return declaration.some(
    (item) => item.tag === "group" && item.delimiter === "parenthesis",
  );
}

function decoratorPrefixLength(children: readonly Syntax[]): number {
  let index = 0;
  while (token(children[index], "@")) {
    index += 1;
    if (!token(children[index])) return index;
    index += 1;
    while (token(children[index], ".") && token(children[index + 1])) {
      index += 2;
    }
    const arguments_ = children[index];
    if (arguments_?.tag === "group" && arguments_.delimiter === "parenthesis")
      index += 1;
  }
  return index;
}

function likelyNextClassElement(syntax: Syntax | undefined): boolean {
  if (token(syntax)) {
    return (
      syntax.raw === "@" ||
      syntax.kind === "identifier" ||
      syntax.kind === "private-identifier" ||
      syntax.kind === "keyword"
    );
  }
  return syntax?.tag === "group" && syntax.delimiter === "bracket";
}

class ClassElementConsumer implements SyntaxConsumer {
  constructor(readonly options: TypeClassConsumerOptions) {
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    const macro = this.options.resolveMacro?.("classElement", cursor, context);
    if (macro !== undefined) return validateMacro(macro, "classElement", start);
    const decoratorTarget = cursor.peek(1);
    if (
      token(cursor.peek(), "@") &&
      (!token(decoratorTarget) || decoratorTarget.kind !== "identifier")
    ) {
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
      const previous = children.at(-1);
      const onlyDecorators =
        decoratorPrefixLength(children) === children.length;
      if (
        children.length > 0 &&
        leadingLineBreak(next) &&
        likelyNextClassElement(next) &&
        !onlyDecorators &&
        !continuationLineTokens.has(token(previous) ? previous.raw : "") &&
        !classModifiers.has(token(previous) ? previous.raw : "")
      )
        break;
      children.push(cursor.consume()!);
      if (token(next, ";")) break;
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
const typeMemberModifiers = new Set(["readonly", "new", "get", "set"]);

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
    const previous = nodes.at(-1);
    const previousRaw = token(previous) ? previous.raw : "";
    if (
      nodes.length > 0 &&
      leadingLineBreak(next) &&
      likelyNextTypeMember(next) &&
      !continuationLineTokens.has(previousRaw) &&
      !typeMemberModifiers.has(previousRaw)
    )
      break;
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
          validateMacro(macro, "typeMember", 0);
          if (macro.matched) {
            cursor.advance(macro.cursor.index);
            return Object.freeze({
              matched: true,
              syntax: macro.syntax,
              cursor,
            });
          }
          return macro;
        }
      }
    }
    const children: Syntax[] = [];
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      const previous = children.at(-1);
      const previousRaw = token(previous) ? previous.raw : "";
      if (
        children.length > 0 &&
        leadingLineBreak(next) &&
        likelyNextTypeMember(next) &&
        !continuationLineTokens.has(previousRaw) &&
        !typeMemberModifiers.has(previousRaw)
      )
        break;
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
      if (token(next, ";") || token(next, ",")) break;
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
 * a member's own type may be another object type. Building them separately
 * left whichever was built first with no way to reach the other, so a member
 * macro written one level in was never dispatched.
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
