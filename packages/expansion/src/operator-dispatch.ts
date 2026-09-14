import type {
  MacroOperatorCandidate,
  MacroOperatorExpansionInput,
  MacroOperatorResolver,
  PrattFixity,
} from "@sweetener/enforestation";
import type { Phase } from "@sweetener/hygiene";
import type {
  BindingId,
  Diagnostic,
  OriginId,
  SourceSpan,
} from "@sweetener/shared";
import {
  createSyntaxSequence,
  type ProtectedSyntax,
  type SyntaxCategory,
  type SyntaxCursor,
  type SyntaxSequence,
} from "@sweetener/syntax";
import type { CompileParsedMacrosResult } from "./compile-macros.js";
import type {
  ExpansionEnvironment,
  ExpansionEnvironmentStore,
  OperatorBinding,
} from "./environment.js";
import type { CompiledMacroBinding } from "./invocation.js";
import {
  conflictingOperatorImportCode,
  expansionDiagnosticRegistry,
} from "./diagnostics.js";

export interface CreateLexicalOperatorResolverOptions {
  readonly module: Pick<CompileParsedMacrosResult, "macros" | "operators">;
  readonly store: ExpansionEnvironmentStore;
  readonly environment: ExpansionEnvironment;
  readonly phase: Phase;
  readonly category: SyntaxCategory;
  readonly shadowsCore?: ((binding: OperatorBinding) => boolean) | undefined;
  readonly visible?:
    ((operator: OperatorBinding, cursor: SyntaxCursor) => boolean) | undefined;
  readonly onGroup?: ((trace: OperatorGroupingTrace) => void) | undefined;
  readonly expand: (options: {
    readonly macro: CompiledMacroBinding;
    readonly operator: OperatorBinding;
    readonly input: MacroOperatorExpansionInput;
  }) => ProtectedSyntax;
}

export interface RegisterImportedOperatorResult {
  readonly environment: ExpansionEnvironment;
  readonly diagnostics: readonly Diagnostic[];
}

/** Registers one imported operator atomically with a structured conflict. */
export function registerImportedOperator(options: {
  readonly store: ExpansionEnvironmentStore;
  readonly environment: ExpansionEnvironment;
  readonly operator: OperatorBinding;
  readonly importOrigin: OriginId;
  readonly diagnosticOrigin: (origin: OriginId) => SourceSpan;
}): RegisterImportedOperatorResult {
  try {
    return Object.freeze({
      environment: options.store.extendOperator(
        options.environment,
        options.operator,
      ),
      diagnostics: Object.freeze([]),
    });
  } catch (error) {
    if (
      !(error instanceof RangeError) ||
      !/Duplicate local/u.test(error.message)
    )
      throw error;
    const existing = options.store.lookupOperators(options.environment, {
      spelling: options.operator.spelling,
      phase: options.operator.phase,
      category: options.operator.category,
      fixity: options.operator.fixity,
    });
    return Object.freeze({
      environment: options.environment,
      diagnostics: Object.freeze([
        expansionDiagnosticRegistry.create(conflictingOperatorImportCode, {
          primaryOrigin: options.diagnosticOrigin(options.importOrigin),
          messageArguments: [
            options.operator.spelling,
            options.operator.fixity,
          ],
          relatedOrigins: existing.map(({ origin }) => ({
            message: "Existing lexical operator",
            origin: options.diagnosticOrigin(origin),
          })),
        }),
      ]),
    });
  }
}

export interface OperatorGroupingTrace {
  readonly binding: BindingId;
  readonly spelling: string;
  readonly fixity: PrattFixity;
  readonly precedence: number;
  readonly associativity: OperatorBinding["associativity"];
  readonly leftOrigin: OriginId | undefined;
  readonly operatorOrigins: readonly OriginId[];
  readonly rightOrigin: OriginId | undefined;
  readonly resultOrigin: OriginId;
}

/** Reconstructs matcher input while preserving the already parsed left extent. */
export function operatorInvocationSyntax(
  input: MacroOperatorExpansionInput,
  fixity: PrattFixity,
  flattenLeft = false,
): SyntaxSequence {
  if (fixity === "prefix") {
    if (input.right === undefined)
      throw new TypeError("Prefix operator expansion requires a right operand");
    return createSyntaxSequence([...input.operator, ...input.right.children]);
  }
  if (input.left === undefined)
    throw new TypeError(`${fixity} operator expansion requires a left operand`);
  if (fixity === "postfix")
    return createSyntaxSequence([
      ...(flattenLeft ? input.left.children : [input.left]),
      ...input.operator,
    ]);
  if (input.right === undefined)
    throw new TypeError("Infix operator expansion requires a right operand");
  return createSyntaxSequence([
    ...(flattenLeft ? input.left.children : [input.left]),
    ...input.operator,
    ...input.right.children,
  ]);
}

/**
 * How many tokens spell this operator at the cursor, or nothing if it is not
 * spelled there.
 *
 * An operator whose spelling the scanner splits across tokens -- `<-` is `<`
 * then `-` -- is only that operator when the tokens are written together.
 * Joining their text regardless of what stood between them read `a < - b`,
 * which is a comparison against a negation, as the operator: a silent
 * misreading of ordinary TypeScript, in a file that merely had the operator in
 * scope.
 */
function matchingWidth(
  cursor: SyntaxCursor,
  spelling: string,
): number | undefined {
  let actual = "";
  for (let width = 1; actual.length <= spelling.length; width += 1) {
    const node = cursor.peek(width - 1);
    if (node?.tag !== "token") return undefined;
    if (width > 1 && node.leadingTrivia.length > 0) return undefined;
    actual += node.raw;
    if (actual === spelling) return width;
    if (!spelling.startsWith(actual)) return undefined;
  }
  return undefined;
}

/** Connects persistent lexical operator bindings to Pratt's dispatch hook. */
export function createLexicalOperatorResolver(
  options: CreateLexicalOperatorResolverOptions,
): MacroOperatorResolver {
  const candidates = options.module.operators.filter(
    (operator) =>
      operator.phase === options.phase &&
      operator.category === options.category,
  );
  return (cursor, fixity) => {
    const matches = candidates.flatMap((operator) => {
      if (operator.fixity !== fixity) return [];
      if (options.visible?.(operator, cursor) === false) return [];
      const width = matchingWidth(cursor, operator.spelling);
      if (width === undefined) return [];
      const visible = options.store.lookupOperators(options.environment, {
        spelling: operator.spelling,
        phase: options.phase,
        category: options.category,
        fixity,
      });
      return visible.some(({ binding }) => binding === operator.binding)
        ? [{ operator, width }]
        : [];
    });
    if (matches.length === 0) return undefined;
    matches.sort(
      (left, right) =>
        right.width - left.width ||
        right.operator.spelling.length - left.operator.spelling.length,
    );
    const selected = matches[0]!;
    const tied = matches.filter(
      ({ width, operator }) =>
        width === selected.width &&
        operator.spelling === selected.operator.spelling &&
        operator.fixity === selected.operator.fixity,
    );
    if (tied.length > 1) {
      throw new RangeError(
        `Ambiguous lexical ${fixity} operator ${selected.operator.spelling}`,
      );
    }
    const macro = options.module.macros.find(
      ({ binding }) => binding.id === selected.operator.binding,
    );
    if (macro === undefined) {
      throw new RangeError(
        `Visible operator ${selected.operator.spelling} has no compiled macro`,
      );
    }
    const candidate: MacroOperatorCandidate = Object.freeze({
      binding: selected.operator.binding,
      spelling: selected.operator.spelling,
      fixity: selected.operator.fixity as PrattFixity,
      precedence: selected.operator.precedence,
      associativity: selected.operator.associativity,
      width: selected.width,
      shadowsCore: options.shadowsCore?.(selected.operator) ?? false,
      literalRightOperands: selected.operator.literalRightOperands,
      arrowOperand: selected.operator.arrowOperand,
      expand: (input: MacroOperatorExpansionInput) => {
        const result = options.expand({
          macro,
          operator: selected.operator,
          input,
        });
        options.onGroup?.(
          Object.freeze({
            binding: selected.operator.binding,
            spelling: selected.operator.spelling,
            fixity: selected.operator.fixity,
            precedence: selected.operator.precedence,
            associativity: selected.operator.associativity,
            leftOrigin: input.left?.origin,
            operatorOrigins: Object.freeze(
              input.operator.map(({ origin }) => origin),
            ),
            rightOrigin: input.right?.origin,
            resultOrigin: result.origin,
          }),
        );
        return result;
      },
    });
    return candidate;
  };
}
