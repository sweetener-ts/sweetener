import {
  createGroup,
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  type GroupSyntax,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
  type SyntaxCursor,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  createConsumerFailure,
  type ConsumerAttempt,
  type ConsumerContext,
  type SyntaxConsumer,
  type MacroExtentResolver,
} from "./consumer.js";
import {
  createPrattExpressionConsumer,
  type PrattExpressionConsumerOptions,
} from "./pratt-expression.js";
import { StopSet } from "./stop-set.js";
import {
  bindingMacroResolver,
  createBindingConsumer,
} from "./binding-parameter.js";
import {
  createClassElementConsumer,
  createTypeConsumers,
} from "./type-class-element.js";

export type StatementItemMacroResolver = MacroExtentResolver;

export interface StatementItemConsumerOptions extends PrattExpressionConsumerOptions {
  readonly resolveMacro?: StatementItemMacroResolver | undefined;
  /**
   * Reports a statement operator standing in this run. Such a statement often
   * reads as ordinary TypeScript too — `a <- b` is a comparison against a
   * negation — so enforesting it would commit to that reading before the
   * operator was ever offered the statement.
   */
  readonly holdsStatementOperator?:
    ((children: readonly Syntax[]) => boolean) | undefined;
}

const statementStarts = new Set([
  "abstract",
  "async",
  "await",
  "break",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "do",
  "enum",
  "export",
  "for",
  "function",
  "if",
  "import",
  "interface",
  "let",
  "namespace",
  "operator",
  "rec",
  "return",
  "switch",
  "syntax",
  "throw",
  "try",
  "type",
  "var",
  "using",
  "while",
  "with",
]);

const itemStarts = new Set([
  "abstract",
  "await",
  "class",
  "const",
  "declare",
  "enum",
  "export",
  "function",
  "import",
  "interface",
  "let",
  "module",
  "namespace",
  "operator",
  "rec",
  "syntax",
  "type",
  "var",
  "using",
]);

const blockItemHeads = new Set([
  "class",
  "enum",
  "function",
  "interface",
  "module",
  "namespace",
  "operator",
  "rec",
  "syntax",
]);

function raw(syntax: Syntax | undefined): string | undefined {
  return syntax?.tag === "token" ? syntax.raw : undefined;
}

function token(
  syntax: Syntax | undefined,
  spelling: string,
): syntax is TokenSyntax {
  return syntax?.tag === "token" && syntax.raw === spelling;
}

function braceGroup(syntax: Syntax | undefined): boolean {
  return syntax?.tag === "group" && syntax.delimiter === "brace";
}

/**
 * Whether a declaration's scanned head marks a generator, so that its body
 * admits `yield`. The star follows `function` for a declaration and precedes
 * the name for a class method.
 */
function declaresGenerator(children: readonly Syntax[]): boolean {
  return children.some(
    (node, index) =>
      token(node, "*") &&
      children.slice(0, index).every((prior) => prior.tag === "token"),
  );
}

function leadingLineBreak(syntax: Syntax | undefined): boolean {
  const first = syntax?.tag === "group" ? syntax.open : syntax;
  return (
    first?.tag === "token" &&
    first.leadingTrivia.some((trivia) => trivia.hasLineBreak)
  );
}

function originFor(origins: OriginStore, children: readonly Syntax[]) {
  const unique = [...new Set(children.map(({ origin }) => origin))];
  return unique.length === 1 ? unique[0]! : origins.composed(unique);
}

function protect(
  category: SyntaxCategory,
  options: StatementItemConsumerOptions,
  children: readonly Syntax[],
): ProtectedSyntax {
  const first = children[0];
  const last = children.at(-1);
  if (first === undefined || last === undefined) {
    throw new RangeError(`Cannot protect an empty ${category}`);
  }
  return createProtectedSyntax({
    id: options.allocateSyntaxId(),
    span: {
      start: Math.min(...children.map(({ span }) => span.start)),
      end: Math.max(...children.map(({ span }) => span.end)),
    },
    origin: originFor(options.origins, children),
    scopes: first.scopes,
    category,
    children,
  });
}

function failure(
  category: "stmt" | "item",
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

function checkWork(context: ConsumerContext): void {
  context.cancellation.throwIfCancellationRequested();
  context.tracker.checkDeadline();
  context.tracker.chargeMatcherSteps();
}

function validateMacroAttempt(
  attempt: ConsumerAttempt,
  category: "stmt" | "item",
  start: number,
): ConsumerAttempt {
  if (
    attempt.matched &&
    (attempt.syntax.category !== category || attempt.cursor.index <= start)
  ) {
    throw new TypeError(
      `Macro ${category} resolver returned an invalid protected extent`,
    );
  }
  return attempt;
}

function consumeExplicitSemicolon(
  cursor: SyntaxCursor,
  children: Syntax[],
): boolean {
  if (!token(cursor.peek(), ";")) return false;
  children.push(cursor.consume()!);
  return true;
}

function asiAllowed(cursor: SyntaxCursor): boolean {
  return cursor.atEnd || leadingLineBreak(cursor.peek());
}

function requireTerminator(
  category: "stmt" | "item",
  cursor: SyntaxCursor,
  start: number,
  children: Syntax[],
): ConsumerAttempt | undefined {
  if (consumeExplicitSemicolon(cursor, children) || asiAllowed(cursor)) {
    return undefined;
  }
  return failure(category, cursor, start, ["';' or automatic terminator"], 30);
}

function consumeHeaderGroup(cursor: SyntaxCursor, children: Syntax[]): boolean {
  const header = cursor.peek();
  if (header?.tag !== "group" || header.delimiter !== "parenthesis") {
    return false;
  }
  children.push(cursor.consume()!);
  return true;
}

class StatementConsumer implements SyntaxConsumer {
  readonly #expression: SyntaxConsumer;

  constructor(readonly options: StatementItemConsumerOptions) {
    this.#expression = createPrattExpressionConsumer({
      ...options,
      allowComma: true,
    });
    Object.freeze(this);
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    // Input that is already a statement, such as a replacement enforested on
    // its way into expansion, is taken as-is instead of re-parsed.
    const enforested = cursor.peek();
    if (enforested?.tag === "protected" && enforested.category === "stmt") {
      cursor.advance();
      return Object.freeze({ matched: true, syntax: enforested, cursor });
    }
    const macro = this.options.resolveMacro?.("stmt", cursor, context);
    if (macro !== undefined) return validateMacroAttempt(macro, "stmt", start);
    const first = cursor.peek();
    if (first === undefined || context.stopSet.matches(cursor)) {
      return failure("stmt", cursor, start, ["statement"], 1);
    }
    if (token(first, "@")) {
      const children: Syntax[] = [];
      while (token(cursor.peek(), "@")) {
        children.push(cursor.consume()!);
        const decorator = this.#expression.consume(cursor, {
          ...context,
          category: "expr",
          stopSet: StopSet.empty,
        });
        if (!decorator.matched)
          return failure("stmt", cursor, start, ["decorator expression"], 35);
        children.push(decorator.syntax);
      }
      const declaration = this.consume(cursor, context);
      if (!declaration.matched) return declaration;
      children.push(declaration.syntax);
      return Object.freeze({
        matched: true,
        syntax: protect("stmt", this.options, children),
        cursor,
      });
    }
    if (first.tag === "group" && first.delimiter === "brace") {
      cursor.advance();
      return Object.freeze({
        matched: true,
        syntax: protect("stmt", this.options, [
          this.enforestBlock(first, context),
        ]),
        cursor,
      });
    }
    if (token(first, ";")) {
      cursor.advance();
      return Object.freeze({
        matched: true,
        syntax: protect("stmt", this.options, [first]),
        cursor,
      });
    }
    const keyword = raw(first);
    if ((first as Syntax).tag === "token" && token(cursor.peek(1), ":")) {
      const children = [cursor.consume()!, cursor.consume()!];
      const body = this.#consumeNested(cursor, context);
      if (!body.matched) return body;
      children.push(body.syntax);
      return Object.freeze({
        matched: true,
        syntax: protect("stmt", this.options, children),
        cursor,
      });
    }
    if (keyword === "if") return this.#consumeIf(cursor, context, start);
    if (keyword === "do") return this.#consumeDo(cursor, context, start);
    if (keyword === "try") return this.#consumeTry(cursor, context, start);
    if (["for", "while", "with"].includes(keyword ?? "")) {
      return this.#consumeHeaderAndBody(cursor, context, start);
    }
    if (keyword === "switch")
      return this.#consumeSwitch(cursor, context, start);
    if (
      ["return", "throw", "break", "continue", "debugger"].includes(
        keyword ?? "",
      )
    ) {
      return this.#consumeRestricted(cursor, context, start, keyword!);
    }
    if (
      ["const", "let", "var", "using"].includes(keyword ?? "") ||
      (keyword === "await" && raw(cursor.peek(1)) === "using")
    ) {
      return this.#consumeVariable(
        cursor,
        context,
        start,
        keyword === "await" ? 2 : 1,
      );
    }
    if (
      [
        "function",
        "class",
        "enum",
        "interface",
        "namespace",
        "module",
        "operator",
        "rec",
        "syntax",
      ].includes(keyword ?? "")
    ) {
      // Only a function or namespace body is a statement list. A class, enum,
      // or interface body is a member list and needs its own consumer, so it
      // stays opaque here.
      const statementBody = ["function", "namespace", "module"].includes(
        keyword ?? "",
      );
      return this.#consumeScanned(cursor, context, start, true, statementBody);
    }
    return this.#consumeExpression(cursor, context, start);
  }

  #consumeNested(
    cursor: SyntaxCursor,
    context: ConsumerContext,
  ): ConsumerAttempt {
    return this.consume(cursor, context);
  }

  /**
   * Enforest a brace-delimited block as a statement list.
   *
   * Without this the block is carried through as an opaque token tree, and the
   * expander only ever walks its raw children under the enclosing category.
   * That let a statement macro at the head of a block expand while every macro
   * in an expression position inside the block was silently left alone.
   *
   * A block whose contents do not enforest is returned unchanged rather than
   * failing the enclosing statement: the block may hold syntax this consumer
   * does not model, and TypeScript reports anything genuinely malformed.
   */
  enforestBlock(
    block: GroupSyntax,
    context: ConsumerContext,
    allowYield?: boolean,
  ): Syntax {
    if (block.children.length === 0) return block;
    if (this.options.holdsStatementOperator?.(block.children) === true)
      return block;
    let inner = createSyntaxCursor(block.children);
    const statements: Syntax[] = [];
    const blockContext = Object.freeze({
      ...context,
      category: "stmt" as const,
      // Stop tokens belong to the enclosing construct; inside the braces the
      // statement list runs to the closing delimiter.
      stopSet: StopSet.empty,
      // `yield` is only a statement inside a generator. Inheriting the
      // enclosing permission would fail to enforest a generator body reached
      // from a non-generator context, which silently skips expansion there.
      ...(allowYield === undefined ? {} : { allowYield }),
    });
    while (!inner.atEnd) {
      const before = inner.index;
      const attempt = this.consume(inner, blockContext);
      if (!attempt.matched || attempt.cursor.index <= before) return block;
      statements.push(attempt.syntax);
      // The macro-resolver path returns a fresh cursor rather than advancing
      // the one it was given, so the result must be threaded through.
      inner = attempt.cursor;
    }
    return createGroup({
      ...block,
      id: this.options.allocateSyntaxId(),
      children: createSyntaxSequence(statements),
    });
  }

  #consumeIf(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt {
    const children: Syntax[] = [cursor.consume()!];
    if (!consumeHeaderGroup(cursor, children)) {
      return failure("stmt", cursor, start, ["parenthesized if condition"], 40);
    }
    const consequent = this.#consumeNested(cursor, context);
    if (!consequent.matched) return consequent;
    children.push(consequent.syntax);
    if (token(cursor.peek(), "else")) {
      children.push(cursor.consume()!);
      const alternate = this.#consumeNested(cursor, context);
      if (!alternate.matched) return alternate;
      children.push(alternate.syntax);
    }
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #consumeHeaderAndBody(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt {
    const keyword = cursor.consume()!;
    const children: Syntax[] = [keyword];
    if (!consumeHeaderGroup(cursor, children)) {
      return failure(
        "stmt",
        cursor,
        start,
        [`parenthesized ${raw(keyword)} header`],
        40,
      );
    }
    const body = this.#consumeNested(cursor, context);
    if (!body.matched) return body;
    children.push(body.syntax);
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #consumeSwitch(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt {
    const children: Syntax[] = [cursor.consume()!];
    if (!consumeHeaderGroup(cursor, children)) {
      return failure(
        "stmt",
        cursor,
        start,
        ["parenthesized switch expression"],
        40,
      );
    }
    const body = cursor.peek();
    if (body?.tag !== "group" || body.delimiter !== "brace") {
      return failure("stmt", cursor, start, ["switch block"], 40);
    }
    cursor.advance();
    children.push(this.#enforestSwitchBody(body, context));
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #enforestSwitchBody(
    body: GroupSyntax,
    context: ConsumerContext,
  ): GroupSyntax {
    let cursor = createSyntaxCursor(body.children);
    const children: Syntax[] = [];
    const statementContext = Object.freeze({
      ...context,
      category: "stmt" as const,
      stopSet: StopSet.empty,
    });
    while (!cursor.atEnd) {
      const clause = raw(cursor.peek());
      if (clause !== "case" && clause !== "default") return body;
      children.push(cursor.consume()!);
      if (clause === "case") {
        const expression = this.#expression.consume(cursor, {
          ...context,
          category: "expr",
          stopSet: new StopSet([{ kind: "token", raw: ":" }]),
        });
        if (!expression.matched) return body;
        children.push(expression.syntax);
      }
      if (!token(cursor.peek(), ":")) return body;
      children.push(cursor.consume()!);
      while (
        !cursor.atEnd &&
        raw(cursor.peek()) !== "case" &&
        raw(cursor.peek()) !== "default"
      ) {
        const before = cursor.index;
        const statement = this.consume(cursor, statementContext);
        if (!statement.matched || statement.cursor.index <= before) return body;
        children.push(statement.syntax);
        cursor = statement.cursor;
      }
    }
    return createGroup({
      ...body,
      id: this.options.allocateSyntaxId(),
      children: createSyntaxSequence(children),
    });
  }

  #consumeDo(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt {
    const children: Syntax[] = [cursor.consume()!];
    const body = this.#consumeNested(cursor, context);
    if (!body.matched) return body;
    children.push(body.syntax);
    if (!token(cursor.peek(), "while")) {
      return failure("stmt", cursor, start, ["'while' after do body"], 40);
    }
    children.push(cursor.consume()!);
    if (!consumeHeaderGroup(cursor, children)) {
      return failure(
        "stmt",
        cursor,
        start,
        ["parenthesized do-while condition"],
        40,
      );
    }
    const terminator = requireTerminator("stmt", cursor, start, children);
    if (terminator !== undefined) return terminator;
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #consumeTry(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt {
    const children: Syntax[] = [cursor.consume()!];
    const body = cursor.peek();
    if (body?.tag !== "group" || body.delimiter !== "brace") {
      return failure("stmt", cursor, start, ["try block"], 40);
    }
    cursor.advance();
    children.push(this.enforestBlock(body, context));
    let handler = false;
    if (token(cursor.peek(), "catch")) {
      handler = true;
      children.push(cursor.consume()!);
      const parameter = cursor.peek();
      if (parameter?.tag === "group" && parameter.delimiter === "parenthesis") {
        children.push(cursor.consume()!);
      }
      const catchBody = cursor.peek();
      if (catchBody?.tag !== "group" || catchBody.delimiter !== "brace") {
        return failure("stmt", cursor, start, ["catch block"], 40);
      }
      cursor.advance();
      children.push(this.enforestBlock(catchBody, context));
    }
    if (token(cursor.peek(), "finally")) {
      handler = true;
      children.push(cursor.consume()!);
      const finallyBody = cursor.peek();
      if (finallyBody?.tag !== "group" || finallyBody.delimiter !== "brace") {
        return failure("stmt", cursor, start, ["finally block"], 40);
      }
      cursor.advance();
      children.push(this.enforestBlock(finallyBody, context));
    }
    if (!handler)
      return failure("stmt", cursor, start, ["catch or finally clause"], 40);
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #consumeRestricted(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
    keyword: string,
  ): ConsumerAttempt {
    const children: Syntax[] = [cursor.consume()!];
    const separated = leadingLineBreak(cursor.peek());
    if (keyword === "throw" && separated) {
      return failure(
        "stmt",
        cursor,
        start,
        ["expression on the same line as 'throw'"],
        50,
      );
    }
    if (
      !["debugger"].includes(keyword) &&
      !separated &&
      !token(cursor.peek(), ";") &&
      !cursor.atEnd
    ) {
      const expressionContext = Object.freeze({
        ...context,
        stopSet: context.stopSet.union(
          new StopSet([{ kind: "token", raw: ";" }]),
        ),
      });
      const expression = this.#expression.consume(cursor, expressionContext);
      if (!expression.matched) {
        if (keyword === "throw")
          return failure(
            "stmt",
            cursor,
            start,
            ["expression after 'throw'"],
            50,
          );
      } else children.push(expression.syntax);
    } else if (keyword === "throw") {
      return failure("stmt", cursor, start, ["expression after 'throw'"], 50);
    }
    const terminator = requireTerminator("stmt", cursor, start, children);
    if (terminator !== undefined) return terminator;
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  /**
   * `const`/`let`/`var` in statement position.
   *
   * The declarator head is scanned rather than parsed, but the initializer is
   * enforested as an expression so that macros can be invoked there. Scanning
   * the whole declaration, as this previously did, meant `const a = m(x);`
   * inside any block never saw its expression macros expanded, while the same
   * declaration at module level did.
   */
  #consumeVariable(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
    headWidth = 1,
  ): ConsumerAttempt {
    const children: Syntax[] = [];
    for (let index = 0; index < headWidth; index += 1)
      children.push(cursor.consume()!);
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (token(next, ";")) break;
      if (token(next, "=")) {
        children.push(cursor.consume()!);
        const expression = this.#expression.consume(cursor, {
          ...context,
          category: "expr",
          stopSet: context.stopSet.union(
            new StopSet(
              [",", ";"].map((value) => ({
                kind: "token" as const,
                raw: value,
              })),
            ),
          ),
        });
        if (!expression.matched)
          return failure("stmt", cursor, start, ["variable initializer"], 40);
        children.push(expression.syntax);
        continue;
      }
      if (
        children.length > 1 &&
        leadingLineBreak(next) &&
        statementStarts.has(raw(next) ?? "")
      )
        break;
      children.push(cursor.consume()!);
    }
    const terminator = requireTerminator("stmt", cursor, start, children);
    if (terminator !== undefined) return terminator;
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #consumeScanned(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
    endsAtBlock: boolean,
    statementBody = false,
  ): ConsumerAttempt {
    const children: Syntax[] = [];
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (
        children.length > 0 &&
        leadingLineBreak(next) &&
        statementStarts.has(raw(next) ?? "")
      )
        break;
      cursor.advance();
      if (endsAtBlock && next.tag === "group" && next.delimiter === "brace") {
        children.push(
          statementBody
            ? this.enforestBlock(next, context, declaresGenerator(children))
            : next,
        );
        break;
      }
      children.push(next);
      if (token(next, ";")) break;
    }
    if (
      endsAtBlock &&
      !token(children.at(-1), ";") &&
      !braceGroup(children.at(-1))
    ) {
      return failure("stmt", cursor, start, ["declaration body"], 40);
    }
    if (!endsAtBlock && !token(children.at(-1), ";") && !asiAllowed(cursor)) {
      return failure("stmt", cursor, start, ["declaration terminator"], 30);
    }
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }

  #consumeExpression(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt {
    const expressionContext = Object.freeze({
      ...context,
      stopSet: context.stopSet.union(
        new StopSet([{ kind: "token", raw: ";" }]),
      ),
    });
    const expression = this.#expression.consume(cursor, expressionContext);
    if (!expression.matched) {
      return failure(
        "stmt",
        cursor,
        start,
        expression.failure.expectations,
        expression.failure.specificity,
      );
    }
    const children: Syntax[] = [expression.syntax];
    const terminator = requireTerminator("stmt", cursor, start, children);
    if (terminator !== undefined) return terminator;
    return Object.freeze({
      matched: true,
      syntax: protect("stmt", this.options, children),
      cursor,
    });
  }
}

class ItemConsumer implements SyntaxConsumer {
  readonly #classElement: SyntaxConsumer;
  readonly #typeMember: SyntaxConsumer;
  readonly #statement: StatementConsumer;
  readonly #expression: SyntaxConsumer;
  readonly #binding: SyntaxConsumer;
  readonly #type: SyntaxConsumer;

  constructor(readonly options: StatementItemConsumerOptions) {
    this.#statement = new StatementConsumer(options);
    this.#expression = createPrattExpressionConsumer({
      ...options,
      allowComma: false,
    });
    const shared = {
      origins: options.origins,
      allocateSyntaxId: options.allocateSyntaxId,
    };
    this.#binding = createBindingConsumer({
      ...shared,
      ...(options.resolveMacro === undefined
        ? {}
        : { resolveMacro: bindingMacroResolver(options.resolveMacro) }),
    });
    const typeConsumers = createTypeConsumers({
      ...shared,
      ...(options.resolveMacro === undefined
        ? {}
        : { resolveTypeMemberMacro: options.resolveMacro }),
    });
    this.#type = typeConsumers.type;
    this.#classElement = createClassElementConsumer({
      ...shared,
      enforestStatementBlock: (block, blockContext) =>
        this.#statement.enforestBlock(block, blockContext),
    });
    // Like the class-element consumer, this one is not given a macro
    // resolver: a member macro is dispatched by the expander when it walks the
    // protected body, not while the body is first read.
    this.#typeMember = typeConsumers.typeMember;
    Object.freeze(this);
  }

  /**
   * Enforest a class body as a list of class elements.
   *
   * Protecting the raw body as `classElement`, as this previously did, never
   * ran the element consumer over it, so a method body was never reached and
   * macros inside methods were left unexpanded.
   *
   * A body that does not enforest is returned unchanged; TypeScript reports
   * anything genuinely malformed.
   */
  #enforestClassBody(body: GroupSyntax, context: ConsumerContext): Syntax {
    if (body.children.length === 0) return body;
    let inner = createSyntaxCursor(body.children);
    const elements: Syntax[] = [];
    const elementContext = Object.freeze({
      ...context,
      category: "classElement" as const,
      stopSet: StopSet.empty,
    });
    while (!inner.atEnd) {
      const before = inner.index;
      const attempt = this.#classElement.consume(inner, elementContext);
      if (!attempt.matched || attempt.cursor.index <= before) return body;
      elements.push(attempt.syntax);
      inner = attempt.cursor;
    }
    return createGroup({
      ...body,
      id: this.options.allocateSyntaxId(),
      children: createSyntaxSequence(elements),
    });
  }

  /**
   * Enforest an interface body as a list of type members.
   *
   * Without this the body stays an opaque token tree and the expander walks
   * its children under the enclosing item category, where a macro written
   * among the members resolves as an item, produces members, and is reported
   * as having expanded to something that is not one item.
   *
   * A body that does not enforest is returned unchanged; TypeScript reports
   * anything genuinely malformed.
   */
  #enforestTypeMembers(body: GroupSyntax, context: ConsumerContext): Syntax {
    if (body.children.length === 0) return body;
    let inner = createSyntaxCursor(body.children);
    const members: Syntax[] = [];
    const memberContext = Object.freeze({
      ...context,
      category: "typeMember" as const,
      stopSet: StopSet.empty,
    });
    while (!inner.atEnd) {
      const before = inner.index;
      const attempt = this.#typeMember.consume(inner, memberContext);
      if (!attempt.matched || attempt.cursor.index <= before) return body;
      members.push(attempt.syntax);
      inner = attempt.cursor;
    }
    return createGroup({
      ...body,
      id: this.options.allocateSyntaxId(),
      children: createSyntaxSequence(members),
    });
  }

  #consumeVariable(
    cursor: SyntaxCursor,
    context: ConsumerContext,
    start: number,
  ): ConsumerAttempt | undefined {
    const children: Syntax[] = [];
    while (raw(cursor.peek()) === "export" || raw(cursor.peek()) === "declare")
      children.push(cursor.consume()!);
    const declaration = raw(cursor.peek());
    if (declaration === "await" && raw(cursor.peek(1)) === "using") {
      children.push(cursor.consume()!, cursor.consume()!);
    } else if (["const", "let", "var", "using"].includes(declaration ?? "")) {
      children.push(cursor.consume()!);
    } else return undefined;
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      const binding = this.#binding.consume(cursor, {
        ...context,
        category: "binding",
        stopSet: context.stopSet.union(
          new StopSet(
            [":", "=", ",", ";"].map((value) => ({
              kind: "token" as const,
              raw: value,
            })),
          ),
        ),
      });
      if (!binding.matched)
        return failure("item", cursor, start, ["variable binding"], 40);
      children.push(binding.syntax);
      if (token(cursor.peek(), ":")) {
        children.push(cursor.consume()!);
        const type = this.#type.consume(cursor, {
          ...context,
          category: "type",
          stopSet: context.stopSet.union(
            new StopSet(
              ["=", ",", ";"].map((value) => ({
                kind: "token" as const,
                raw: value,
              })),
            ),
          ),
        });
        if (!type.matched)
          return failure("item", cursor, start, ["variable type"], 40);
        children.push(type.syntax);
      }
      if (token(cursor.peek(), "=")) {
        children.push(cursor.consume()!);
        const expression = this.#expression.consume(cursor, {
          ...context,
          category: "expr",
          stopSet: context.stopSet.union(
            new StopSet(
              [",", ";"].map((value) => ({
                kind: "token" as const,
                raw: value,
              })),
            ),
          ),
        });
        if (!expression.matched)
          return failure("item", cursor, start, ["variable initializer"], 40);
        children.push(expression.syntax);
      }
      if (token(cursor.peek(), ",")) {
        children.push(cursor.consume()!);
        continue;
      }
      break;
    }
    const terminator = requireTerminator("item", cursor, start, children);
    if (terminator !== undefined) return terminator;
    return Object.freeze({
      matched: true,
      syntax: protect("item", this.options, children),
      cursor,
    });
  }

  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt {
    const start = cursor.index;
    checkWork(context);
    const protectedItem = cursor.peek();
    if (
      protectedItem?.tag === "protected" &&
      protectedItem.category === "item"
    ) {
      cursor.advance();
      return Object.freeze({
        matched: true,
        syntax: protectedItem,
        cursor,
      });
    }
    const macro = this.options.resolveMacro?.("item", cursor, context);
    if (macro !== undefined) return validateMacroAttempt(macro, "item", start);
    const first = cursor.peek();
    if (first === undefined || context.stopSet.matches(cursor)) {
      return failure("item", cursor, start, ["module item"], 1);
    }
    if (token(first, "@")) {
      const children: Syntax[] = [];
      while (token(cursor.peek(), "@")) {
        children.push(cursor.consume()!);
        const decorator = this.#expression.consume(cursor, {
          ...context,
          category: "expr",
          stopSet: StopSet.empty,
        });
        if (!decorator.matched)
          return failure("item", cursor, start, ["decorator expression"], 35);
        children.push(decorator.syntax);
      }
      const declaration = this.consume(cursor, context);
      if (!declaration.matched) return declaration;
      children.push(declaration.syntax);
      return Object.freeze({
        matched: true,
        syntax: protect("item", this.options, children),
        cursor,
      });
    }
    const variable = this.#consumeVariable(cursor.fork(), context, start);
    if (variable !== undefined) return variable;
    if (itemStarts.has(raw(first) ?? "")) {
      const children: Syntax[] = [];
      // Only this item's own head decides whether it ends at a block. The
      // lookahead used to run a fixed four nodes and so read into whatever
      // followed: `import "./x"` with no semicolon saw the `function` of the
      // next declaration, concluded it was itself a block item, and failed for
      // having no body. Stop where the consumption loop below stops.
      const headWords: string[] = [];
      for (let offset = 0; offset < 4; offset += 1) {
        const node = cursor.peek(offset);
        if (node === undefined) break;
        if (
          offset > 0 &&
          leadingLineBreak(node) &&
          itemStarts.has(raw(node) ?? "")
        )
          break;
        const word = raw(node);
        if (word !== undefined) headWords.push(word);
      }
      const endsAtBlock = headWords.some((word) => blockItemHeads.has(word));
      while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
        checkWork(context);
        const next = cursor.peek()!;
        if (
          children.length > 0 &&
          leadingLineBreak(next) &&
          itemStarts.has(raw(next) ?? "")
        ) {
          break;
        }
        children.push(cursor.consume()!);
        if (token(next, ";")) break;
        if (endsAtBlock && next.tag === "group" && next.delimiter === "brace")
          break;
      }
      if (
        endsAtBlock &&
        braceGroup(children.at(-1)) &&
        token(cursor.peek(), ";")
      ) {
        children.push(cursor.consume()!);
      }
      if (
        endsAtBlock &&
        !token(children.at(-1), ";") &&
        !braceGroup(children.at(-1)) &&
        !braceGroup(children.at(-2))
      ) {
        return failure("item", cursor, start, ["declaration body"], 40);
      }
      if (
        !token(children.at(-1), ";") &&
        children.at(-1)?.tag !== "group" &&
        !asiAllowed(cursor)
      ) {
        return failure("item", cursor, start, ["module-item terminator"], 30);
      }
      const body = token(children.at(-1), ";")
        ? children.at(-2)
        : children.at(-1);
      if (body?.tag === "group" && body.delimiter === "brace") {
        const bodyCategory = headWords.includes("class")
          ? "classElement"
          : headWords.includes("interface")
            ? "typeMember"
            : headWords.includes("function")
              ? "stmt"
              : headWords.includes("module") || headWords.includes("namespace")
                ? "item"
                : undefined;
        if (bodyCategory !== undefined) {
          const bodyIndex = token(children.at(-1), ";")
            ? children.length - 2
            : children.length - 1;
          children[bodyIndex] = protect(bodyCategory, this.options, [
            // A function body is a statement list and a class body is an
            // element list; both are enforested as such. Protecting the raw
            // group instead only let the expander walk its tokens under the
            // body's category, which reached a macro at the head of the body
            // and nothing else.
            bodyCategory === "stmt"
              ? this.#statement.enforestBlock(
                  body,
                  context,
                  declaresGenerator(children),
                )
              : bodyCategory === "classElement"
                ? this.#enforestClassBody(body, context)
                : bodyCategory === "typeMember"
                  ? this.#enforestTypeMembers(body, context)
                  : body,
          ]);
        }
      }
      return Object.freeze({
        matched: true,
        syntax: protect("item", this.options, children),
        cursor,
      });
    }
    const statement = this.#statement.consume(cursor, context);
    if (!statement.matched) {
      return failure(
        "item",
        cursor,
        start,
        statement.failure.expectations,
        statement.failure.specificity,
      );
    }
    return Object.freeze({
      matched: true,
      syntax: protect("item", this.options, [statement.syntax]),
      cursor,
    });
  }
}

/**
 * A statement consumer that can also enforest a brace-delimited statement
 * list. Consumers for other categories that contain statement bodies — class
 * methods, for instance — delegate their bodies here.
 */
export interface StatementBlockConsumer extends SyntaxConsumer {
  enforestBlock(block: GroupSyntax, context: ConsumerContext): Syntax;
}

export function createStatementConsumer(
  options: StatementItemConsumerOptions,
): StatementBlockConsumer {
  return Object.freeze(new StatementConsumer(options));
}

export function createItemConsumer(
  options: StatementItemConsumerOptions,
): SyntaxConsumer {
  return Object.freeze(new ItemConsumer(options));
}
