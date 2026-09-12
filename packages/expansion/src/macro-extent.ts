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
  type SyntaxCursor,
} from "@sweetener/syntax";
import type { SyntaxId } from "@sweetener/shared";
import type { CompiledMacroBinding } from "./invocation.js";
import type { InvokeMacroOptions } from "./invocation.js";

export interface CreateMacroExtentResolverOptions {
  readonly resolve: (
    spelling: string,
    category: "expr" | "binding" | "stmt" | "item" | "typeMember",
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

function headSpelling(
  cursor: SyntaxCursor,
  category: "expr" | "binding" | "stmt" | "item" | "typeMember",
): string | undefined {
  let offset = 0;
  if (category === "item") {
    while (true) {
      const prefix = cursor.peek(offset);
      if (prefix?.tag !== "token" || !itemDispatchPrefixes.has(prefix.raw))
        break;
      offset += 1;
    }
  }
  const head = cursor.peek(offset);
  return head?.tag === "token" ? head.raw : undefined;
}

function protectedExtent(
  category: "expr" | "binding" | "stmt" | "item" | "typeMember",
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
 * Recognizes the source extent of a non-expression macro without expanding it.
 * This lets typed `item` and `stmt` captures contain nested macro invocations;
 * recursive expansion still owns template execution and diagnostics.
 */
export function createMacroExtentResolver(
  options: CreateMacroExtentResolverOptions,
): StatementItemMacroResolver {
  return (category, cursor, context) => {
    const spelling = headSpelling(cursor, category);
    if (spelling === undefined) return undefined;
    const macro = options.resolve(spelling, category, context);
    if (macro === undefined) return undefined;
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
        return protectedExtent(category, cursor, matched.cursor, options);
    }
    // An expression is claimed only by a rule that matched. A statement or item
    // has nowhere else to go, so a malformed invocation is preserved as one
    // typed extent and the recursive expander reports the ranked diagnostic;
    // an expression can simply decline and let the ordinary parse continue.
    if (category === "expr" || category === "binding") return undefined;
    return protectedExtent(category, cursor, fallbackExtent(cursor), options);
  };
}
