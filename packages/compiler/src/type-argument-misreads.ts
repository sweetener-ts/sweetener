import type { SyntaxId } from "@sweetener/shared";
import type { PrintedTokenSpan } from "@sweetener/printer";
import type { ProtectedSyntax, Syntax } from "@sweetener/syntax";
import {
  isJavaScriptFileName,
  scriptKindForFileName,
} from "@sweetener/typescript-host";
import * as ts from "typescript";

/**
 * The `<` and `<<` operators in `syntax` that compare or shift two operands
 * an expansion put together -- each the operator of an expression `holds`
 * accepts -- which are the ones printing can leave for TypeScript to read as
 * type arguments. An author who writes `f(a < b, c > (d))` has written the
 * call TypeScript reads; an expansion that builds the two comparisons has
 * not.
 */
export function lessThanOperators(
  syntax: readonly Syntax[],
  holds: (expression: ProtectedSyntax) => boolean,
): ReadonlySet<SyntaxId> {
  const operators = new Set<SyntaxId>();
  const pending: Syntax[] = [];
  for (const node of syntax) pending.push(node);
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.tag === "token") continue;
    // A comparison or a shift is read as its operands and its operator
    // between them; the `<` of type arguments stands among more.
    const operator = node.children[1];
    if (
      node.tag === "protected" &&
      node.category === "expr" &&
      node.children.length === 3 &&
      operator?.tag === "token" &&
      (operator.raw === "<" || operator.raw === "<<") &&
      holds(node)
    )
      operators.add(operator.id);
    // A chain of one level is one node, however many operands it holds: one
    // at a time, rather than spread as as many arguments.
    for (const child of node.children) pending.push(child);
  }
  return operators;
}

/**
 * Which of `operators`, printed in `text` at the offsets `tokenSpans` give,
 * TypeScript's parser reads as opening type arguments: `x < (y > (z))` reads
 * as `x<(y>(z)`, a call. TypeScript decides this by trying to read types
 * after the `<` and recovering from what it cannot read, so no rule short of
 * its own parser answers where it will; it is asked.
 */
export function misreadLessThans(
  text: string,
  fileName: string,
  tokenSpans: readonly PrintedTokenSpan[],
  operators: ReadonlySet<SyntaxId>,
): ReadonlySet<SyntaxId> {
  const misread = new Set<SyntaxId>();
  // JavaScript reads no type arguments in an expression, so a file emitted
  // as JavaScript misreads none.
  if (operators.size === 0 || isJavaScriptFileName(fileName)) return misread;
  const operatorAt = new Map<number, SyntaxId>();
  for (const span of tokenSpans)
    if (operators.has(span.syntax)) operatorAt.set(span.start, span.syntax);
  if (operatorAt.size === 0) return misread;
  const parsed = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForFileName(fileName),
  );
  const pending: ts.Node[] = [parsed];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const typeArguments =
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node) ||
      ts.isExpressionWithTypeArguments(node)
        ? node.typeArguments
        : undefined;
    // The list begins directly after its `<`, which a `<<` rescanned for it
    // shares its first character with.
    if (typeArguments !== undefined) {
      const operator = operatorAt.get(typeArguments.pos - 1);
      if (operator !== undefined) misread.add(operator);
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return misread;
}
