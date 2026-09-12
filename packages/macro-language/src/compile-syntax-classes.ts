import {
  compileSyntaxClasses,
  invalidRefinementCode,
  patternDiagnosticRegistry,
  type CompileSyntaxClassesResult,
  type LengthComparison,
  type RefinementPredicate,
  type SyntaxClassRefinementInput,
} from "@sweetener/pattern";
import type { Diagnostic, OriginId, SourceId } from "@sweetener/shared";
import type {
  DelimiterKind,
  GroupSyntax,
  Span,
  Syntax,
  TokenKind,
  TokenSyntax,
} from "@sweetener/syntax";
import type { ParseMacroDefinitionsResult } from "./parser/index.js";

export interface CompileParsedSyntaxClassesOptions {
  readonly sourceId: SourceId;
  readonly spanForOrigin: (origin: OriginId) => Span;
}

const refinableTokenKinds = new Set<TokenKind>([
  "identifier",
  "private-identifier",
  "keyword",
  "numeric-literal",
  "bigint-literal",
  "string-literal",
  "regular-expression-literal",
  "no-substitution-template",
  "punctuation",
  "jsx-text",
  "jsx-identifier",
]);

const refinableDelimiters = new Set<DelimiterKind>([
  "parenthesis",
  "bracket",
  "brace",
  "template",
  "jsx-element",
  "jsx-fragment",
]);

const lengthComparisons = new Map<string, LengthComparison>([
  ["equal", "equal"],
  ["less-than", "less-than"],
  ["at-most", "at-most"],
  ["greater-than", "greater-than"],
  ["at-least", "at-least"],
]);

/** Splits a parenthesised list on commas and joins each entry's spelling. */
function listEntries(group: GroupSyntax): readonly string[] {
  const entries: string[] = [];
  let current: string[] = [];
  for (const child of group.children) {
    if (child.tag === "token" && child.raw === ",") {
      entries.push(current.join(""));
      current = [];
      continue;
    }
    if (child.tag !== "token") return [];
    current.push(
      child.kind === "string-literal" ? String(child.value) : child.raw,
    );
  }
  if (current.length > 0) entries.push(current.join(""));
  return entries.filter((entry) => entry.length > 0);
}

/**
 * Reads one refinement predicate. The name is spelled across several tokens
 * because the reader splits `at-least` and `token-kind` on their hyphens, so
 * the leading run of words is joined and whatever follows is the argument.
 */
function parseRefinementPredicate(
  nodes: readonly Syntax[],
): RefinementPredicate | undefined {
  const words: string[] = [];
  let argument: Syntax | undefined;
  for (const node of nodes) {
    if (node.tag === "group") {
      argument = node;
      break;
    }
    if (node.tag !== "token") return undefined;
    // A clause keeps the `;` that ends it, and a predicate that takes no
    // argument would otherwise read the terminator as part of its name.
    if (node.raw === ";") break;
    if (node.kind === "string-literal" || node.kind === "numeric-literal") {
      argument = node;
      break;
    }
    words.push(node.raw);
  }
  const name = words.join("");
  const group =
    argument?.tag === "group" && argument.delimiter === "parenthesis"
      ? argument
      : undefined;
  const literal = argument?.tag === "token" ? argument : undefined;

  if (name === "spellingstarts-with-lowercase" && argument === undefined)
    return { kind: "starts-with-lowercase" };
  if (name === "spellingstarts-with-uppercase" && argument === undefined)
    return { kind: "starts-with-uppercase" };
  if (name === "spellingequals" && literal?.kind === "string-literal")
    return { kind: "spelling-equals", spelling: String(literal.value) };
  if (name === "spellingin" && group !== undefined) {
    const spellings = listEntries(group);
    return spellings.length === 0
      ? undefined
      : { kind: "spelling-in", spellings };
  }
  if (name === "token-kind" && group !== undefined) {
    const kinds = listEntries(group);
    return kinds.length > 0 &&
      kinds.every((kind) => refinableTokenKinds.has(kind as TokenKind))
      ? { kind: "token-kind", tokenKinds: kinds as readonly TokenKind[] }
      : undefined;
  }
  if (name.startsWith("delimiter") && argument === undefined) {
    const delimiter = name.slice("delimiter".length);
    return refinableDelimiters.has(delimiter as DelimiterKind)
      ? { kind: "delimiter", delimiter: delimiter as DelimiterKind }
      : undefined;
  }
  if (name.startsWith("length") && literal?.kind === "numeric-literal") {
    const comparison = lengthComparisons.get(name.slice("length".length));
    const length = Number(literal.value);
    return comparison === undefined || !Number.isSafeInteger(length)
      ? undefined
      : { kind: "repetition-length", comparison, length };
  }
  // `boundary` and `selected-alternative` are deliberately absent. The matcher
  // evaluates both against context it never fills in, so a rule written with
  // one would quietly never match. Refusing them keeps that a clear error.
  return undefined;
}

type RuleClauses =
  ParseMacroDefinitionsResult["definitions"][number]["rules"][number]["clauses"];

export interface LowerRuleRefinementsOptions {
  readonly sourceId: SourceId;
  readonly spanForOrigin: (origin: OriginId) => Span;
}

export interface LowerRuleRefinementsResult {
  readonly refinements: readonly SyntaxClassRefinementInput[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads the `refine` clauses written on one rule.
 *
 * A macro rule takes the same clauses a syntax-class rule does, and used to
 * drop them: two rules told apart only by a refinement both matched, and the
 * first one written answered for both. `matchTest($subject, $name:ident)`
 * refined to lowercase spellings accepted `Ready` as a binder and reported
 * every arm as taken.
 */
export function lowerRuleRefinements(
  clauses: RuleClauses,
  options: LowerRuleRefinementsOptions,
): LowerRuleRefinementsResult {
  const diagnostics: Diagnostic[] = [];
  const refinements = clauses.flatMap((clause) => {
    if (clause.kind !== "refinement") return [];
    const tokens = clause.syntax.filter(
      (syntax): syntax is TokenSyntax => syntax.tag === "token",
    );
    const targetToken = tokens[1];
    const targetName = targetToken?.raw.startsWith("$")
      ? targetToken.raw.slice(1)
      : undefined;
    const predicate = parseRefinementPredicate(clause.syntax.slice(2));
    if (targetName !== undefined && predicate !== undefined) {
      return [{ targetName, predicate, origin: clause.origin }];
    }
    const span = options.spanForOrigin(clause.origin);
    diagnostics.push(
      patternDiagnosticRegistry.create(invalidRefinementCode, {
        primaryOrigin: {
          sourceId: options.sourceId,
          start: span.start,
          end: span.end,
          originId: clause.origin,
        },
        messageArguments: [targetName ?? "unknown"],
      }),
    );
    return [];
  });
  return Object.freeze({
    refinements: Object.freeze(refinements),
    diagnostics: Object.freeze(diagnostics),
  });
}

/** The `diagnostic "..."` clause written on one rule, if it has one. */
export function ruleFailureDescription(
  clauses: RuleClauses,
): string | undefined {
  const clause = clauses.find(({ kind }) => kind === "diagnostic");
  const value = clause?.syntax.find(
    (syntax): syntax is TokenSyntax =>
      syntax.tag === "token" && syntax.kind === "string-literal",
  );
  return typeof value?.value === "string" ? value.value : undefined;
}

export function compileParsedSyntaxClasses(
  parsed: ParseMacroDefinitionsResult,
  options: CompileParsedSyntaxClassesOptions,
): CompileSyntaxClassesResult {
  const refinementDiagnostics: Diagnostic[] = [];
  const bindings = new Map(
    parsed.classBindings.map((binding) => [binding.name, binding.classId]),
  );
  const token = bindings.get("token");
  const tt = bindings.get("tt");
  const ident = bindings.get("ident");
  if (token === undefined || tt === undefined || ident === undefined) {
    throw new Error("Parser result is missing core syntax-class bindings");
  }
  const lowerRefinements = (
    clauses: RuleClauses,
  ): readonly SyntaxClassRefinementInput[] => {
    const lowered = lowerRuleRefinements(clauses, options);
    refinementDiagnostics.push(...lowered.diagnostics);
    return lowered.refinements;
  };

  const result = compileSyntaxClasses(
    parsed.definitions
      .filter((definition) => definition.kind === "syntax-class")
      .map((definition) => ({
        classId: definition.classId,
        name: definition.name,
        origin: definition.origin,
        fields: definition.fields,
        rules: definition.rules.map((rule) => ({
          rule: rule.id,
          pattern: rule.pattern,
          origin: rule.origin,
          refinements: lowerRefinements(rule.clauses),
          failureDescription: ruleFailureDescription(rule.clauses),
        })),
      })),
    {
      ...options,
      builtins: { token, tt, ident },
      externalClassIds: [
        "expr",
        "stmt",
        "item",
        "type",
        "binding",
        "classElement",
        "typeMember",
        "jsxChild",
      ].flatMap((name) => {
        const classId = bindings.get(name);
        return classId === undefined ? [] : [classId];
      }),
    },
  );
  return Object.freeze({
    registry: result.registry,
    diagnostics: Object.freeze([
      ...refinementDiagnostics,
      ...result.diagnostics,
    ]),
  });
}
