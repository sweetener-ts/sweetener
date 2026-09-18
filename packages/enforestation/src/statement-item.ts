import {
  angleWidth,
  createGroup,
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  leadingLineBreak,
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
import { operandExpectedAfter } from "./core-operators.js";
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
  consumeBalancedTypeArguments,
  createTypeConsumers,
  declaresAsync,
  decoratorWidth,
  typeOperandExpectedAfter,
  typeOperandFollows,
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

/**
 * What may stand after a declarator's binder, so that a line break in front of
 * it carries the declaration on: the `:` that opens an annotation, the `=`
 * that opens an initializer, and the `,` and `;` that end the declarator.
 *
 * The `!` of a definite assignment is not among them. TypeScript writes
 * `BindingIdentifier [no LineTerminator here] !`, and reads `let x` and the
 * `!: A = 1;` under it as two statements.
 */
const headContinuedBy = new Set([":", "=", ",", ";"]);

/**
 * What may carry a declarator's type annotation on across a line break: the
 * operators the type grammar writes between two types, and what ends the
 * annotation.
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
const annotationContinuedBy = new Set([
  "|",
  "&",
  "?",
  ":",
  ",",
  "=>",
  ".",
  "=",
  ";",
  "is",
]);

/**
 * Whether the declarator head read so far carries on across the line break in
 * front of `next`. It does where an operand is still expected after what was
 * last read, and where `next` is one of the few things that may stand in a
 * head at all -- inside the annotation, one of the few that may stand in a
 * type.
 *
 * Inside the annotation both halves are the type grammar's: a line cannot end
 * after `keyof`, `infer` or `extends` any more than after `|`, and it is the
 * type reader that says so.
 *
 * This is the one question both readers of a declaration ask. The statement
 * reader walks the head and asks it at each line break; the item reader asks
 * it of the annotation before handing it to the type consumer, which reads a
 * type wherever it is written and would otherwise read straight past the
 * break.
 */
function headContinues(
  previous: Syntax | undefined,
  next: Syntax,
  annotated: boolean,
): boolean {
  const expectsOperand = annotated
    ? typeOperandExpectedAfter
    : operandExpectedAfter;
  if (previous?.tag === "token" && expectsOperand.has(previous.raw))
    return true;
  if (next.tag !== "token") return false;
  return annotated
    ? annotationContinuedBy.has(next.raw)
    : headContinuedBy.has(next.raw);
}

/**
 * Whether the `!` of a definite assignment stands at `next`, the binder it
 * marks having just been read.
 *
 * TypeScript writes `BindingIdentifier [no LineTerminator here] ! : Type`, so
 * a `!` is the marker only where it is written on the binder's own line. The
 * line break is the whole of the rule, and both readers of a declaration ask
 * it here rather than each deciding for itself: the statement reader takes the
 * `!` into the head it is walking, the item reader takes it between the
 * binding it parsed and the annotation it measures.
 */
function definiteAssignment(next: Syntax | undefined): boolean {
  return token(next, "!") && !leadingLineBreak(next);
}

/**
 * Whether the `const` at the cursor opens a declarator, rather than being the
 * `const` of `const enum`.
 *
 * `const enum E {}` is an enum declaration; the word after the `const` is the
 * keyword `enum`, not a binder. A reader that takes every `const` for a
 * variable declaration reads `enum` as the name it is declaring -- which the
 * statement reader survives only because it scans its head, while the item
 * reader parses one and refused the whole declaration.
 */
function declaresVariable(cursor: SyntaxCursor): boolean {
  return !(raw(cursor.peek()) === "const" && raw(cursor.peek(1)) === "enum");
}

/**
 * How many nodes the type annotation standing at the cursor may span before a
 * line break ends the declarator's head, `colon` being the `:` that opened it.
 *
 * A `<` still open encloses whatever is written under it, so
 * `let x: Array<\nnumber\n>` is one annotation however its lines are broken --
 * the same allowance the statement reader makes as it walks a head.
 */
function annotationExtent(
  cursor: SyntaxCursor,
  colon: Syntax,
  context: ConsumerContext,
): number {
  let typeArguments = 0;
  let width = 0;
  while (width < cursor.remainingLength) {
    checkWork(context);
    const next = cursor.peek(width)!;
    const previous = width === 0 ? colon : cursor.peek(width - 1)!;
    if (
      typeArguments === 0 &&
      leadingLineBreak(next) &&
      !headContinues(previous, next, true)
    )
      break;
    const spelling = raw(next);
    if (spelling !== undefined) {
      typeArguments += angleWidth(spelling, "<");
      typeArguments = Math.max(0, typeArguments - angleWidth(spelling, ">"));
    }
    width += 1;
  }
  return width;
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

/**
 * The decorator at the cursor, as `@` and the expression it applies, advancing
 * past it; undefined, with the cursor unmoved, where no well-formed decorator
 * begins. Its extent is TypeScript's decorator grammar, and the expression in
 * it is enforested so a macro written there is reached.
 */
function consumeDecorator(
  expression: SyntaxConsumer,
  cursor: SyntaxCursor,
  context: ConsumerContext,
): readonly Syntax[] | undefined {
  const width = decoratorWidth((offset) => cursor.peek(offset));
  if (width === undefined) return undefined;
  const nodes = Array.from({ length: width }, (_, offset) =>
    cursor.peek(offset)!,
  );
  const applied = createSyntaxCursor(createSyntaxSequence(nodes.slice(1)));
  const attempt = expression.consume(applied, {
    ...context,
    category: "expr",
    stopSet: StopSet.empty,
  });
  if (!attempt.matched || !attempt.cursor.atEnd) return undefined;
  cursor.advance(width);
  return [nodes[0]!, attempt.syntax];
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

/**
 * The refusal a statement head spelled with `await` gets where `await` is not
 * an expression: the same one the `await` operator reports, because it is the
 * same rule -- TypeScript allows each only inside an async function and at the
 * top level of a module.
 */
function awaitRefusal(
  category: "stmt" | "item",
  cursor: SyntaxCursor,
  start: number,
): ConsumerAttempt {
  return failure(
    category,
    cursor,
    start,
    ["await inside an async function"],
    9,
  );
}

function checkWork(context: ConsumerContext): void {
  context.cancellation.throwIfCancellationRequested();
  context.tracker.checkDeadline();
  context.tracker.chargeMatcherSteps();
}

/**
 * Takes a macro's extent, leaving `cursor` just past it.
 *
 * A macro is measured on a fork and answers with that fork, while every other
 * reading here answers with the cursor it was given, advanced. A caller that
 * reads on after a nested reading -- the unbraced body of a `while`, the
 * declaration a decorator stands in front of -- reads from the cursor it
 * passed down, so the extent has to be carried onto it. Left behind, the
 * cursor still stood at the invocation and read it a second time: the
 * statement after `while (c) log(x);` was the invocation again, and its
 * expansion was emitted twice.
 */
function validateMacroAttempt(
  attempt: ConsumerAttempt,
  category: "stmt" | "item",
  cursor: SyntaxCursor,
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
  if (!attempt.matched || attempt.cursor === cursor) return attempt;
  if (attempt.cursor.index < cursor.index) {
    throw new TypeError(
      `Macro ${category} resolver returned an extent behind the cursor`,
    );
  }
  cursor.advance(attempt.cursor.index - cursor.index);
  return Object.freeze({ ...attempt, cursor });
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
    if (macro !== undefined)
      return validateMacroAttempt(macro, "stmt", cursor, start);
    const first = cursor.peek();
    if (first === undefined || context.stopSet.matches(cursor)) {
      return failure("stmt", cursor, start, ["statement"], 1);
    }
    if (token(first, "@")) {
      const children: Syntax[] = [];
      while (token(cursor.peek(), "@")) {
        const decorator = consumeDecorator(this.#expression, cursor, context);
        if (decorator === undefined)
          return failure("stmt", cursor, start, ["decorator expression"], 35);
        children.push(...decorator);
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
    if (keyword === "await" && raw(cursor.peek(1)) === "using") {
      // `await using` suspends the function it is written in, so it stands
      // only where `await` is an expression.
      if (!context.allowAwait) return awaitRefusal("stmt", cursor, start);
      return this.#consumeVariable(cursor, context, start, 2);
    }
    // What this declaration declares, which for `const enum` is an enum: its
    // body is a member list rather than an initializer, and the word after the
    // `const` is a keyword rather than a binder.
    const declared = declaresVariable(cursor) ? keyword : "enum";
    if (["const", "let", "var", "using"].includes(declared ?? "")) {
      return this.#consumeVariable(cursor, context, start, 1);
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
      ].includes(declared ?? "")
    ) {
      // Only a function or namespace body is a statement list. A class, enum,
      // or interface body is a member list and needs its own consumer, so it
      // stays opaque here.
      const statementBody = ["function", "namespace", "module"].includes(
        declared ?? "",
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
   * Takes a control statement's parenthesized header, with the expressions in
   * it read as expressions.
   *
   * Kept as the tokens it was written with, an operator written in a header
   * would never be offered to its rules: `if (x |> f)` and `while (x |> f)`
   * would reach TypeScript with the `|>` still in them, while the same
   * expression one line down expands. A header this cannot read is kept as
   * written, as a block is.
   */
  #consumeHeader(
    cursor: SyntaxCursor,
    children: Syntax[],
    keyword: string,
    context: ConsumerContext,
  ): boolean {
    const header = cursor.peek();
    if (header?.tag !== "group" || header.delimiter !== "parenthesis")
      return false;
    cursor.advance();
    const read =
      keyword === "for"
        ? this.#forHeader(header.children, context)
        : this.#wholeExpression(header.children, context);
    children.push(
      read === undefined
        ? header
        : createGroup({
            ...header,
            id: this.options.allocateSyntaxId(),
            children: createSyntaxSequence(read),
          }),
    );
    return true;
  }

  /** The nodes as one expression, or undefined when they are not one. */
  #wholeExpression(
    nodes: readonly Syntax[],
    context: ConsumerContext,
    allowComma = true,
  ): readonly Syntax[] | undefined {
    if (nodes.length === 0) return nodes;
    const cursor = createSyntaxCursor(createSyntaxSequence(nodes));
    const consumer = allowComma
      ? this.#expression
      : createPrattExpressionConsumer({ ...this.options, allowComma: false });
    const attempt = consumer.consume(cursor, {
      ...context,
      category: "expr",
      stopSet: StopSet.empty,
    });
    return attempt.matched && attempt.cursor.atEnd
      ? [attempt.syntax]
      : undefined;
  }

  /**
   * A `for` header: an initializer, a test and an update between its own `;`
   * tokens, or a binding and the object a `for...in` or `for...of` walks.
   */
  #forHeader(
    nodes: readonly Syntax[],
    context: ConsumerContext,
  ): readonly Syntax[] | undefined {
    const pieces: Syntax[][] = [[]];
    const separators: Syntax[] = [];
    for (const node of nodes)
      if (token(node, ";")) {
        separators.push(node);
        pieces.push([]);
      } else pieces.at(-1)!.push(node);
    if (pieces.length === 3) {
      const [initializer, test, update] = pieces as [
        Syntax[],
        Syntax[],
        Syntax[],
      ];
      const head = raw(initializer[0]);
      const declared =
        head === "const" ||
        head === "let" ||
        head === "var" ||
        head === "using" ||
        (head === "await" && raw(initializer[1]) === "using")
          ? this.#declarators(initializer, context)
          : this.#wholeExpression(initializer, context);
      const readTest = this.#wholeExpression(test, context);
      const readUpdate = this.#wholeExpression(update, context);
      if (
        declared === undefined ||
        readTest === undefined ||
        readUpdate === undefined
      )
        return undefined;
      return [
        ...declared,
        separators[0]!,
        ...readTest,
        separators[1]!,
        ...readUpdate,
      ];
    }
    if (pieces.length !== 1) return undefined;
    // What a `for...of` or `for...in` walks follows the first `of` or `in`
    // after its binding.
    const split = nodes.findIndex(
      (node, at) => at > 0 && (token(node, "of") || token(node, "in")),
    );
    if (split < 0) return undefined;
    const iterable = this.#wholeExpression(
      nodes.slice(split + 1),
      context,
      token(nodes[split], "in"),
    );
    return iterable === undefined
      ? undefined
      : [...nodes.slice(0, split + 1), ...iterable];
  }

  /** A declaration list with each initializer read as an expression. */
  #declarators(
    nodes: readonly Syntax[],
    context: ConsumerContext,
  ): readonly Syntax[] | undefined {
    const cursor = createSyntaxCursor(createSyntaxSequence(nodes));
    const children: Syntax[] = [];
    while (!cursor.atEnd) {
      const next = cursor.consume()!;
      children.push(next);
      if (!token(next, "=")) continue;
      const initializer = this.#expression.consume(cursor, {
        ...context,
        category: "expr",
        stopSet: new StopSet([{ kind: "token", raw: "," }]),
      });
      if (!initializer.matched) return undefined;
      children.push(initializer.syntax);
    }
    return children;
  }

  /**
   * Enforest a brace-delimited block as a statement list.
   *
   * Without this the block is carried through as an opaque token tree, and the
   * expander only ever walks its raw children under the enclosing category.
   * That lets a statement macro at the head of a block expand while every macro
   * in an expression position inside the block is silently left alone.
   *
   * A block whose contents do not enforest is returned unchanged rather than
   * failing the enclosing statement: the block may hold syntax this consumer
   * does not model, and TypeScript reports anything genuinely malformed.
   */
  enforestBlock(
    block: GroupSyntax,
    context: ConsumerContext,
    allowYield: boolean = context.allowYield,
    allowAwait: boolean = context.allowAwait,
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
      // `yield` is only an expression inside a generator, and `await` only
      // inside an async function. A function body says for itself whether it
      // is either; a bare block, or the body of an `if` or a `try`, is inside
      // whatever function holds it and inherits. A generator body reached
      // from a non-generator context that inherited would fail to enforest,
      // and so silently skip expansion there.
      allowYield,
      allowAwait,
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
    if (!this.#consumeHeader(cursor, children, "if", context)) {
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
    // `for await (const item of items)`, which awaits each step and so stands
    // only where `await` is an expression.
    if (token(keyword, "for") && token(cursor.peek(), "await")) {
      if (!context.allowAwait) return awaitRefusal("stmt", cursor, start);
      children.push(cursor.consume()!);
    }
    if (!this.#consumeHeader(cursor, children, raw(keyword)!, context)) {
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
    if (!this.#consumeHeader(cursor, children, "switch", context)) {
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
    if (!this.#consumeHeader(cursor, children, "while", context)) {
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
    // What a `break` or a `continue` names is a label, and a label is not an
    // expression: it lives in a namespace of its own, where no binding reaches
    // and no macro is declared. Read as an expression, a label that happened to
    // spell a macro in scope was dispatched as one and the statement rewritten
    // into whatever the macro produced.
    if (keyword === "break" || keyword === "continue") {
      const label = cursor.peek();
      if (!separated && label?.tag === "token" && label.kind === "identifier") {
        cursor.advance();
        children.push(label);
      }
      const terminated = requireTerminator("stmt", cursor, start, children);
      if (terminated !== undefined) return terminated;
      return Object.freeze({
        matched: true,
        syntax: protect("stmt", this.options, children),
        cursor,
      });
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
      // What follows the keyword on its line belongs to the statement, so a
      // failure to read it is reported for `return` as for `throw`. Carrying on
      // past the tokens the failed attempt read would find the `;` and succeed
      // as `return ;` -- dropping `1 +` from `return 1 + ;` without a word,
      // where TypeScript would have rejected what was written.
      if (!expression.matched)
        return failure(
          "stmt",
          cursor,
          start,
          [
            keyword === "throw" || keyword === "return"
              ? `expression after '${keyword}'`
              : `label after '${keyword}'`,
          ],
          50,
        );
      children.push(expression.syntax);
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
   * the whole declaration would leave `const a = m(x);` inside a block with
   * its expression macros unexpanded, while the same declaration at module
   * level expands.
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
    let initialized = false;
    /** Whether the declarator being read has taken its binder. */
    let bound = false;
    /** Whether it has taken the `:` that opens its type annotation. */
    let annotated = false;
    /**
     * How deep in type arguments the head stands. A `<` still open encloses
     * whatever is written under it, so `let x: Array<\nnumber\n>` is one head
     * however its lines are broken.
     */
    let typeArguments = 0;
    while (!cursor.atEnd && !context.stopSet.matches(cursor)) {
      checkWork(context);
      const next = cursor.peek()!;
      if (token(next, ";")) break;
      // A declarator's head is a binder, the `!` of a definite assignment and
      // a `: type`; nothing else stands in one. So a line break in front of
      // anything else ends the declaration, as it does after an initializer:
      // `let x` and the `foo();` written under it are two statements.
      if (
        bound &&
        typeArguments === 0 &&
        leadingLineBreak(next) &&
        !headContinues(children.at(-1), next, annotated)
      )
        break;
      // A declarator ends where its initializer does, so only another
      // declarator may follow one. Anything else on the next line begins a
      // statement of its own: whatever could have continued the initializer
      // across the line break -- an operator carried over, an unclosed group,
      // a call, a member access -- the expression parse has already taken, so
      // a line break here is where TypeScript ends the declaration too.
      //
      // `const h = async` and the `v => f()` written under it are two
      // statements, the second of them a plain arrow. Read as one, the arrow
      // was swallowed as loose tokens and never measured at all, so its body
      // was left in whatever context held the declaration.
      if (initialized && !token(next, ",") && asiAllowed(cursor)) break;
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
        initialized = true;
        continue;
      }
      initialized = false;
      // The `!` of a definite assignment, taken by the rule the item reader
      // takes it by: it stands in the head where it is written on the binder's
      // own line, and a line break in front of one has ended the declaration
      // above rather than reaching here.
      if (bound && definiteAssignment(next)) {
        children.push(cursor.consume()!);
        continue;
      }
      if (
        children.length > 1 &&
        leadingLineBreak(next) &&
        statementStarts.has(raw(next) ?? "")
      )
        break;
      const spelling = raw(next);
      if (spelling !== undefined) {
        typeArguments += angleWidth(spelling, "<");
        typeArguments = Math.max(0, typeArguments - angleWidth(spelling, ">"));
      }
      if (spelling === ",") {
        bound = false;
        annotated = false;
      } else if (spelling === ":") annotated = true;
      else bound = true;
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
      // A `<...>` region holds type parameters or type arguments, and a brace
      // inside one is an object type: `class E extends make()<{ a: string }>`,
      // or `class C<T extends { a: string }>`. Taking the first brace as the
      // declaration's body would claim that object type as the body and leave
      // the real one behind, so the declaration would not read as one item.
      if (endsAtBlock && next.tag === "token" && isAngleOpen(next.raw)) {
        const region = consumeBalancedTypeArguments(cursor, context);
        if (region !== undefined) {
          for (let taken = 0; taken < region.width; taken += 1)
            children.push(cursor.consume()!);
          continue;
        }
      }
      cursor.advance();
      // A brace where a return type is written is an object type; the body
      // is the brace after the whole type.
      if (
        endsAtBlock &&
        next.tag === "group" &&
        next.delimiter === "brace" &&
        !typeOperandFollows(children.at(-1))
      ) {
        children.push(
          statementBody
            ? this.enforestBlock(
                next,
                context,
                declaresGenerator(children),
                declaresAsync(children),
              )
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

/** Whether a token is one or more `<`, which opens a type-argument region. */
function isAngleOpen(raw: string): boolean {
  return angleWidth(raw, "<") > 0;
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
      enforestStatementBlock: (block, blockContext, allowYield, allowAwait) =>
        this.#statement.enforestBlock(
          block,
          blockContext,
          allowYield,
          allowAwait,
        ),
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
   * Protecting the raw body as `classElement` would never run the element
   * consumer over it, so a method body would never be reached and macros
   * inside methods would be left unexpanded.
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
      // The same rule as at statement level: `await using` suspends the
      // function it is written in, and a module's top level is where `await`
      // is an expression outside one.
      if (!context.allowAwait) return awaitRefusal("item", cursor, start);
      children.push(cursor.consume()!, cursor.consume()!);
    } else if (
      ["const", "let", "var", "using"].includes(declaration ?? "") &&
      declaresVariable(cursor)
    ) {
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
      if (definiteAssignment(cursor.peek())) children.push(cursor.consume()!);
      if (token(cursor.peek(), ":")) {
        const colon = cursor.consume()!;
        children.push(colon);
        // The type consumer reads a type wherever it is written and knows
        // nothing of where a declarator's head ends, so it is given only the
        // nodes the head reaches: `let x: A` and the `foo();` under it are two
        // items, and reading the annotation on across the break refused the
        // whole declaration -- which left the module's item list to be walked
        // as raw tokens, its macros unexpanded and nothing reported.
        const width = annotationExtent(cursor, colon, context);
        const annotation = createSyntaxCursor(
          Array.from({ length: width }, (_, offset) => cursor.peek(offset)!),
        );
        const type = this.#type.consume(annotation, {
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
        cursor.advance(type.cursor.index);
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
        // A declarator list carries on only where another declarator is
        // written. TypeScript reads the trailing comma of `let a = 1,;` into
        // the declaration and reports it there, so the list ends at the `;`
        // rather than the whole declaration being refused for want of one
        // more binder.
        if (token(cursor.peek(), ";")) break;
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
    if (macro !== undefined)
      return validateMacroAttempt(macro, "item", cursor, start);
    const first = cursor.peek();
    if (first === undefined || context.stopSet.matches(cursor)) {
      return failure("item", cursor, start, ["module item"], 1);
    }
    if (token(first, "@")) {
      const children: Syntax[] = [];
      while (token(cursor.peek(), "@")) {
        const decorator = consumeDecorator(this.#expression, cursor, context);
        if (decorator === undefined)
          return failure("item", cursor, start, ["decorator expression"], 35);
        children.push(...decorator);
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
      // Only this item's own head decides whether it ends at a block, so the
      // lookahead stops where the consumption loop below stops. Reading on into
      // whatever follows, `import "./x"` with no semicolon would see the
      // `function` of the next declaration, conclude it is itself a block
      // item, and fail for having no body.
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
        // A brace inside a `<...>` region is an object type, not the body of
        // the declaration being read.
        if (endsAtBlock && next.tag === "token" && isAngleOpen(next.raw)) {
          const region = consumeBalancedTypeArguments(cursor, context);
          if (region !== undefined) {
            for (let taken = 0; taken < region.width; taken += 1)
              children.push(cursor.consume()!);
            continue;
          }
        }
        children.push(cursor.consume()!);
        if (token(next, ";")) break;
        // A brace where a return type is written is an object type; the body
        // is the brace after the whole type.
        if (
          endsAtBlock &&
          next.tag === "group" &&
          next.delimiter === "brace" &&
          !typeOperandFollows(children.at(-2))
        )
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
            // group instead would only let the expander walk its tokens under
            // the body's category, which reaches a macro at the head of the
            // body and nothing else.
            bodyCategory === "stmt"
              ? this.#statement.enforestBlock(
                  body,
                  context,
                  declaresGenerator(children),
                  declaresAsync(children),
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
  /**
   * `allowYield` and `allowAwait` are given for a function body, which is or
   * is not a generator and is or is not async whatever encloses it; any other
   * block inherits them from `context`.
   */
  enforestBlock(
    block: GroupSyntax,
    context: ConsumerContext,
    allowYield?: boolean,
    allowAwait?: boolean,
  ): Syntax;
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
