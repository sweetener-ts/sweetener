import type {
  ConsumerAttempt,
  ConsumerContext,
  StatementItemMacroResolver,
} from "@sweetener/enforestation";
import type { SyntaxClassConsumer } from "@sweetener/pattern";
import { evaluateRefinements, executeMatcher } from "@sweetener/pattern";
import {
  createProtectedSyntax,
  spanEnvelope,
  type OriginStore,
  type Syntax,
  type SyntaxCategory,
  type SyntaxCursor,
} from "@sweetener/syntax";
import type { SyntaxId } from "@sweetener/shared";
import type { CompiledMacroBinding } from "./invocation.js";
import type { InvokeMacroOptions } from "./invocation.js";

export interface CreateMacroExtentResolverOptions {
  readonly resolve: (
    spelling: string,
    category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
    context: ConsumerContext,
  ) => CompiledMacroBinding | undefined;
  readonly consumeClass: (macro: CompiledMacroBinding) => SyntaxClassConsumer;
  readonly origins: OriginStore;
  readonly allocateSyntaxId: () => SyntaxId;
  readonly matchesBindingLiteral?:
    InvokeMacroOptions["matchesBindingLiteral"] | undefined;
}

const itemDispatchPrefixes = new Set([
  "export",
  "default",
  "declare",
  "async",
  "abstract",
]);

function headOffset(
  cursor: SyntaxCursor,
  category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
): number {
  let offset = 0;
  if (category === "item") {
    while (true) {
      const prefix = cursor.peek(offset);
      if (prefix?.tag !== "token" || !itemDispatchPrefixes.has(prefix.raw))
        break;
      offset += 1;
    }
  }
  return offset;
}

/** A cursor just past the tokens that name the macro. */
function pastHead(
  cursor: SyntaxCursor,
  category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
  width: number,
): SyntaxCursor {
  const end = cursor.fork();
  end.advance(headOffset(cursor, category) + width);
  return end;
}

/** The longest spelling a punctuation-named macro is looked up under. */
const longestPunctuationHead = 4;

/**
 * The spellings a macro standing here could be named, longest first, with how
 * many tokens each takes.
 *
 * The scanner splits punctuation it does not know -- `^^` is `^` then `^` --
 * so a macro named that way is only found by joining the tokens. They are
 * joined only when written together, as an operator's are, so `^ ^` is not
 * read as `^^`.
 */
function headSpellings(
  cursor: SyntaxCursor,
  category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
): readonly { readonly spelling: string; readonly width: number }[] {
  const offset = headOffset(cursor, category);
  const head = cursor.peek(offset);
  if (head?.tag !== "token") return [];
  if (head.kind !== "punctuation") return [{ spelling: head.raw, width: 1 }];
  const spellings: { spelling: string; width: number }[] = [];
  let spelling = "";
  for (let width = 1; width <= longestPunctuationHead; width += 1) {
    const next = cursor.peek(offset + width - 1);
    if (
      next?.tag !== "token" ||
      next.kind !== "punctuation" ||
      (width > 1 && next.leadingTrivia.length > 0)
    )
      break;
    spelling += next.raw;
    spellings.push({ spelling, width });
  }
  return spellings.reverse();
}

function protectedExtent(
  category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
  start: SyntaxCursor,
  end: SyntaxCursor,
  options: CreateMacroExtentResolverOptions,
): ConsumerAttempt {
  const syntax = start.remainingRange().sequence.slice(start.index, end.index);
  if (syntax.length === 0) throw new RangeError("Macro extent cannot be empty");
  const origins = [...new Set(syntax.map(({ origin }) => origin))];
  return Object.freeze({
    matched: true,
    syntax: createProtectedSyntax({
      id: options.allocateSyntaxId(),
      span: spanEnvelope(syntax.map(({ span }) => span)),
      origin:
        origins.length === 1 ? origins[0]! : options.origins.composed(origins),
      scopes: syntax[0]!.scopes,
      category,
      children: syntax,
    }),
    cursor: end,
  });
}

/**
 * What separates one written unit of a list from the next, by the category
 * the list holds. A member list separates on `;` or `,`; an item list, a
 * statement list and a class body separate on `;` alone. A category that
 * names no list of its own is written with no separator at all.
 */
const listSeparators = new Map<SyntaxCategory, ReadonlySet<string>>([
  ["typeMember", new Set([";", ","])],
  ["item", new Set([";"])],
  ["stmt", new Set([";"])],
  ["classElement", new Set([";"])],
]);

/** Whether a node is a token that separates one unit of such a list. */
export function separatesList(
  node: Syntax | undefined,
  category: SyntaxCategory,
): boolean {
  return (
    node?.tag === "token" &&
    (listSeparators.get(category)?.has(node.raw) ?? false)
  );
}

/**
 * A cursor past the separator the unit a macro claimed is written with.
 *
 * A list separates on a token of its own, and a macro commonly emits whole
 * units, terminating the last one itself. The separator written after such an
 * invocation then terminates nothing: left outside the extent it stood in the
 * output as a unit of its own -- a member list reports a missing property or
 * signature, and a statement list or a class body is left with an empty
 * statement or an empty member. It belongs to the invocation the way a
 * statement's terminator belongs to the statement, so the extent spans it and
 * expansion decides whether one is still needed.
 */
function pastSeparator(
  category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
  end: SyntaxCursor,
): SyntaxCursor {
  if (!separatesList(end.peek(), category)) return end;
  const past = end.fork();
  past.advance();
  return past;
}

function fallbackExtent(cursor: SyntaxCursor): SyntaxCursor {
  const end = cursor.fork();
  while (!end.atEnd) {
    const next = end.consume()!;
    if (next.tag === "token" && next.raw === ";") break;
    if (next.tag === "group" && next.delimiter === "brace") break;
  }
  return end;
}

/**
 * Recognizes the source extent of a macro without expanding it. This lets
 * typed captures -- an `item`, a `stmt`, a `type` -- contain nested macro
 * invocations;
 * recursive expansion still owns template execution and diagnostics.
 */
export function createMacroExtentResolver(
  options: CreateMacroExtentResolverOptions,
): StatementItemMacroResolver {
  return (category, cursor, context) => {
    let macro: CompiledMacroBinding | undefined;
    let headWidth = 1;
    for (const candidate of headSpellings(cursor, category)) {
      macro = options.resolve(candidate.spelling, category, context);
      headWidth = candidate.width;
      if (macro !== undefined) break;
    }
    if (macro === undefined) return undefined;
    // An operator is dispatched by the expression parser, which reads its
    // operands around it. Measured here it recursed without end: an infix
    // rule begins with its left operand, and reading that operand at the
    // operator's own spelling asked this again, so `p |> await |> f`
    // overflowed the stack.
    if (macro.binding.kind === "operator") return undefined;
    // A syntax parameter is measured by its head alone. What it stands for is
    // decided when it expands, under whatever `#parameterize` encloses it, and
    // what is written after it -- a call's arguments, a member -- is read
    // around it the way it is read around any other operand.
    if (macro.parameter)
      return protectedExtent(
        category,
        cursor,
        pastHead(cursor, category, headWidth),
        options,
      );
    const ordered = [
      ...macro.rules.filter(({ fallback }) => !fallback),
      ...macro.rules.filter(({ fallback }) => fallback),
    ];
    for (const rule of ordered) {
      const matched = executeMatcher(rule.matcher, cursor.fork(), {
        consumeClass: options.consumeClass(macro),
        tracker: context.tracker,
        cancellation: context.cancellation,
        environmentEpoch: context.environmentEpoch,
        matchesBindingLiteral: options.matchesBindingLiteral,
      });
      // The same question the invocation asks. A rule whose refinements fail
      // did not match, and an extent measured from it would claim syntax the
      // rule that does match may not cover.
      if (
        matched.matched &&
        evaluateRefinements(rule.refinements, matched.captures)
      )
        return protectedExtent(
          category,
          cursor,
          pastSeparator(category, matched.cursor),
          options,
        );
    }
    // An expression or type is claimed only by a rule that matched. A statement
    // or item has nowhere else to go, so a malformed invocation is preserved as
    // one typed extent and the recursive expander reports the ranked
    // diagnostic; an expression or type can simply decline and let the
    // ordinary parse continue.
    if (category === "expr" || category === "binding" || category === "type")
      return undefined;
    return protectedExtent(category, cursor, fallbackExtent(cursor), options);
  };
}
