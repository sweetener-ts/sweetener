import type { BindingEnvironment } from "@sweetener/hygiene";
import type { SyntaxClassConsumer } from "@sweetener/pattern";
import {
  ResourceLimitError,
  type BindingId,
  type Diagnostic,
  type InvocationId,
  type SourceId,
} from "@sweetener/shared";
import {
  angleWidth,
  createGroup,
  createMissingToken,
  createProtectedSyntax,
  createRootSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  createToken,
  createTrivia,
  spanEnvelope,
  type GroupSyntax,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
  type SyntaxSequence,
  type TokenSyntax,
  type Trivia,
} from "@sweetener/syntax";
import {
  resolveCompiledMacro,
  type CompileParsedMacrosResult,
} from "./compile-macros.js";
import {
  expansionCycleCode,
  expansionDiagnosticRegistry,
  expansionLimitCode,
  macroNotYetVisibleCode,
  notSyntaxParameterCode,
  uncategorizedExpansionCode,
  unparameterizedSyntaxParameterCode,
  unusedRequiredParameterCode,
  uncopiableClosureCode,
  unprocessedDefinitionCode,
  unreadableSyntaxCode,
  wrongCategoryMacroCode,
} from "./diagnostics.js";
import { readLetBinding, readParameterization } from "@sweetener/template";
import {
  arrowBodyExtent,
  asyncArrowHead,
  asyncModifies,
  asyncNamedArrow,
  classElementEndsBefore,
  classMemberNameFollows,
  parameterBinder,
  returnTypeReadsInConsequent,
  typeOperandFollows,
  type ArrowBodyExtent,
} from "@sweetener/enforestation";
import { EnforestationError } from "./enforestation-error.js";
import { separatesList } from "./macro-extent.js";
import { ExpansionCycleError } from "./progress.js";
import type { CompiledMacroBinding, MacroContext } from "./invocation.js";
import {
  coreFormKind,
  isCoreForm,
  type CoreDispatchTrace,
} from "./core-shadowing.js";
import type {
  ExpansionEnvironment,
  ExpansionEnvironmentStore,
} from "./environment.js";
import {
  invokeMacro,
  type InvokeMacroOptions,
  type MacroTraceEvent,
} from "./invocation.js";
import {
  processGeneratedDefinitions,
  type GeneratedDefinitionsTrace,
} from "./generated-definitions.js";

export interface ExpandMacroSyntaxOptions extends Omit<
  InvokeMacroOptions,
  | "macro"
  | "cursor"
  | "category"
  | "consumeClass"
  | "environment"
  | "parentInvocation"
  | "expandReplacement"
> {
  readonly module: CompileParsedMacrosResult;
  /** Source whose syntax is being expanded and whose imports form the call site. */
  readonly sourceId?: SourceId | undefined;
  /** Additional statically imported modules, in source lookup order. */
  readonly modules?: readonly CompileParsedMacrosResult[] | undefined;
  readonly syntax: SyntaxSequence;
  readonly category: SyntaxCategory;
  readonly consumeClass: SyntaxClassConsumer;
  /**
   * The class consumer an invocation of the macro matches with, reading its
   * captures in the contexts the invocation stands in -- a `yield` is an
   * expression only inside a generator.
   */
  readonly consumeClassForMacro?:
    | ((
        macro: CompiledMacroBinding,
        contexts: ReadonlySet<MacroContext>,
      ) => SyntaxClassConsumer)
    | undefined;
  readonly resolveMacro?:
    | ((request: {
        readonly spelling: string;
        readonly category: SyntaxCategory;
        readonly modules: readonly CompileParsedMacrosResult[];
        readonly lexicalModule: CompileParsedMacrosResult;
        readonly position: number;
        /**
         * Source the position belongs to. Definition-order visibility is only
         * meaningful within one file, and a macro's replacement mixes template
         * syntax from the defining file with captured syntax from the call
         * site, so the two must be told apart.
         */
        readonly positionSourceId?: SourceId | undefined;
      }) => CompiledMacroBinding | undefined)
    | undefined;
  readonly environment: BindingEnvironment;
  readonly parentInvocation?: InvocationId | undefined;
  readonly expansionStore?: ExpansionEnvironmentStore | undefined;
  readonly expansionEnvironment?: ExpansionEnvironment | undefined;
  readonly generatedDefinitions?: { readonly sourceId: SourceId } | undefined;
  readonly coreInterceptionForMacro?:
    | ((request: {
        readonly macro: CompiledMacroBinding;
        readonly lexicalModule: CompileParsedMacrosResult;
        readonly spelling: string;
        readonly origin: Syntax["origin"];
      }) => CoreDispatchTrace | undefined)
    | undefined;
  readonly enforest: (request: {
    readonly syntax: SyntaxSequence;
    readonly category: SyntaxCategory;
    readonly lexicalModule: CompileParsedMacrosResult;
    readonly contexts: ReadonlySet<MacroContext>;
  }) => ProtectedSyntax;
  /**
   * Enforest a brace body as a statement list, or return undefined when it
   * does not parse as one.
   *
   * A replacement is expanded while it is still raw, so a block spliced into
   * it — a captured statement, for instance — is walked under the enclosing
   * category and its interior expressions are never categorized. Enforesting
   * the block on the way in gives those positions their real categories.
   */
  readonly enforestStatements?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        /** Module whose macros are in scope for the syntax being enforested. */
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => SyntaxSequence | undefined)
    | undefined;
  readonly enforestItems?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        /** Module whose macros are in scope for the syntax being enforested. */
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => SyntaxSequence | undefined)
    | undefined;
  /** Enforests a run of JSX children, for a macro that emits several. */
  readonly enforestJsxChildren?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => SyntaxSequence | undefined)
    | undefined;
  /** Enforests a run of interface members, for a macro that emits several. */
  readonly enforestTypeMembers?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => SyntaxSequence | undefined)
    | undefined;
  /** Enforests a run of class members, for a macro that emits several. */
  readonly enforestClassElements?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => SyntaxSequence | undefined)
    | undefined;
  /** Enforest one expression without throwing when the sequence is a fragment. */
  readonly enforestExpression?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        /** Module whose macros are in scope for the syntax being enforested. */
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => ProtectedSyntax | undefined)
    | undefined;
}

export interface ExpandMacroSyntaxResult {
  readonly syntax: SyntaxSequence;
  readonly environment: BindingEnvironment;
  readonly traces: readonly MacroTraceEvent[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * What this expansion can say about a name it left alone because the macro
   * spelled that way is declared for another space.
   *
   * These are not diagnostics. Whether anything defines the name is
   * TypeScript's to answer: it reads `lib.d.ts`, every ambient declaration and
   * every `declare global`, and it knows that a member list names members of
   * its own, none of which the expander can see. So each of these is carried
   * to the side that resolves names, and written only where that side reports
   * it cannot resolve the name written there.
   */
  readonly unresolvedNameExplanations: readonly Diagnostic[];
  readonly generatedDefinitionTraces: readonly GeneratedDefinitionsTrace[];
  readonly generatedModules: readonly CompileParsedMacrosResult[];
  readonly expansionEnvironment: ExpansionEnvironment | undefined;
  /**
   * The operator tokens this expansion offered to their operator's rules,
   * whether or not a rule took them. An operator standing in the output that
   * was never offered is one whose expression could not be read.
   */
  readonly offeredOperators: ReadonlySet<Syntax["origin"]>;
  /**
   * The identifiers this expansion decided were names rather than macro
   * references: a property read off a value, a member's or a label's name, a
   * binder, a name an ordinary binding shadows. A check that looks for
   * invocations still standing in the output has to skip these, or it blames
   * code that never invoked anything.
   */
  readonly namedOrigins: ReadonlySet<Syntax["origin"]>;
}

const itemDispatchPrefixes = new Set([
  "export",
  "default",
  "declare",
  "async",
  "abstract",
]);

/** Whether a spelling is punctuation rather than an identifier. */
function punctuationSpelled(spelling: string): boolean {
  return !/^[\p{ID_Start}_$]/u.test(spelling);
}

interface JsxTagShape {
  /**
   * Where the `>` that ends the opening tag is written, as an index into the
   * element's children, or -1 where the element is self-closing and its `>`
   * is the group's own closer.
   */
  readonly tagEnd: number;
  /**
   * Where the tag's type arguments are written: the index of their `<` and of
   * the `>` that matches it.
   */
  readonly typeArguments:
    { readonly from: number; readonly to: number } | undefined;
}

/**
 * How a JSX element's opening tag is laid out among the element's children.
 *
 * A generic element's type arguments carry `>` of their own --
 * `<Comp<Map<K, V>> value={1} />` -- and the first of them is not what ends
 * the tag. Reading it as the end walked the attributes after it as children,
 * and left the type arguments themselves in the tag region, where nothing
 * looked at them: a type macro written there was never expanded.
 */
function jsxTagShape(children: readonly Syntax[]): JsxTagShape {
  let depth = 0;
  let opened = -1;
  let typeArguments: { readonly from: number; readonly to: number } | undefined;
  for (let at = 0; at < children.length; at += 1) {
    const child = children[at];
    if (child?.tag !== "token") continue;
    if (child.raw === "<") {
      if (depth === 0) opened = at;
      depth += 1;
      continue;
    }
    if (child.raw === ">") {
      if (depth === 0) return { tagEnd: at, typeArguments };
      depth -= 1;
      if (depth === 0 && typeArguments === undefined)
        typeArguments = { from: opened, to: at };
      continue;
    }
    // A closing tag holds no type arguments, so nothing beyond it is the
    // opening tag's.
    if (child.raw === "</") break;
  }
  return { tagEnd: -1, typeArguments };
}

/**
 * How many tokens spell this operator here, or nothing if it is not spelled
 * here at all.
 *
 * An operator whose spelling the scanner splits across tokens -- `<-` is `<`
 * then `-` -- is only that operator when the tokens are written together.
 * Joining their text regardless of what stands between them would read
 * `a < - b`, which is a comparison against a negation, as the operator: a
 * silent misreading of ordinary TypeScript, in a file that merely has the
 * operator in scope.
 */
export function operatorWidthAt(
  syntax: SyntaxSequence,
  index: number,
  spelling: string,
): number | undefined {
  let actual = "";
  for (let width = 1; actual.length <= spelling.length; width += 1) {
    const node = syntax[index + width - 1];
    if (node?.tag !== "token") return undefined;
    if (width > 1 && node.leadingTrivia.length > 0) return undefined;
    actual += node.raw;
    if (actual === spelling) return width;
    if (!spelling.startsWith(actual)) return undefined;
  }
  return undefined;
}

export function expandMacroSyntax(
  options: ExpandMacroSyntaxOptions,
): ExpandMacroSyntaxResult {
  const traces: MacroTraceEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const unresolvedNameExplanations: Diagnostic[] = [];
  const offeredOperators = new Set<Syntax["origin"]>();
  const namedOrigins = new Set<Syntax["origin"]>();
  const generatedDefinitionTraces: GeneratedDefinitionsTrace[] = [];
  const activeModules: CompileParsedMacrosResult[] = [
    ...(options.modules ?? [options.module]),
  ];
  if (activeModules.length === 0)
    throw new RangeError("Expansion requires at least one macro module");
  let activeExpansionEnvironment = options.expansionEnvironment;

  const addScopes = (syntax: Syntax, added: Syntax["scopes"]): Syntax => {
    const scopes = options.scopeStore.union(syntax.scopes, added);
    switch (syntax.tag) {
      case "token":
        return createToken({ ...syntax, scopes });
      case "group":
        return createGroup({
          ...syntax,
          scopes,
          open: addScopes(syntax.open, added) as TokenSyntax,
          children: syntax.children.map((child) => addScopes(child, added)),
          close:
            syntax.close.tag === "token"
              ? (addScopes(syntax.close, added) as TokenSyntax)
              : createMissingToken({ ...syntax.close, scopes }),
        });
      case "protected":
        return createProtectedSyntax({
          ...syntax,
          scopes,
          children: syntax.children.map((child) => addScopes(child, added)),
        });
      case "root":
        return createRootSyntax({
          ...syntax,
          scopes,
          children: syntax.children.map((child) => addScopes(child, added)),
        });
    }
  };

  /**
   * A replacement that produces no statements or items at all is a macro that
   * expanded to nothing, which is an ordinary outcome. It still has to become
   * one node, so it becomes an empty one anchored on the invocation it
   * replaced.
   */
  const emptyReplacement = (
    category: SyntaxCategory,
    anchor: Syntax | undefined,
  ): ProtectedSyntax | undefined => {
    if (anchor === undefined) return undefined;
    const span = { start: anchor.span.start, end: anchor.span.start };
    // A parse unit has to wrap something, and the one statement that carries no
    // meaning is the empty statement.
    const semicolon = createToken({
      id: options.allocateSyntaxId(),
      span,
      origin: anchor.origin,
      scopes: anchor.scopes,
      kind: "punctuation",
      raw: ";",
      leadingTrivia: [],
    });
    return createProtectedSyntax({
      id: options.allocateSyntaxId(),
      span,
      origin: anchor.origin,
      scopes: anchor.scopes,
      category,
      children: [semicolon],
    });
  };

  const enforestSequence = (
    syntax: SyntaxSequence,
    category: SyntaxCategory,
    lexicalModule: CompileParsedMacrosResult,
    contexts: ReadonlySet<MacroContext>,
    anchor?: Syntax | undefined,
  ): ProtectedSyntax => {
    if (category === "stmt") {
      const statements = options.enforestStatements?.({
        syntax,
        contexts,
        lexicalModule,
      });
      if (statements !== undefined) {
        if (statements.length === 0) {
          const empty = emptyReplacement(category, anchor);
          if (empty !== undefined) return empty;
        }
        if (statements.length === 1) return statements[0] as ProtectedSyntax;
        const origins = [...new Set(statements.map(({ origin }) => origin))];
        return createProtectedSyntax({
          id: options.allocateSyntaxId(),
          span: spanEnvelope(statements.map(({ span }) => span)),
          origin:
            origins.length === 1
              ? origins[0]!
              : options.origins.composed(origins),
          scopes: statements[0]!.scopes,
          category: "stmt",
          children: statements,
        });
      }
    }
    // A member list and a run of JSX children are sequences like a statement
    // or item list: a macro filling one may produce more than a single node.
    const run = (
      runCategory: "classElement" | "jsxChild" | "typeMember",
      members: SyntaxSequence | undefined,
    ): ProtectedSyntax | undefined => {
      if (members === undefined || members.length === 0) return undefined;
      if (members.length === 1) return members[0] as ProtectedSyntax;
      const origins = [...new Set(members.map(({ origin }) => origin))];
      return createProtectedSyntax({
        id: options.allocateSyntaxId(),
        span: spanEnvelope(members.map(({ span }) => span)),
        origin:
          origins.length === 1
            ? origins[0]!
            : options.origins.composed(origins),
        scopes: members[0]!.scopes,
        category: runCategory,
        children: members,
      });
    };
    if (
      category === "classElement" ||
      category === "jsxChild" ||
      category === "typeMember"
    ) {
      const members = (
        category === "classElement"
          ? options.enforestClassElements
          : category === "typeMember"
            ? options.enforestTypeMembers
            : options.enforestJsxChildren
      )?.({ syntax, contexts, lexicalModule });
      const wrapped = run(category, members);
      if (wrapped !== undefined) return wrapped;
    }
    if (category === "item") {
      const items = options.enforestItems?.({
        syntax,
        contexts,
        lexicalModule,
      });
      if (items !== undefined) {
        if (items.length === 0) {
          const empty = emptyReplacement(category, anchor);
          if (empty !== undefined) return empty;
        }
        if (items.length === 1) return items[0] as ProtectedSyntax;
        const origins = [...new Set(items.map(({ origin }) => origin))];
        return createProtectedSyntax({
          id: options.allocateSyntaxId(),
          span: spanEnvelope(items.map(({ span }) => span)),
          origin:
            origins.length === 1
              ? origins[0]!
              : options.origins.composed(origins),
          scopes: items[0]!.scopes,
          category: "item",
          children: items,
        });
      }
    }
    if (
      (category === "item" || category === "stmt") &&
      syntax.length > 1 &&
      syntax.every(
        (node) => node.tag === "protected" && node.category === "item",
      )
    ) {
      const origins = [...new Set(syntax.map(({ origin }) => origin))];
      return createProtectedSyntax({
        id: options.allocateSyntaxId(),
        span: spanEnvelope(syntax.map(({ span }) => span)),
        origin:
          origins.length === 1
            ? origins[0]!
            : options.origins.composed(origins),
        scopes: syntax[0]!.scopes,
        category: "item",
        children: syntax,
      });
    }
    return options.enforest({ syntax, category, lexicalModule, contexts });
  };

  /**
   * Enforests syntax the walk has to read before it can descend into it, or
   * reports why it could not and answers undefined.
   *
   * A template literal's substitution and a group holding a custom operator
   * are read here rather than by a macro, so a failure is a fact about the
   * source. Left to escape it would end the whole project's expansion with a
   * stack trace naming no file -- `` `${%}` `` in one file would be enough.
   */
  const enforestOrReport = (
    syntax: SyntaxSequence,
    category: SyntaxCategory,
    lexicalModule: CompileParsedMacrosResult,
    contexts: ReadonlySet<MacroContext>,
  ): ProtectedSyntax | undefined => {
    try {
      return enforestSequence(syntax, category, lexicalModule, contexts);
    } catch (error) {
      if (!(error instanceof EnforestationError)) throw error;
      const at = syntax[0];
      const source =
        at === undefined
          ? undefined
          : options.origins.selectPrimarySource(at.origin);
      if (at === undefined || source === undefined) throw error;
      diagnostics.push(
        expansionDiagnosticRegistry.create(unreadableSyntaxCode, {
          primaryOrigin: {
            sourceId: source.sourceId,
            start: source.span.start,
            end: source.span.end,
            originId: at.origin,
          },
          messageArguments: [
            category === "expr" ? "an expression" : `a ${category}`,
            error.syntaxText,
          ],
        }),
      );
      return undefined;
    }
  };

  /** Shared, so a run with nothing after it allocates nothing. */
  const noSyntax: readonly Syntax[] = Object.freeze([]);

  /**
   * A run of syntax read by position: everything walked so far, and then what
   * is yet to be walked, which is a run of its own.
   *
   * A rule that asks what stands around a node is given the run and the
   * position the node stands at, rather than a copy of either side. Handed
   * `nodes.slice(0, at)` it built a copy of the whole walk at every node, so a
   * statement list cost time quadratic in its own length; and a rule that read
   * across the join built `[...preceding, group, ...following]` once per token
   * it looked at. Reading in place asks the same question and copies nothing.
   */
  interface SyntaxRun {
    /** The syntax walked so far, read from its start. */
    readonly walked: readonly Syntax[];
    /** What follows it, read from `from` on. */
    readonly following: readonly Syntax[];
    readonly from: number;
  }

  /**
   * The whole of `nodes`, with nothing after it. The array is held rather than
   * copied, so a run taken of syntax still being walked reads what is in it
   * now every time it is asked.
   */
  const runOf = (nodes: readonly Syntax[]): SyntaxRun => ({
    walked: nodes,
    following: noSyntax,
    from: 0,
  });

  /** The node at `at` in `run`, or undefined where the run does not reach. */
  const nodeAt = (run: SyntaxRun, at: number): Syntax | undefined =>
    at < run.walked.length
      ? run.walked[at]
      : run.following[run.from + at - run.walked.length];

  /** How many nodes `run` holds. */
  const runLength = (run: SyntaxRun): number =>
    run.walked.length + run.following.length - run.from;

  /**
   * Whether a brace group in expression position opens a function body rather
   * than an object literal. A macro template commonly wraps statements in an
   * arrow or function expression, and the statements inside are statements
   * however the enclosing replacement is categorized.
   */
  const functionBodyFollows = (
    nodes: readonly Syntax[],
    end: number,
  ): boolean => {
    const lastToken = (node: Syntax | undefined): TokenSyntax | undefined => {
      let current = node;
      while (current !== undefined && current.tag !== "token") {
        current = current.children.at(-1);
      }
      return current;
    };
    const previous = nodes[end - 1];
    if (lastToken(previous)?.raw === "=>") return true;
    // `function (...) {`, including a name and a generator star.
    if (previous?.tag !== "group" || previous.delimiter !== "parenthesis")
      return false;
    for (let index = end - 2; index >= 0; index -= 1) {
      const candidate = nodes[index]!;
      if (candidate.tag !== "token") return false;
      if (candidate.raw === "function") return true;
      if (candidate.kind !== "identifier" && candidate.raw !== "*")
        return false;
    }
    return false;
  };

  /**
   * Whether a parenthesis group holds a control-flow header. What stands
   * there is an expression — the iterable of a `for`, the condition of the
   * rest — so a macro written in one is looked up in the expression space
   * rather than walked as part of the statement around it.
   */
  /**
   * Whether the next node stands where a type is written. A type macro is
   * looked up only after one of these, so a name that also happens to be a
   * value is not mistaken for one.
   */
  const typePositionFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    if (previous?.tag !== "token") return false;
    // What a class extends is an expression, however much the `extends` of an
    // interface or a conditional type introduces a type.
    if (previous.raw === "extends" && classHeritageFollows(preceding))
      return false;
    // The tokens after which a type is written, including words that exist
    // only in a type. Without those a type macro after one of them would not
    // be looked up at all, so `keyof list<string>` would keep the macro's own
    // spelling and no diagnostic would say why.
    if (
      typeOperandFollows(previous) ||
      previous.raw === "as" ||
      previous.raw === "satisfies"
    )
      return true;
    // A type parameter's default is a type, unlike every other `=` written in
    // an expression: `<T extends object = sized>`.
    if (previous.raw === "=" && typeArgumentsOpen(preceding)) return true;
    // The `=` of a type alias introduces a type, unlike every other `=`.
    return typeAliasInitializerFollows(preceding);
  };

  /**
   * Whether the next node stands where a type is written, when what is being
   * walked is an expression.
   *
   * Every token `typePositionFollows` accepts other than `as` and `satisfies`
   * is an expression's too -- `[1, (x)]`, `c ? (x) : (y)`, `a | (b)`,
   * `(v) => (x)` -- so reading a group after one of them as a type looked the
   * macros in it up among type macros, found none, and emitted them verbatim.
   */
  const typeFollowsInExpression = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    return (
      previous?.tag === "token" &&
      (previous.raw === "as" || previous.raw === "satisfies")
    );
  };

  /**
   * Whether the next node stands after the `=` of a type alias. Only that `=`
   * introduces a type; `=>` does so in a function type and opens an arrow's
   * body in an expression, so the two cannot share one test.
   */
  const typeAliasInitializerFollows = (
    preceding: readonly Syntax[],
  ): boolean => {
    const previous = preceding.at(-1);
    if (previous?.tag !== "token" || previous.raw !== "=") return false;
    // An alias names itself, so `type` is never the token directly in front of
    // its `=`. Reading back from there instead took the `type` of a class
    // field or a variable spelled that way -- `type = () => { ... }` -- for an
    // alias, and read the arrow's body as the type it would then declare.
    for (let at = preceding.length - 3; at >= 0; at -= 1) {
      const node = preceding[at]!;
      if (node.tag !== "token") return false;
      if (node.raw === ";" || node.raw === "}") return false;
      if (node.raw === "type") return true;
    }
    return false;
  };

  /**
   * Whether the next node stands after an `=`. What follows one is an
   * expression wherever it appears — a parameter's default, a class field's
   * initializer — even when the syntax around it is being walked as something
   * else.
   */
  const initializerFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    return (
      previous?.tag === "token" &&
      (previous.raw === "=" || previous.raw === "default")
    );
  };

  /**
   * Tokens after which the rest of the statement is an expression. `=` is
   * handled by `initializerFollows`, which has to tell an initializer from the
   * `=` of a type alias.
   */
  const expressionRegionHeads = new Set([
    "return",
    "throw",
    "yield",
    "case",
    "=>",
  ]);

  /**
   * Tokens that end an expression region. A statement keyword closes one the
   * same way a semicolon does, so a `return` inside a raw run does not leave
   * every following declaration read as an expression.
   */
  const expressionRegionEnds = new Set([
    ";",
    "const",
    "let",
    "var",
    "function",
    "class",
    "interface",
    "type",
    "import",
    "export",
    "enum",
    "namespace",
    "declare",
  ]);

  /** How many angles of `character` a node opens or closes. */
  const angles = (node: Syntax | undefined, character: "<" | ">"): number =>
    node?.tag === "token" ? angleWidth(node.raw, character) : 0;

  /**
   * Whether type arguments are open at the end of `nodes`: a `<` written
   * before it that nothing since has closed encloses it.
   *
   * Read backwards from the end, like every other rule that asks what stands
   * around a position: each `>` on the way back closes a `<` behind it, and a
   * `<` left over with no `>` to spend on it is one still open here. Counted
   * forwards from the start of the whole walked run instead, this cost the
   * length of the run at every `=` in it -- and the count carried across the
   * statement it was taken in, so the `<` of a comparison in one statement
   * left every `=` in the statements after it reading as a type parameter's
   * default. A statement boundary ends the scan for the same reason it ends
   * the one `typeAliasInitializerFollows` makes: no type argument list spans
   * one.
   */
  const typeArgumentsOpen = (nodes: readonly Syntax[]): boolean => {
    let closed = 0;
    for (let at = nodes.length - 1; at >= 0; at -= 1) {
      const node = nodes[at]!;
      if (node.tag !== "token") continue;
      if (node.raw === ";" || node.raw === "}") return false;
      closed += angleWidth(node.raw, ">");
      const opens = angleWidth(node.raw, "<");
      if (opens > closed) return true;
      closed -= opens;
    }
    return false;
  };

  /**
   * Whether the next node stands in a class heritage clause. What a class
   * extends is an expression -- `class E extends make()<T> {}` -- while what an
   * interface extends, or a type parameter is constrained by, is a type. All
   * three are written after `extends`, so the class is found by reading back
   * over the expression to the keyword, stopping at the `<` that would make
   * this a constraint.
   */
  const classHeritageFollows = (preceding: readonly Syntax[]): boolean => {
    let at = preceding.length - 1;
    let typeArguments = 0;
    for (; at >= 0; at -= 1) {
      const node = preceding[at]!;
      // What stands after `extends` is a name, what is read off it, a call, or
      // the parentheses around any of those: `extends factory(values)(more)`.
      if (node.tag === "group") {
        if (node.delimiter === "brace") return false;
        continue;
      }
      if (node.tag !== "token") return false;
      const closes = angles(node, ">");
      if (closes > 0) {
        typeArguments += closes;
        continue;
      }
      const opens = angles(node, "<");
      if (opens > 0) {
        if (typeArguments < opens) return false;
        typeArguments -= opens;
        continue;
      }
      if (typeArguments > 0) continue;
      if (node.raw === "extends") break;
      // What a class implements is a type, however the class reached it.
      if (node.raw === "implements") return false;
      if (
        node.raw !== "." &&
        node.raw !== "?." &&
        node.kind !== "identifier" &&
        node.kind !== "keyword"
      )
        return false;
    }
    if (at < 0) return false;
    for (let before = at - 1; before >= 0; before -= 1) {
      const node = preceding[before]!;
      if (node.tag !== "token") continue;
      if (node.raw === "class") return true;
      if (
        angles(node, "<") > 0 ||
        node.raw === "interface" ||
        node.raw === ";" ||
        node.raw === "}"
      )
        return false;
    }
    return false;
  };

  /** The words that stand between an object literal's brace and a method's name. */
  const methodNamePrefixes = new Set(["get", "set", "async", "*"]);

  /** Whether the next node stands where a declaration names what it binds. */
  const binderFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    if (previous?.tag !== "token") return false;
    return ["const", "let", "var", "using"].includes(previous.raw);
  };

  /**
   * Whether the parenthesis group written next holds the arguments a decorator
   * is called with. `@deco(value)` calls `deco`, so what stands between those
   * parentheses is an expression wherever the decorator itself stands -- in
   * front of a class, where the syntax around it is items, and in front of one
   * of its members, where the syntax around it is members and an expression is
   * read nowhere else.
   */
  const decoratorArgumentsFollow = (preceding: readonly Syntax[]): boolean => {
    let typeArguments = 0;
    for (let at = preceding.length - 1; at >= 0; at -= 1) {
      const node = preceding[at]!;
      if (node.tag !== "token") return false;
      const closes = angles(node, ">");
      if (closes > 0) {
        typeArguments += closes;
        continue;
      }
      const opens = angles(node, "<");
      if (opens > 0) {
        if (typeArguments < opens) return false;
        typeArguments -= opens;
        continue;
      }
      if (typeArguments > 0) continue;
      if (node.raw === "@") return true;
      // A decorator names what it applies, and reads members off it: `@a.b.c`.
      if (
        node.raw !== "." &&
        node.kind !== "identifier" &&
        node.kind !== "keyword"
      )
        return false;
    }
    return false;
  };

  /**
   * Whether a parenthesis group written after `previous` names what a `catch`
   * binds.
   */
  const catchBinderFollows = (previous: Syntax | undefined): boolean =>
    previous?.tag === "token" && previous.raw === "catch";

  /**
   * Whether a run of statements holds a statement operator. `a <- b` is also a
   * comparison against a negation, so enforesting first would commit to the
   * ordinary reading and the operator would never be offered the statement.
   */
  const holdsStatementOperator = (children: readonly Syntax[]): boolean => {
    const infix = activeModules
      .flatMap(({ operators }) => operators)
      .filter(
        (operator) =>
          operator.category === "stmt" && operator.fixity === "infix",
      );
    if (infix.length === 0) return false;
    return children.some((_, at) =>
      infix.some(
        (operator) =>
          operatorWidthAt(children, at, operator.spelling) !== undefined,
      ),
    );
  };

  const conditionFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    return (
      previous?.tag === "token" &&
      ["if", "while", "switch", "with", "for"].includes(previous.raw)
    );
  };

  /** A sequence whose first token has had the whitespace before it removed. */
  const withoutLeadingTrivia = (syntax: SyntaxSequence): SyntaxSequence => {
    const strip = (node: Syntax): Syntax => {
      switch (node.tag) {
        case "token":
          return node.leadingTrivia.every(({ kind }) => kind === "whitespace")
            ? createToken({ ...node, leadingTrivia: [] })
            : node;
        case "group":
          return createGroup({
            ...node,
            open: strip(node.open) as TokenSyntax,
          });
        case "protected": {
          const head = node.children[0];
          return head === undefined
            ? node
            : createProtectedSyntax({
                ...node,
                children: [strip(head), ...node.children.slice(1)],
              });
        }
        default:
          return node;
      }
    };
    const [first, ...rest] = syntax;
    return first === undefined
      ? syntax
      : createSyntaxSequence([strip(first), ...rest]);
  };

  /**
   * Moves trivia onto the front of a sequence whose own first token carries
   * none, so erasing a marker keeps the layout that stood before it.
   */
  const withLeadingTrivia = (
    syntax: SyntaxSequence,
    trivia: readonly Trivia[],
  ): SyntaxSequence => {
    const first = syntax[0];
    if (trivia.length === 0 || first === undefined) return syntax;
    const prepend = (node: Syntax): Syntax => {
      switch (node.tag) {
        case "token":
          return node.leadingTrivia.length > 0
            ? node
            : createToken({ ...node, leadingTrivia: [...trivia] });
        case "group":
          return createGroup({
            ...node,
            open: prepend(node.open) as TokenSyntax,
          });
        case "protected": {
          const head = node.children[0];
          return head === undefined
            ? node
            : createProtectedSyntax({
                ...node,
                children: [prepend(head), ...node.children.slice(1)],
              });
        }
        default:
          return node;
      }
    };
    return createSyntaxSequence([prepend(first), ...syntax.slice(1)]);
  };

  /**
   * What a region of source binds, by namespace.
   *
   * A macro's name is not reserved. Racket resolves an identifier and only then
   * asks whether the binding it found is a transformer, so a nearer ordinary
   * binding shadows a macro rather than sitting in a space of its own where the
   * two can never compete -- `(let ([or 5]) or)` is `5`, and shadowing reaches
   * core forms too. Rhombus says the same of its expression space: a binding
   * there "hides any binding for another space in an enclosing scope".
   *
   * Resolution here is a module-table lookup rather than a scope-set walk, so
   * the equivalent rule is applied by recording what each region binds and
   * asking before a macro is dispatched. Value and type are kept apart because
   * TypeScript keeps them apart: `const map` and `type map` are both legal and
   * neither shadows the other's macro.
   */
  interface RegionBindings {
    readonly values: ReadonlySet<string>;
    readonly types: ReadonlySet<string>;
  }

  /** Splits a binding list on the commas that separate its entries. */
  const bindingSegments = (
    sequence: readonly Syntax[],
    // Where the binders begin. A declaration's binders are what follows its
    // keyword, and reading from there rather than from a copy of the tail
    // keeps a statement list's walk linear in its length.
    from = 0,
  ): readonly SyntaxSequence[] => {
    const segments: SyntaxSequence[] = [];
    let segment: Syntax[] = [];
    for (let at = from; at < sequence.length; at += 1) {
      const node = sequence[at]!;
      if (node.tag === "token" && node.raw === ",") {
        if (segment.length > 0) segments.push(createSyntaxSequence(segment));
        segment = [];
        continue;
      }
      segment.push(node);
    }
    if (segment.length > 0) segments.push(createSyntaxSequence(segment));
    return segments;
  };

  const valueDeclarationKeywords = new Set(["const", "let", "var", "using"]);
  /** Declares a name in the value namespace, the type namespace, or both. */
  const namedDeclarations = new Map<string, "value" | "type" | "both">([
    ["function", "value"],
    ["class", "both"],
    ["enum", "both"],
    ["interface", "type"],
    ["type", "type"],
    ["namespace", "both"],
    ["module", "both"],
  ]);

  /**
   * The names a walk is recording, by namespace. Neither set is made until a
   * name is found for it: most of the syntax a region holds declares nothing,
   * and a walk that made a pair of sets for each of them spent more on the
   * empty answer than on reading it.
   */
  interface CollectedBindings {
    values: Set<string> | undefined;
    types: Set<string> | undefined;
  }
  /** Somewhere to record what is found, before anything has been. */
  const collecting = (): CollectedBindings => ({
    values: undefined,
    types: undefined,
  });
  const noNames: ReadonlySet<string> = new Set<string>();
  /** A region that binds nothing, shared so the common case allocates none. */
  const noBindings: RegionBindings = Object.freeze({
    values: noNames,
    types: noNames,
  });
  const recordValue = (into: CollectedBindings, name: string): void => {
    (into.values ??= new Set<string>()).add(name);
  };
  const recordType = (into: CollectedBindings, name: string): void => {
    (into.types ??= new Set<string>()).add(name);
  };
  /** What was collected, as the region it describes. */
  const bindingsOf = (into: CollectedBindings): RegionBindings =>
    into.values === undefined && into.types === undefined
      ? noBindings
      : Object.freeze({
          values: into.values ?? noNames,
          types: into.types ?? noNames,
        });
  /** Everything `from` binds, recorded into `into` as well. */
  const addBindings = (from: RegionBindings, into: CollectedBindings): void => {
    for (const name of from.values) recordValue(into, name);
    for (const name of from.types) recordType(into, name);
  };

  type SyntaxWithChildren = Extract<
    Syntax,
    { readonly children: readonly Syntax[] }
  >;

  /**
   * What a node contributes to the region around it, and what the region it
   * opens binds, each read from that node once.
   *
   * A region is walked for its bindings on the way in, and the region around
   * it has already walked through every node it holds: an outer region walked
   * what each nested one walked again, so a file cost its own size times the
   * depth of its nesting. Syntax is immutable, so a node's children never say
   * anything different a second time, and the answer is kept against the node
   * it was read from.
   */
  const outwardBindings = new WeakMap<Syntax, RegionBindings>();
  const innerBindings = new WeakMap<Syntax, RegionBindings>();

  const extractBinders = options.extractBindings;
  const addBinders = (
    entries: readonly SyntaxSequence[],
    into: CollectedBindings,
  ): void => {
    if (extractBinders === undefined) return;
    for (const entry of entries) {
      for (const name of extractBinders(entry))
        recordValue(into, name.spelling);
    }
  };
  /**
   * An import binds its local name in whichever namespaces the module it
   * reads exports it in, and nothing here says which: `import { T }` is as
   * readily a type as a value. Recording only the value namespace left a
   * type macro dispatched on a name the file had imported for itself.
   */
  const importName = (spelling: string, into: CollectedBindings): void => {
    recordValue(into, spelling);
    recordType(into, spelling);
  };
  /** The spelling of a node, when it is a token, for reading a clause. */
  const spelling = (node: Syntax | undefined): string | undefined =>
    node?.tag === "token" ? node.raw : undefined;

  /**
   * The local name a clause writes here, when a name is what stands here.
   *
   * A contextual keyword is a name: `using`, `type`, `from` and `as` are all
   * legal local names, and the scanner reads each of them as a keyword
   * rather than an identifier. Which position they stand in is what says
   * they are names, and the clause reader below answers that.
   */
  const localName = (node: Syntax | undefined): string | undefined =>
    node?.tag === "token" &&
    (node.kind === "identifier" || node.kind === "keyword")
      ? node.raw
      : undefined;

  /** `import { a, b as c }` binds the local name of each specifier. */
  const bindSpecifiers = (list: GroupSyntax, into: CollectedBindings): void => {
    for (const segment of bindingSegments(list.children)) {
      const local = localName(segment.at(-1));
      if (local !== undefined) importName(local, into);
    }
  };

  /**
   * Reads the import declaration written at `at`, binds the local names its
   * clause writes, and answers where the declaration ends -- the index of
   * its last node, for the walk to go on past.
   *
   * The clause is read as a clause. Answered instead by a flag that stayed
   * true once an `import` had been seen, the question "am I inside an
   * import" was still being answered with yes for everything written after
   * it, and `using` -- a declaration keyword everywhere else -- was read as
   * one where it names a default import, binding nothing and taking `from
   * "m"` for its binders.
   *
   * A clause is `name`, `* as name`, `{ a, b as c }`, or a name written
   * before either of the other two, each optionally after a `type` modifier;
   * `import "m"` writes none. What follows is `from "m"`, or the `=` of an
   * import-equals. Answers undefined where the `import` opens no declaration
   * at all: `import("m")` and `import.meta` are expressions.
   */
  const readImportDeclaration = (
    nodes: readonly Syntax[],
    at: number,
    into: CollectedBindings,
  ): number | undefined => {
    let index = at + 1;
    const head = nodes[index];
    if (head === undefined) return undefined;
    if (head.tag === "group" && head.delimiter === "parenthesis")
      return undefined;
    if (spelling(head) === ".") return undefined;
    // `import type name from "m"` writes its modifier where the local name
    // otherwise stands. The word is that name itself where what follows it
    // cannot follow a modifier: `import type from "m"`, `import type =
    // require("m")`, `import type, { a } from "m"`.
    const afterType = spelling(nodes[index + 1]);
    if (
      spelling(head) === "type" &&
      afterType !== "from" &&
      afterType !== "=" &&
      afterType !== ","
    )
      index += 1;
    /** Binds `* as name`, and answers where it ends. */
    const readNamespaceImport = (from: number): number => {
      if (spelling(nodes[from + 1]) !== "as") return from + 1;
      const alias = localName(nodes[from + 2]);
      if (alias !== undefined) importName(alias, into);
      return from + 3;
    };
    const clause = nodes[index];
    const binding = localName(clause);
    if (clause?.tag === "group" && clause.delimiter === "brace") {
      bindSpecifiers(clause, into);
      index += 1;
    } else if (spelling(clause) === "*") {
      index = readNamespaceImport(index);
    } else if (binding !== undefined) {
      // A default binding, which a specifier list or a namespace import may
      // be written beside.
      importName(binding, into);
      index += 1;
      if (spelling(nodes[index]) === ",") {
        const second = nodes[index + 1];
        if (second?.tag === "group" && second.delimiter === "brace") {
          bindSpecifiers(second, into);
          index += 2;
        } else if (spelling(second) === "*") {
          index = readNamespaceImport(index + 1);
        }
      }
    }
    // `from "m"`, and the attributes a module may be read with.
    if (spelling(nodes[index]) === "from") index += 2;
    else if (spelling(nodes[index]) === "=") {
      // `import name = require("m")` reads a module, `import name = A.B`
      // names one this module already has. Either ends where that name does,
      // which is read rather than scanned to a terminator: a run of syntax
      // need not write one, and scanning swallowed whatever came next.
      index += 1;
      if (localName(nodes[index]) !== undefined) index += 1;
      const argument = nodes[index];
      if (argument?.tag === "group" && argument.delimiter === "parenthesis")
        index += 1;
      else
        while (
          spelling(nodes[index]) === "." &&
          localName(nodes[index + 1]) !== undefined
        )
          index += 2;
    }
    const attributes = spelling(nodes[index]);
    if (
      (attributes === "with" || attributes === "assert") &&
      nodes[index + 1]?.tag === "group"
    )
      index += 2;
    if (spelling(nodes[index]) === ";") index += 1;
    return index - 1;
  };

  /**
   * A statement list's entries arrive protected, so the declarations in them
   * are one level down. A brace is never entered: what it binds belongs to
   * the region it opens, not to this one.
   */
  const collect = (
    nodes: readonly Syntax[],
    // True once a statement or item node has been entered. What a
    // declaration binds belongs to the region around it, but what its
    // parameters and loop head bind belongs to the region it opens, and that
    // region is walked separately. Without this a parameter leaked into the
    // module and shadowed the macro for the whole file.
    nested: boolean,
    into: CollectedBindings,
  ): void => {
    for (let at = 0; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      if (node.tag === "protected") {
        addBindings(bindingsFrom(node), into);
        continue;
      }
      if (node.tag === "group") {
        if (nested && node.delimiter === "parenthesis") continue;
        // `#parameterize(name = replacement) { body }` has the shape of a
        // parameter list and a body, but names a syntax parameter rather
        // than binding anything. Read as parameters, it shadowed the very
        // macro it was parameterizing.
        const previous = nodes[at - 1];
        if (
          node.delimiter === "parenthesis" &&
          previous?.tag === "token" &&
          (previous.raw === "#parameterize" ||
            previous.raw === "#let" ||
            ((previous.raw === "parameterize" || previous.raw === "let") &&
              nodes[at - 2]?.tag === "token" &&
              (nodes[at - 2] as TokenSyntax).raw === "#"))
        )
          continue;
        if (node.delimiter !== "parenthesis") continue;
        if (bindsParameters(nodes, at))
          // A parameter's binder stands after the modifiers of a parameter
          // property and after the `...` of a rest parameter, so what a
          // parameter list binds is read from the binder rather than from
          // the whole parameter.
          addBinders(
            bindingSegments(node.children).map((segment) =>
              createSyntaxSequence(parameterBinder(segment)),
            ),
            into,
          );
        else addBindings(bindingsWithin(node), into);
        continue;
      }
      if (node.tag !== "token") continue;
      // An import declaration is read as a whole, before `using` is read as
      // the declaration keyword it is everywhere else.
      if (node.raw === "import") {
        const end = readImportDeclaration(nodes, at, into);
        if (end !== undefined) at = end;
        continue;
      }
      // `# let (name = value) { body }` names the variable of a `#let`, which
      // the expansion declares itself where the body needs one.
      const afterHash =
        nodes[at - 1]?.tag === "token" &&
        (nodes[at - 1] as TokenSyntax).raw === "#";
      if (valueDeclarationKeywords.has(node.raw) && !afterHash) {
        addBinders(bindingSegments(nodes, at + 1), into);
        continue;
      }
      const named = namedDeclarations.get(node.raw);
      if (named !== undefined) {
        const name = nodes[at + 1];
        if (name?.tag === "token" && name.kind === "identifier") {
          if (named !== "type") recordValue(into, name.raw);
          if (named !== "value") recordType(into, name.raw);
        }
        continue;
      }
      // An arrow's single parameter is written without parentheses.
      const following = nodes[at + 1];
      if (
        node.kind === "identifier" &&
        following?.tag === "token" &&
        following.raw === "=>"
      )
        recordValue(into, node.raw);
    }
  };

  /**
   * What the declarations inside `node` bind in the region around it: a
   * statement or item node is not a region of its own, so what it declares
   * belongs to the list it stands in.
   */
  const bindingsFrom = (node: SyntaxWithChildren): RegionBindings => {
    const read = outwardBindings.get(node);
    if (read !== undefined) return read;
    const into = collecting();
    collect(node.children, true, into);
    const bindings = bindingsOf(into);
    outwardBindings.set(node, bindings);
    return bindings;
  };

  /**
   * What a parenthesis group binds where it is not a parameter list: the
   * binders of a `for` head, and of whatever a parenthesized expression holds.
   */
  const bindingsWithin = (node: SyntaxWithChildren): RegionBindings => {
    const read = innerBindings.get(node);
    if (read !== undefined) return read;
    const into = collecting();
    collect(node.children, false, into);
    const bindings = bindingsOf(into);
    innerBindings.set(node, bindings);
    return bindings;
  };

  const regionBindings = (sequence: SyntaxSequence): RegionBindings => {
    if (extractBinders === undefined) return noBindings;
    const into = collecting();
    collect(sequence, false, into);
    return bindingsOf(into);
  };

  /**
   * Whether the syntax walked so far heads an import or an export declaration:
   * the `import` or `export` that opens one, read at the start of what is
   * being walked, since a declaration is walked as a statement of its own.
   */
  const declaresModuleNames = (preceding: readonly Syntax[]): boolean => {
    const head = preceding[0];
    return (
      head?.tag === "token" && (head.raw === "import" || head.raw === "export")
    );
  };

  /**
   * Whether the brace group written next is an import or export specifier
   * list: `import { a as b } from "m"`, `export { a, b }`, `export { a } from
   * "m"`, each of which may write a `type` modifier first, and an import that
   * names its default binding before the list.
   *
   * What stands between those braces is a specifier. It names an export of a
   * module, or the local binding an export clause re-exports, and no rule can
   * match across it: nothing in one is an invocation, so the list is emitted
   * as it was written. Walking it dispatched a macro on the spelling of
   * someone else's export and rejected `export { twice } from "./other.js"`,
   * which is ordinary TypeScript.
   */
  const specifierListFollows = (preceding: readonly Syntax[]): boolean => {
    if (!declaresModuleNames(preceding)) return false;
    let at = 1;
    const spelt = (node: Syntax | undefined, raw: string): boolean =>
      node?.tag === "token" && node.raw === raw;
    if (spelt(preceding[at], "type")) at += 1;
    // `import name, { a } from "m"` binds its default before the list.
    const binding = preceding[at];
    if (binding?.tag === "token" && binding.kind === "identifier") {
      if (!spelt(preceding[at + 1], ",")) return false;
      at += 2;
    }
    return at === preceding.length;
  };

  /**
   * Whether the name written next is the one a namespace import or export
   * introduces: the `ns` of `import * as ns from "m"` and of `export * as ns
   * from "m"`. It is the same specifier position, written without braces.
   *
   * The `as` of a type assertion has an operand in front of it rather than a
   * `*`, so `export const p = [] as boxed;` still reads its type.
   */
  const namesNamespaceAlias = (preceding: readonly Syntax[]): boolean => {
    if (!declaresModuleNames(preceding)) return false;
    const previous = preceding.at(-1);
    const before = preceding.at(-2);
    return (
      previous?.tag === "token" &&
      previous.raw === "as" &&
      before?.tag === "token" &&
      before.raw === "*"
    );
  };

  /** Tokens after which an assignment expression, and so an arrow, begins. */
  const assignmentExpressionHeads = new Set([
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**=",
    "<<=",
    ">>=",
    ">>>=",
    "&=",
    "|=",
    "^=",
    "&&=",
    "||=",
    "??=",
    ",",
    "?",
    ":",
    "=>",
    ";",
    "...",
    "return",
    "yield",
    "throw",
    "default",
    "case",
    "else",
    "do",
    "in",
    "of",
  ]);

  /**
   * Where the syntax before an arrow's head ends, when the head ends at `end`
   * in `run`: `async` and a type parameter list are read past. Undefined where
   * a type parameter list does not close.
   */
  const arrowHeadBefore = (run: SyntaxRun, end: number): number | undefined => {
    let at = end - 1;
    if (angles(nodeAt(run, at), ">") > 0) {
      let depth = 0;
      for (; at >= 0; at -= 1) {
        const node = nodeAt(run, at)!;
        depth += angles(node, ">") - angles(node, "<");
        if (depth <= 0) break;
      }
      if (at < 0) return undefined;
      at -= 1;
    }
    const modifier = nodeAt(run, at);
    if (modifier?.tag === "token" && modifier.raw === "async") at -= 1;
    return at;
  };

  /**
   * Whether an arrow's parameters can begin at `end` in `run`. An arrow is an
   * assignment expression, so it begins where one does: at the start of a
   * group or a statement, or after an assignment, a comma, a conditional's `?`
   * or `:`, `=>`, `return` and the like. A parenthesis group after an operand
   * -- a name, a literal, a closing group, a member access -- is that operand's
   * argument list, and after any other operator it is a parenthesized operand;
   * neither is ever an arrow's parameters, whatever follows it.
   */
  const arrowParametersCanFollow = (run: SyntaxRun, end: number): boolean => {
    const at = arrowHeadBefore(run, end);
    if (at === undefined) return false;
    const previous = nodeAt(run, at);
    if (previous === undefined) return true;
    if (previous.tag === "group") return previous.delimiter === "brace";
    if (previous.tag === "protected") return previous.category !== "expr";
    return (
      previous.tag === "token" && assignmentExpressionHeads.has(previous.raw)
    );
  };

  /**
   * Where the `=>` of an arrow stands in `run`, when the parameter list whose
   * head ends at `end` begins one and what follows it stands at `start`.
   *
   * A return type may stand between the parameters and `=>`, and where the
   * parameters follow a conditional's `?` it reads only under the rule
   * `returnTypeReadsInConsequent` states.
   */
  const arrowAfterParameters = (
    run: SyntaxRun,
    end: number,
    start: number,
  ): number | undefined => {
    if (!arrowParametersCanFollow(run, end)) return undefined;
    const spelled = (node: Syntax | undefined, raw: string): boolean =>
      node?.tag === "token" && node.raw === raw;
    if (spelled(nodeAt(run, start), "=>")) return start;
    if (!spelled(nodeAt(run, start), ":")) return undefined;
    const length = runLength(run);
    let arrow = start + 1;
    let typeArguments = 0;
    for (; arrow < length; arrow += 1) {
      const node = nodeAt(run, arrow)!;
      if (node.tag !== "token") continue;
      const nested = angles(node, "<") - angles(node, ">");
      if (nested !== 0) {
        typeArguments = Math.max(0, typeArguments + nested);
      } else if (typeArguments === 0) {
        if (node.raw === "=>") break;
        if (statementBoundaries.has(node.raw) || node.raw === "=")
          return undefined;
      }
    }
    if (arrow === length) return undefined;
    if (!spelled(nodeAt(run, arrowHeadBefore(run, end)!), "?")) return arrow;
    return returnTypeReadsInConsequent((at) => nodeAt(run, at), arrow)
      ? arrow
      : undefined;
  };

  /**
   * Where a concise arrow body starting at `from` in `nodes` ends. The rule is
   * the enforester's, asked here over an array instead of a cursor; there is
   * no surrounding parse to stop for, because a closure walked as tokens is
   * bounded by whatever holds it.
   */
  const arrowBodyEnd = (
    nodes: readonly Syntax[],
    from: number,
  ): ArrowBodyExtent => arrowBodyExtent((at) => nodes[at], from);

  /**
   * Whether a parenthesis group holds names being bound rather than an
   * expression: a parameter list, or what a `catch` binds.
   */
  const bindsParameters = (nodes: readonly Syntax[], at: number): boolean => {
    const node = nodes[at];
    if (node?.tag !== "group" || node.delimiter !== "parenthesis") return false;
    const previous = nodes[at - 1];
    if (catchBinderFollows(previous)) return true;
    // A control-flow header is not a parameter list, though it is followed by a
    // body like one. What a `for` binds is written with a keyword inside it, so
    // it is found by reading the header rather than by reading its entries.
    if (
      previous?.tag === "token" &&
      ["for", "while", "if", "switch", "with"].includes(previous.raw)
    )
      return false;
    // Read as parameters, a call's arguments -- a heritage clause's among
    // them -- or a conditional's consequent would bind whatever names they
    // held, shadowing a macro written there. A return type may stand between
    // the parameters and the body, so the whole header is read rather than
    // only what comes next. A body already enforested arrives protected rather
    // than as the brace it was read from, which `parameterList` reads through.
    return parameterList(node, runOf(nodes), at);
  };

  /**
   * Whether a `syntax` or `operator` token begins a definition rather than
   * naming something ordinary -- `const syntax = 1` is legal TypeScript, so the
   * shape has to be read, not just the keyword.
   */
  const definitionShapeFollows = (
    sequence: SyntaxSequence,
    at: number,
  ): boolean => {
    const head = sequence[at];
    if (head?.tag !== "token") return false;
    const next = sequence[at + 1];
    if (head.raw === "operator")
      return next?.tag === "group" && next.delimiter === "parenthesis";
    if (next?.tag === "group") return false;
    if (next?.tag !== "token") return false;
    // `syntax class Name { ... }` or `syntax name:category { ... }`.
    if (next.raw === "class") return true;
    const colon = sequence[at + 2];
    if (colon?.tag === "token" && colon.raw === ":") return true;
    // `syntax parameter name:category` and `syntax parameter (%):category`.
    const parameterColon = sequence[at + 3];
    return (
      next.raw === "parameter" &&
      sequence[at + 2] !== undefined &&
      parameterColon?.tag === "token" &&
      parameterColon.raw === ":"
    );
  };

  /** The name a definition declares, for the diagnostic that reports it. */
  const definitionSpelling = (sequence: SyntaxSequence, at: number): string => {
    const first = sequence[at + 1];
    const named = (node: Syntax | undefined): string =>
      node?.tag === "token"
        ? node.raw
        : node?.tag === "group" &&
            node.children.every((child) => child.tag === "token")
          ? node.children.map((child) => (child as TokenSyntax).raw).join("")
          : "this definition";
    if (first?.tag === "token" && first.raw === "class")
      return named(sequence[at + 2]);
    const parameterColon = sequence[at + 3];
    if (
      first?.tag === "token" &&
      first.raw === "parameter" &&
      parameterColon?.tag === "token" &&
      parameterColon.raw === ":"
    )
      return named(sequence[at + 2]);
    return named(first);
  };

  /** Regions enclosing the position being walked, outermost first. */
  const regions: RegionBindings[] = [];

  /**
   * The macro whose expansion hit a bound, once one has. Expansion stops
   * dispatching after that: the bound is global, so every later invocation
   * would reach it again and report the same thing.
   */
  let abortedSpelling: string | undefined;

  /**
   * The `#parameterize` forms enclosing the syntax being walked, innermost
   * last. A syntax parameter found in a body stands for the replacement of the
   * nearest one that names it, and the stack follows expansion rather than the
   * text, so a macro expanded inside a body sees it too -- which is what makes
   * a parameter useful to a template, whose own syntax is written elsewhere.
   */
  interface Parameterization {
    readonly binding: BindingId;
    readonly replacement: SyntaxSequence;
    /** Module whose macros are in scope where the replacement was written. */
    readonly lexicalModule: CompileParsedMacrosResult;
    /** Whether the body must use the parameter. */
    readonly required: boolean;
  }
  /** The parameterizations whose parameter has stood somewhere in their body. */
  const usedParameterizations = new Set<Parameterization>();
  const parameterizations: Parameterization[] = [];

  /**
   * The module a node was written in, read from the module scope every token
   * written in a file carries. A template's tokens keep the scope of the module
   * defining the template, so this answers for them too -- their origin names
   * the call site they were expanded at, which is not where they were written.
   */
  const moduleWrittenIn = (
    syntax: Syntax,
  ): CompileParsedMacrosResult | undefined =>
    (options.modules ?? [options.module]).find(
      (module) =>
        options.scopeStore.size(module.definitionScopes) > 0 &&
        options.scopeStore.subset(module.definitionScopes, syntax.scopes),
    );

  const primaryOrigin = (syntax: Syntax) => {
    const source = options.origins.selectPrimarySource(syntax.origin);
    return source === undefined
      ? undefined
      : {
          sourceId: source.sourceId,
          start: source.span.start,
          end: source.span.end,
          originId: syntax.origin,
        };
  };

  /**
   * Where to report a required parameter the body never used: the body as
   * the call site wrote it. A pipe's body is a capture, and pointing at the
   * template's braces would send the reader into the macro's definition.
   */
  const requiredUseOrigin = (body: Syntax) => {
    const spans = body.tag === "group" ? body.children : [body];
    const sources = spans
      .map((child) => options.origins.selectPrimarySource(child.origin))
      .filter((source) => source !== undefined);
    const first = sources[0];
    if (first === undefined) return primaryOrigin(body);
    const sameFile = sources.filter(
      (source) => source.sourceId === first.sourceId,
    );
    return {
      sourceId: first.sourceId,
      start: Math.min(...sameFile.map((source) => source.span.start)),
      end: Math.max(...sameFile.map((source) => source.span.end)),
      originId: body.origin,
    };
  };

  /**
   * A copy of syntax under new identities. A replacement is spliced in once
   * for every use of its parameter, and a node standing twice in one file is
   * two tokens as far as renaming is concerned -- each occurrence of a name is
   * rewritten by its own identity.
   */
  const freshCopy = (syntax: Syntax): Syntax => {
    switch (syntax.tag) {
      case "token":
        return createToken({ ...syntax, id: options.allocateSyntaxId() });
      case "group":
        return createGroup({
          ...syntax,
          id: options.allocateSyntaxId(),
          open: freshCopy(syntax.open) as TokenSyntax,
          children: syntax.children.map(freshCopy),
          close:
            syntax.close.tag === "token"
              ? (freshCopy(syntax.close) as TokenSyntax)
              : createMissingToken({
                  ...syntax.close,
                  id: options.allocateSyntaxId(),
                }),
        });
      case "protected":
        return createProtectedSyntax({
          ...syntax,
          id: options.allocateSyntaxId(),
          children: syntax.children.map(freshCopy),
        });
      case "root":
        return createRootSyntax({
          ...syntax,
          id: options.allocateSyntaxId(),
          children: syntax.children.map(freshCopy),
        });
    }
  };

  /** Words that stand in front of an operand rather than ending one. */
  const operandIntroducingWords = new Set([
    "await",
    "yield",
    "of",
    "as",
    "satisfies",
  ]);
  const operandKeywords = new Set(["this", "super", "null", "true", "false"]);

  /**
   * Whether what was just walked ends an operand, so that punctuation after it
   * is an operator between two operands rather than the start of a new one.
   *
   * A macro spelled with punctuation -- a syntax parameter written `%` -- is
   * only that macro where an operand begins. `% * 10` begins with one, and
   * `7 % 3` has the remainder operator in the same place a scanner decides
   * between a regular expression and a division: by what stands before it.
   * Dispatching wherever the spelling appeared rewrote every remainder in a
   * file that merely imported the macro.
   */
  const endsOperand = (
    nodes: readonly Syntax[],
    end: number,
    inExpression: boolean,
  ): boolean => {
    const previous = nodes[end - 1];
    if (previous === undefined) return false;
    if (previous.tag === "protected") return previous.category === "expr";
    if (previous.tag === "group") {
      if (previous.delimiter !== "brace") return true;
      // A brace ends an operand when it is an object literal. Where a statement
      // is read it is a block, and after an arrow or a function head it is a
      // body -- neither of which anything is applied to.
      return inExpression && !functionBodyFollows(nodes, end - 1);
    }
    if (previous.tag !== "token") return false;
    switch (previous.kind) {
      case "identifier":
        return !operandIntroducingWords.has(previous.raw);
      case "keyword":
        return operandKeywords.has(previous.raw);
      case "private-identifier":
      case "numeric-literal":
      case "bigint-literal":
      case "string-literal":
      case "regular-expression-literal":
      case "no-substitution-template":
        return true;
      case "punctuation":
        // Postfix after an operand, prefix before one: `x! % 2` against `!%`.
        return (
          ["++", "--", "!"].includes(previous.raw) &&
          endsOperand(nodes, end - 1, inExpression)
        );
      default:
        return false;
    }
  };

  const shadowsMacro = (spelling: string, category: SyntaxCategory): boolean =>
    regions.some((region) =>
      category === "type"
        ? region.types.has(spelling)
        : region.values.has(spelling),
    );

  /**
   * The function bodies enclosing the syntax being walked, innermost last,
   * with the variables `#let` has declared in each. A module is the outermost.
   */
  interface LiftFrame {
    readonly names: TokenSyntax[];
  }
  const liftFrames: LiftFrame[] = [];

  const controlKeywords = new Set([
    "if",
    "while",
    "for",
    "switch",
    "catch",
    "with",
  ]);
  const statementBoundaries = new Set([";", ",", "{", "}"]);

  const lastTokenOf = (node: Syntax | undefined): TokenSyntax | undefined => {
    let current = node;
    while (current !== undefined && current.tag !== "token")
      current =
        current.tag === "group"
          ? current.close.tag === "token"
            ? current.close
            : undefined
          : current.children.at(-1);
    return current;
  };

  /**
   * Whether a brace written after `previous` is a class static block,
   * `static {`.
   */
  const staticBlockFollows = (previous: Syntax | undefined): boolean =>
    previous?.tag === "token" && previous.raw === "static";

  interface BraceHeader {
    readonly opens: "function" | "class" | "interface" | "other";
    /** Where a function's parameter list stands in what precedes the brace. */
    readonly parameters?: number;
    /**
     * Whether `yield` is an expression inside the brace, where the brace
     * decides that for itself: a function body by whether the function is a
     * generator, and a class static block never. Undefined where the brace is
     * inside whatever function holds it.
     */
    readonly yields: boolean | undefined;
    /**
     * Whether `await` is an expression inside the brace, where the brace
     * decides that for itself: a function body by whether the function is
     * async, and a class static block never. Undefined where the brace is
     * inside whatever function holds it -- the body of a `for await` is, like
     * any other block.
     */
    readonly awaits: boolean | undefined;
  }
  const otherBrace: BraceHeader = {
    opens: "other",
    yields: undefined,
    awaits: undefined,
  };
  const classBrace: BraceHeader = {
    opens: "class",
    yields: undefined,
    awaits: undefined,
  };
  const interfaceBrace: BraceHeader = {
    opens: "interface",
    yields: undefined,
    awaits: undefined,
  };
  /**
   * A namespace body, which TypeScript allows only at the top level of a
   * module or of another namespace: it is inside no function, so `yield` never
   * reaches it, and it is not the module's own top level, where `await` is an
   * expression.
   */
  const namespaceBrace: BraceHeader = {
    opens: "other",
    yields: undefined,
    awaits: false,
  };

  /**
   * Where the name of the function whose parameter list stands at `parameters`
   * is written: a type parameter list between the two is read past. A function
   * written `function* (` names itself nothing, and the star stands there
   * instead.
   */
  const functionNameAt = (run: SyntaxRun, parameters: number): number => {
    let at = parameters - 1;
    if (angles(nodeAt(run, at), ">") > 0) {
      let depth = 0;
      for (; at >= 0; at -= 1) {
        const node = nodeAt(run, at)!;
        depth += angles(node, ">") - angles(node, "<");
        if (depth <= 0) break;
      }
      at -= 1;
    }
    return at;
  };

  /**
   * Whether the function whose parameter list stands at `parameters` is a
   * generator. The star is written in front of the name -- `function* name(`,
   * `async *name(`, `static *[key](` -- or in place of one, `function* (`.
   */
  const generatorHeader = (run: SyntaxRun, parameters: number): boolean => {
    const at = functionNameAt(run, parameters);
    const star = (node: Syntax | undefined): boolean =>
      node?.tag === "token" && node.raw === "*";
    return star(nodeAt(run, at)) || star(nodeAt(run, at - 1));
  };

  /**
   * Whether the function whose parameter list stands at `parameters` is async.
   * `async` is written in front of what names the function, with only
   * `function` and a generator's star able to stand between the two:
   * `async name(`, `async function* name(`, `static async *[key](`.
   *
   * It is never written in place of the name, so a function named `async`
   * writes its parameter list where the name is read from and is not one, and
   * it modifies only what stands after it on the same line -- `async` left at
   * the end of its line is a name, and the `function` under it is a plain one.
   */
  const asyncHeader = (run: SyntaxRun, parameters: number): boolean => {
    const spelled = (node: Syntax | undefined, raw: string): boolean =>
      node?.tag === "token" && node.raw === raw;
    let at = functionNameAt(run, parameters);
    // `function* (` and `function (` write no name to read past.
    const named = nodeAt(run, at);
    if (!spelled(named, "*") && !spelled(named, "function")) at -= 1;
    for (; at >= 0; at -= 1) {
      const node = nodeAt(run, at)!;
      if (spelled(node, "async"))
        return asyncModifies(node, nodeAt(run, at + 1));
      if (!spelled(node, "*") && !spelled(node, "function")) return false;
    }
    return false;
  };

  /**
   * What a brace group opens, read from what stands before it: the body of a
   * function, arrow or method, and whether that function is a generator and
   * whether it is async; the body of a class; or anything else -- a block, an
   * object literal, a `switch`, a class static block. The brace stands at
   * `end` in `run`, and only the syntax written before it is consulted, as
   * `functionBodyFollows` does.
   */
  const braceHeader = (run: SyntaxRun, end: number): BraceHeader => {
    const previous = nodeAt(run, end - 1);
    // An arrow is never a generator. Whether it is async is decided where the
    // arrow begins, which is behind its parameters rather than behind its
    // `=>`, so the body inherits what was decided on the way in.
    if (lastTokenOf(previous)?.raw === "=>")
      return { opens: "function", yields: false, awaits: undefined };
    // A static block is evaluated as a function of its own, where neither
    // `yield` nor `await` is an expression.
    if (staticBlockFollows(previous))
      return { opens: "other", yields: false, awaits: false };
    // The header is read back to where the statement or member began. A
    // class body is recognized by its keyword, which also covers
    // `class A extends mixin(B) {` with a parameter list in front of its body.
    let parameters: number | undefined;
    // Type arguments in a return type hold commas of their own:
    // `Generator<number, number, number>`.
    let typeArguments = 0;
    for (let at = end - 1; at >= 0; at -= 1) {
      const node = nodeAt(run, at)!;
      if (node.tag === "token") {
        typeArguments += angles(node, ">");
        const opens = angles(node, "<");
        if (opens > 0) {
          // A `<` with no `>` of its own behind the brace encloses it: the
          // brace is written among type arguments, where it is an object
          // type and its body is a member list. What stands before that `<`
          // heads the type reference and says nothing about the brace, so
          // reading on reached the `class` of `class C extends
          // make<{ a: 1 }>() {}` and took the object type for a class body.
          if (opens > typeArguments) return interfaceBrace;
          typeArguments -= opens;
          continue;
        }
        if (typeArguments > 0) continue;
        if (node.raw === "class") return classBrace;
        if (node.raw === "namespace" || node.raw === "module")
          return namespaceBrace;
        // An interface body is a member list, and so is an object type
        // written in what the interface extends: `interface I extends
        // Pick<{ a: 1 }, "a">`. Only a module-level interface is read by the
        // item consumer, so this is how a body nested any deeper -- inside a
        // namespace, a `declare global`, a function body, an item recovery
        // swallowed -- is recognized as the member list it is.
        if (node.raw === "interface") return interfaceBrace;
        if (
          statementBoundaries.has(node.raw) ||
          node.raw === "=" ||
          node.raw === "?"
        )
          break;
        // A return type annotation stands between a parameter list and the
        // body: `m(): Promise<T> {`. A colon with nothing after it annotates
        // nothing, and is a `case (x): {` or the `: {` of a conditional.
        const before = nodeAt(run, at - 1);
        if (
          parameters === undefined &&
          node.raw === ":" &&
          at !== end - 1 &&
          before?.tag === "group" &&
          before.delimiter === "parenthesis"
        )
          parameters = at - 1;
        continue;
      }
      // A brace where a return type is written is an object type, and the
      // header reads on past it.
      if (
        node.tag === "group" &&
        node.delimiter === "brace" &&
        !typeOperandFollows(nodeAt(run, at - 1))
      )
        break;
    }
    if (previous?.tag === "group" && previous.delimiter === "parenthesis")
      parameters = end - 1;
    if (parameters === undefined) return otherBrace;
    const opener = nodeAt(run, parameters - 1);
    const functionBrace: BraceHeader = {
      opens: "function",
      parameters,
      yields: generatorHeader(run, parameters),
      awaits: asyncHeader(run, parameters),
    };
    // A function, method or accessor names itself, or is `function` or `*`;
    // a computed name is a bracket group and a generic one ends in `>`.
    if (opener?.tag === "group")
      return opener.delimiter === "bracket" ? functionBrace : otherBrace;
    if (opener?.tag !== "token") return otherBrace;
    if (controlKeywords.has(opener.raw)) return otherBrace;
    if (
      opener.raw === "await" &&
      lastTokenOf(nodeAt(run, parameters - 2))?.raw === "for"
    )
      return otherBrace;
    return opener.kind === "identifier" ||
      opener.kind === "keyword" ||
      opener.kind === "string-literal" ||
      opener.kind === "numeric-literal" ||
      opener.raw === "*" ||
      angles(opener, ">") > 0
      ? functionBrace
      : otherBrace;
  };

  const braceOpens = (
    run: SyntaxRun,
    end: number,
  ): "function" | "class" | "interface" | "other" =>
    braceHeader(run, end).opens;

  /** Whether a node is a brace group, or a protected body holding only one. */
  const braceBody = (node: Syntax): boolean =>
    node.tag === "group"
      ? node.delimiter === "brace"
      : node.tag === "protected" &&
        node.children.length === 1 &&
        node.children[0]!.tag === "group" &&
        node.children[0]!.delimiter === "brace";

  /**
   * Whether a bracket group written next in a class body is a computed member
   * name: `member`, the member read so far, holds only decorators and
   * modifiers. An index signature's brackets hold a parameter and its type,
   * `[key: string]`, and are not a name.
   */
  const computedMemberNameFollows = (
    member: readonly Syntax[],
    group: Extract<Syntax, { readonly tag: "group" }>,
  ): boolean => {
    const annotated = group.children[1];
    if (annotated?.tag === "token" && annotated.raw === ":") return false;
    return classMemberNameFollows(member);
  };

  /**
   * Whether `group`, which stands at `at` in `run`, is a function's parameter
   * list: an arrow's, where an arrow can begin and with `=>` after it and any
   * return type, or the one the header of the body after it names. An object
   * type written as a return type is passed over on the way to the body.
   *
   * The group is passed as well as its position because a node walked into on
   * its own -- a capture a `#core` template holds -- stands after the run
   * rather than in it.
   */
  const parameterList = (
    group: Syntax | undefined,
    run: SyntaxRun,
    at: number,
  ): boolean => {
    if (group?.tag !== "group" || group.delimiter !== "parenthesis")
      return false;
    if (arrowAfterParameters(run, at, at + 1) !== undefined) return true;
    const length = runLength(run);
    let typeArguments = 0;
    for (let scan = at + 1; scan < length; scan += 1) {
      const node = nodeAt(run, scan)!;
      if (node.tag === "token") {
        if (scan === at + 1 && node.raw !== ":") return false;
        const nested = angles(node, "<") - angles(node, ">");
        if (nested !== 0) {
          typeArguments = Math.max(0, typeArguments + nested);
        } else if (typeArguments === 0) {
          // An arrow's own `=>` was answered above, so one here belongs to a
          // function type written in the return type: `m(): () => T {`.
          if (statementBoundaries.has(node.raw) || node.raw === "=")
            return false;
        }
        continue;
      }
      if (typeArguments > 0) continue;
      if (!braceBody(node)) {
        if (scan === at + 1) return false;
        continue;
      }
      if (typeOperandFollows(nodeAt(run, scan - 1))) continue;
      return braceHeader(run, scan).parameters === at;
    }
    return false;
  };

  /**
   * The contexts inside `node`, which stands at `at` in `run`. Whether `yield`
   * and `await` are expressions is decided by the function the syntax is
   * written directly in, so a function body is a generator or not, and async
   * or not, by its own header -- `function*`, `async *method()` -- whatever
   * function encloses it. An arrow is never a generator and is async only
   * where it is written `async`. A parameter list, even an async generator's,
   * and a class static block admit neither. Any other group, a block or an
   * object literal or an argument list, is inside whatever function holds it
   * and inherits.
   */
  const contextsWithin = (
    node: Syntax,
    run: SyntaxRun,
    at: number,
    inherited: ReadonlySet<MacroContext>,
  ): ReadonlySet<MacroContext> => {
    if (node.tag === "protected" && node.form === "arrow")
      return withinArrow(inherited, asyncArrowHead(node.children));
    if (braceBody(node)) {
      const header = braceHeader(run, at);
      return withAwait(withYield(inherited, header.yields), header.awaits);
    }
    if (parameterList(node, run, at))
      return withAwait(withYield(inherited, false), false);
    return inherited;
  };

  /** `contexts` inside an arrow, which is a generator in no case and async in `async`'s. */
  const withinArrow = (
    contexts: ReadonlySet<MacroContext>,
    async: boolean,
  ): ReadonlySet<MacroContext> => withAwait(withYield(contexts, false), async);

  /**
   * `contexts` with `context` held or not, as `held` says; unchanged where it
   * is undefined.
   */
  const withContext = (
    contexts: ReadonlySet<MacroContext>,
    context: MacroContext,
    held: boolean | undefined,
  ): ReadonlySet<MacroContext> => {
    if (held === undefined || contexts.has(context) === held) return contexts;
    const changed = new Set(contexts);
    if (held) changed.add(context);
    else changed.delete(context);
    return changed;
  };

  /** `contexts` with `yield` an expression or not, as `yields` says. */
  const withYield = (
    contexts: ReadonlySet<MacroContext>,
    yields: boolean | undefined,
  ): ReadonlySet<MacroContext> => withContext(contexts, "generator", yields);

  /** `contexts` with `await` an expression or not, as `awaits` says. */
  const withAwait = (
    contexts: ReadonlySet<MacroContext>,
    awaits: boolean | undefined,
  ): ReadonlySet<MacroContext> => withContext(contexts, "async", awaits);

  /**
   * Where a function, arrow or class written as tokens ends, when one begins
   * at `at`: the index just past it. Syntax a template spliced into a group
   * is not parsed, so a closure there is a run of tokens rather than one node.
   * An arrow's body runs to the next `,` or `;` standing beside it.
   *
   * An arrow is told apart from a `function` because the two differ in what
   * they are: an arrow is never a generator, so `yield` is not an expression
   * anywhere in it, while a `function*` written here opens one. `async` says
   * whether the closure is async, which is what decides `await` in its body.
   */
  const closureEndAt = (
    nodes: readonly Syntax[],
    at: number,
  ):
    | {
        readonly end: number;
        readonly kind: "function" | "class" | "arrow";
        readonly async: boolean;
      }
    | undefined => {
    const token = (offset: number, raw: string) => {
      const node = nodes[offset];
      return node?.tag === "token" && node.raw === raw;
    };
    const braceAfter = (from: number) => {
      for (let index = from; index < nodes.length; index += 1) {
        const node = nodes[index]!;
        // A brace where a return type is written is an object type.
        if (
          node.tag === "group" &&
          node.delimiter === "brace" &&
          !typeOperandFollows(nodes[index - 1])
        )
          return index + 1;
        if (node.tag === "token" && (node.raw === "," || node.raw === ";"))
          return undefined;
      }
      return undefined;
    };
    // `task.class` and `task.function` name properties.
    if (token(at - 1, ".") || token(at - 1, "?.")) return undefined;
    // `async` modifies what is written after it on the same line; left alone
    // on its own line it is an ordinary name, and the closure under it is one
    // of its own. The enforestation route reads it by the same rule.
    const async = asyncModifies(nodes[at], nodes[at + 1]);
    const start = async ? at + 1 : at;
    if (token(start, "function")) {
      const end = braceAfter(start + 1);
      return end === undefined ? undefined : { end, kind: "function", async };
    }
    if (at === start && token(at, "class")) {
      const end = braceAfter(at + 1);
      return end === undefined ? undefined : { end, kind: "class", async };
    }
    const parameters = nodes[start];
    const named =
      parameters?.tag === "token" && parameters.kind === "identifier";
    const listed =
      parameters?.tag === "group" && parameters.delimiter === "parenthesis";
    if (!named && !listed) return undefined;
    const run = runOf(nodes);
    const arrow = listed
      ? arrowAfterParameters(run, start, start + 1)
      : arrowParametersCanFollow(run, start) &&
          // `async v\n=> v` is `async v` and then a syntax error, while
          // `v\n=> v` is an arrow: the no-line-break rule before the `=>`
          // belongs to the async form alone.
          (async
            ? asyncNamedArrow(nodes[at], nodes[start], nodes[start + 1])
            : token(start + 1, "=>"))
        ? start + 1
        : undefined;
    if (arrow === undefined) return undefined;
    const { end } = arrowBodyEnd(nodes, arrow + 1);
    // An arrow writes `async` in front of its type parameters as readily as in
    // front of its parameters, so the closure can begin further back than the
    // parameters this was asked about; `arrowHeadBefore` reads past both.
    const head = arrowHeadBefore(run, start);
    return end === arrow + 1
      ? undefined
      : {
          end,
          kind: "arrow",
          async:
            head !== undefined &&
            asyncModifies(nodes[head + 1], nodes[head + 2]),
        };
  };

  /**
   * Whether evaluating syntax may suspend the function it stands in: an
   * `await` or `yield` that belongs to that function rather than to one
   * written inside it. Such syntax cannot be moved into a function of its
   * own, which is what `#let` otherwise does with its body.
   */
  const suspends = (nodes: readonly Syntax[]): boolean => {
    for (let at = 0; at < nodes.length; at += 1) {
      const closure = closureEndAt(nodes, at);
      if (closure !== undefined) {
        // A class's heritage is evaluated where the class is; its body and a
        // function's are not.
        if (
          closure.kind === "class" &&
          suspends(nodes.slice(at, closure.end - 1))
        )
          return true;
        at = closure.end - 1;
        continue;
      }
      const node = nodes[at]!;
      if (node.tag === "token") {
        // `task.await` names a property, not an operator.
        const before = nodes[at - 1];
        if (
          (node.raw === "await" || node.raw === "yield") &&
          !(
            before?.tag === "token" &&
            (before.raw === "." || before.raw === "?.")
          )
        )
          return true;
        continue;
      }
      if (node.tag === "protected") {
        if (
          node.form !== "arrow" &&
          node.category !== "classElement" &&
          suspends(node.children)
        )
          return true;
        continue;
      }
      if (node.tag === "group") {
        const opens =
          node.delimiter === "brace" ? braceOpens(runOf(nodes), at) : "other";
        if (
          opens !== "function" &&
          opens !== "class" &&
          suspends(node.children)
        )
          return true;
      }
    }
    return false;
  };

  /** Whether syntax reads the variable a `#let` named: its spelling and scopes. */
  const readsBinding = (nodes: readonly Syntax[], name: TokenSyntax): boolean =>
    nodes.some((node) =>
      node.tag === "token"
        ? node.raw === name.raw && node.scopes === name.scopes
        : node.tag === "group" || node.tag === "protected"
          ? readsBinding(node.children, name)
          : false,
    );

  /** An arrow, `function`, or `class` written as an expression. */
  const isFunctionExpression = (node: Syntax): boolean => {
    if (node.tag !== "protected" || node.category !== "expr") return false;
    if (node.form === "arrow") return true;
    const [first, second] = node.children;
    const head =
      first?.tag === "token" && first.raw === "async" ? second : first;
    return (
      head?.tag === "token" && (head.raw === "function" || head.raw === "class")
    );
  };

  /**
   * The body of a `#let` whose variable is declared in the enclosing function,
   * with each function in it that reads the variable given a copy of its own.
   *
   * The variable is one per call of that function, and a second evaluation of
   * the same `#let` in the call -- the next time around a loop -- assigns it
   * again. A closure that read the variable itself saw that later value, so
   * `for (const id of ids) getters.push(id |> (await load(%), () => %))` made
   * every getter return the last id. Taking the value when the closure is
   * created keeps the one its evaluation had; and TypeScript, which cannot
   * follow the variable's assignments into a closure, types the copy from
   * the value it is given.
   */
  const capturingClosures = (
    nodes: readonly Syntax[],
    name: TokenSyntax,
  ): SyntaxSequence => {
    const output: Syntax[] = [];
    const cannotCopy = (at: Syntax) => {
      const origin = primaryOrigin(at);
      if (origin === undefined)
        throw new TypeError(
          "Syntax that cannot take a copy of a #let variable has no source to report it at",
        );
      diagnostics.push(
        expansionDiagnosticRegistry.create(uncopiableClosureCode, {
          primaryOrigin: origin,
          messageArguments: [],
        }),
      );
    };
    for (let at = 0; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      const closure = closureEndAt(nodes, at);
      if (closure !== undefined) {
        const run = nodes.slice(at, closure.end);
        at = closure.end - 1;
        if (!readsBinding(run, name)) {
          output.push(...run);
        } else if (closure.kind === "class" && suspends(run)) {
          cannotCopy(run[0]!);
          output.push(...run);
        } else output.push(copyingInto(expressionOf(name, run), name));
        continue;
      }
      if (
        node.tag === "token" ||
        node.tag === "root" ||
        !readsBinding(node.children, name)
      ) {
        output.push(node);
        continue;
      }
      if (isFunctionExpression(node)) {
        output.push(copyingInto(node, name));
        continue;
      }
      // A method or accessor cannot be taken out of the object literal it is
      // written in, so the literal takes the copy for it.
      const member =
        node.tag === "group" &&
        node.delimiter === "brace" &&
        node.children.some(
          (child, index, members) =>
            child.tag === "group" &&
            child.delimiter === "brace" &&
            braceOpens(runOf(members), index) === "function" &&
            readsBinding(child.children, name),
        );
      if (member) {
        if (suspends(node.children)) {
          cannotCopy(node);
          output.push(node);
        } else output.push(copyingInto(node, name));
        continue;
      }
      const children = capturingClosures(node.children, name);
      output.push(
        node.tag === "group"
          ? createGroup({ ...node, id: options.allocateSyntaxId(), children })
          : createProtectedSyntax({
              ...node,
              id: options.allocateSyntaxId(),
              children,
            }),
      );
    }
    return createSyntaxSequence(output);
  };

  /** `((name) => (expression))(name)`. */
  const copyingInto = (expression: Syntax, name: TokenSyntax): Syntax => {
    const copy = () =>
      createToken({
        ...name,
        id: options.allocateSyntaxId(),
        leadingTrivia: [],
      });
    return expressionOf(name, [
      writtenGroup(name, "parenthesis", [
        writtenGroup(name, "parenthesis", [copy()]),
        writtenToken(name, "=>", "punctuation"),
        writtenGroup(name, "parenthesis", [expression]),
      ]),
      writtenGroup(name, "parenthesis", [copy()]),
    ]);
  };

  /** A token the expansion writes itself, anchored on the syntax it serves. */
  const writtenToken = (
    anchor: Syntax,
    raw: string,
    kind: TokenSyntax["kind"],
  ): TokenSyntax =>
    createToken({
      id: options.allocateSyntaxId(),
      span: { start: anchor.span.start, end: anchor.span.start },
      // Written by the expansion rather than by a template, so no layout of
      // a template's is read from it.
      origin: options.origins.synthesized(anchor.origin, "generated-binding"),
      scopes: anchor.scopes,
      kind,
      raw,
      leadingTrivia: [],
    });

  const writtenGroup = (
    anchor: Syntax,
    delimiter: "parenthesis" | "brace",
    children: readonly Syntax[],
  ): Syntax =>
    createGroup({
      id: options.allocateSyntaxId(),
      span: anchor.span,
      origin: anchor.origin,
      scopes: anchor.scopes,
      delimiter,
      open: writtenToken(
        anchor,
        delimiter === "brace" ? "{" : "(",
        "punctuation",
      ),
      close: writtenToken(
        anchor,
        delimiter === "brace" ? "}" : ")",
        "punctuation",
      ),
      children,
    });

  const expressionOf = (anchor: Syntax, children: readonly Syntax[]) => {
    if (children.length === 0)
      throw new TypeError("An expression the expansion writes cannot be empty");
    const [sole] = children;
    return children.length === 1 &&
      sole!.tag === "protected" &&
      sole!.category === "expr"
      ? sole!
      : createProtectedSyntax({
          id: options.allocateSyntaxId(),
          span: spanEnvelope([anchor, ...children].map(({ span }) => span)),
          origin: anchor.origin,
          scopes: anchor.scopes,
          category: "expr",
          children,
        });
  };

  /** `let a, b;` for the variables a frame collected. */
  const liftedDeclaration = (anchor: Syntax, names: readonly TokenSyntax[]) => [
    writtenToken(anchor, "let", "keyword"),
    ...names.flatMap((name, at) => [
      ...(at === 0 ? [] : [writtenToken(anchor, ",", "punctuation")]),
      createToken({
        ...name,
        id: options.allocateSyntaxId(),
        // The name is the template's own token, whose layout would be kept;
        // the space in front of it here is the declaration's.
        leadingTrivia: [
          createTrivia({
            kind: "whitespace",
            raw: " ",
            span: { start: name.span.start, end: name.span.start },
          }),
        ],
      }),
    ]),
    writtenToken(anchor, ";", "punctuation"),
  ];

  /**
   * Where a statement list's own statements begin: after any directive, so a
   * declaration put in front of them does not end a `"use strict"` prologue.
   */
  const afterDirectives = (children: readonly Syntax[]): number => {
    let at = 0;
    while (at < children.length) {
      const node = children[at]!;
      const tokens =
        node.tag === "protected" ? node.children : [node, children[at + 1]];
      const [written, end] = tokens;
      // A directive enforested as a statement holds its string as an
      // expression of one token.
      const literal =
        written?.tag === "protected" && written.children.length === 1
          ? written.children[0]
          : written;
      if (literal?.tag !== "token" || literal.kind !== "string-literal") break;
      if (end?.tag !== "token" || end.raw !== ";") break;
      at += node.tag === "protected" ? 1 : 2;
    }
    return at;
  };

  /** A statement list with `let` for the names in front of its statements. */
  const declaringFirst = (
    statements: readonly Syntax[],
    names: readonly TokenSyntax[],
  ): SyntaxSequence => {
    const at = afterDirectives(statements);
    return createSyntaxSequence([
      ...statements.slice(0, at),
      ...liftedDeclaration(names[0]!, names),
      ...statements.slice(at),
    ]);
  };

  /**
   * An arrow whose concise body needs a variable declared for it, rewritten
   * with a block body that declares it and returns what the body did.
   */
  const withConciseBodyDeclaring = (
    arrow: readonly Syntax[],
    names: readonly TokenSyntax[],
  ): SyntaxSequence => {
    let head = arrow.length - 1;
    while (head >= 0) {
      const node = arrow[head]!;
      if (node.tag === "token" && node.raw === "=>") break;
      head -= 1;
    }
    if (head < 0)
      throw new TypeError(
        "An arrow expression has no `=>` to split its body at",
      );
    const anchor = names[0]!;
    const body = arrow.slice(head + 1);
    return createSyntaxSequence([
      ...arrow.slice(0, head + 1),
      writtenGroup(anchor, "brace", [
        ...liftedDeclaration(anchor, names),
        writtenToken(anchor, "return", "keyword"),
        expressionOf(anchor, body),
        writtenToken(anchor, ";", "punctuation"),
      ]),
    ]);
  };

  const visit = (
    initialInput: SyntaxSequence,
    environment: BindingEnvironment,
    category: SyntaxCategory,
    parentInvocation: InvocationId | undefined,
    lexicalModule: CompileParsedMacrosResult,
    enclosingContexts: ReadonlySet<MacroContext>,
    suppressHead = false,
    recursiveBinding?: BindingId,
    /**
     * Whether what is walked is one member of an object literal. A member is
     * an expression everywhere but in its name, and a method's name is written
     * where an expression would otherwise begin.
     */
    objectMember = false,
    /**
     * Whether this run is the inside of a parenthesis or bracket group that
     * took the category of the syntax around it: a parameter list, an
     * argument list, an index. Such a run holds no statements, however the
     * declaration enclosing it is walked, so nothing in it begins one and
     * nothing in it carries a label.
     */
    groupInterior = false,
  ): {
    readonly syntax: SyntaxSequence;
    readonly environment: BindingEnvironment;
  } => {
    let contexts = enclosingContexts;
    /**
     * `contexts` as the syntax around this walk gives them, before the arrow
     * region below narrows them. Every other place that decides the contexts
     * of this run writes here, so leaving an arrow restores what it found.
     */
    let regionContexts = enclosingContexts;
    /**
     * The arrows this walk stands inside, innermost last: where each ends, as
     * an index into `input`, and whether it is async.
     *
     * An arrow is never a generator, so `yield` is not an expression anywhere
     * in one however the function around it is written, and it is async only
     * where it is written `async`, whatever the function around it is. Where
     * the arrow is a node, `contextsWithin` answers for it on the way in.
     * Where it is only a run of tokens -- a replacement before it is parsed, a
     * block holding a statement operator, which is walked raw by design --
     * there is nothing to descend into, and the contexts of the function
     * around it reached the arrow's body: a macro declared `context generator`
     * was admitted there and wrote a `yield` inside an arrow, which TypeScript
     * then reports on generated code.
     *
     * An arrow written as another's body is a function of its own and answers
     * for itself, so they are held as a stack rather than as the one innermost:
     * `async (v) => () => …` is async outside the nested arrow and plain inside
     * it, and `(v) => async () => …` the other way about. The inner arrow may
     * also end before the outer does -- it ends at the `:` of a conditional
     * written around it -- and what follows is back inside the outer arrow.
     */
    const openArrows: { readonly end: number; readonly async: boolean }[] = [];
    /** `contexts` as the innermost open arrow, if any, narrows `next`. */
    const withinOpenArrow = (
      next: ReadonlySet<MacroContext>,
    ): ReadonlySet<MacroContext> => {
      const innermost = openArrows.at(-1);
      return innermost === undefined
        ? next
        : withinArrow(next, innermost.async);
    };
    const enterRegionContexts = (next: ReadonlySet<MacroContext>) => {
      regionContexts = next;
      contexts = withinOpenArrow(next);
    };
    let input = initialInput;
    regions.push(regionBindings(initialInput));
    const output: Syntax[] = [];
    /**
     * Everything walked so far, read by position. The array is held rather
     * than copied, so this reads what has been walked at the moment it is
     * asked and one run serves the whole walk.
     */
    const walkedRun = runOf(output);
    /**
     * Everything walked so far and then what is yet to be walked, read from
     * `from` on. A rule that reads across the two -- a parameter list and the
     * body its header names -- is given this rather than the two joined.
     */
    const runAhead = (from: number): SyntaxRun => ({
      walked: output,
      following: input,
      from,
    });
    let currentEnvironment = environment;
    let index = 0;
    let suppressPending = suppressHead;
    let suppressedHeadIndex: number | undefined;
    /**
     * Whether the position being walked stands inside an expression. A
     * replacement is walked before it is parsed, so the category of a position
     * in it cannot be read from the one token in front of it: `f(inner(2))`,
     * `1 && inner(2)` and `() => inner(2)` all put an expression several tokens
     * past the `=` that opened it. Reading only that one token left a macro
     * written in any of them resolved in the category of the declaration around
     * it, found nothing, and emitted the invocation verbatim as a call to a
     * function that does not exist. A region opens where an expression begins
     * and runs to the end of the statement.
     */
    let expressionRegion = false;
    /**
     * Whether the position being walked stands in a function's return type.
     * It opens at the `:` after a parameter list and runs to the body or the
     * arrow that the function ends its header with; a function type written
     * inside it has an arrow of its own, which does not end it.
     */
    let typeRegion = false;
    let functionTypes = 0;
    /**
     * Whether the position being walked stands in the type a type alias
     * declares. It opens at the `=` of `type Name =` and runs to the end of
     * that declaration.
     *
     * Unlike a function's return type it is not ended by `=>`: the arrow of a
     * function type stands inside it, and what follows that arrow is the
     * function type's own return type, still a type. Read without the region,
     * the `=>` of `type F = () => { ... }` opened an expression the way an
     * arrow function's does, and the object type after it was walked as a
     * function body.
     */
    let typeAliasRegion = false;
    /** Whether the position being walked stands inside a type. */
    const inTypeRegion = (): boolean => typeRegion || typeAliasRegion;
    /** Where the class member being walked begins in `output`. */
    let memberStart = 0;
    /**
     * Whether what comes next is written where a type is, given everything
     * walked so far. `as` and `satisfies` are the only two of those tokens
     * that are not also an expression's, so an expression asks a narrower
     * question than a declaration does.
     *
     * This is where the walk decides what a position reads, so that a group
     * descended into, a template literal's substitution and a name looked up
     * all agree about it.
     */
    const typeFollows = (): boolean =>
      inTypeRegion() ||
      (category === "expr" || expressionRegion
        ? typeFollowsInExpression(output)
        : typePositionHere());
    /** Whether a run of statements is what is being walked. */
    const statementRun =
      !groupInterior && (category === "stmt" || category === "item");
    /**
     * Whether the `:` written just before `end` in the syntax walked so far
     * labels a statement rather than opening a type. The two are spelled
     * alike, and a run walked as tokens has only the syntax around them to
     * tell them apart: a label is an identifier written where a statement
     * begins, and nothing else is. Read
     * as an annotation, `here: logit(x);` looked the statement macro up among
     * type macros and reported that a statement macro cannot be written where
     * a type is read.
     */
    const labelColonEnds = (end: number): boolean => {
      if (!statementRun) return false;
      const colon = output[end - 1];
      if (colon?.tag !== "token" || colon.raw !== ":") return false;
      const name = output[end - 2];
      return (
        name?.tag === "token" &&
        name.kind === "identifier" &&
        statementStartFollows(end - 2)
      );
    };
    /**
     * Whether a statement begins next: at the head of the run, after the `;`
     * that ended the one before, after a label, and after the body of a
     * function or a class, which the keyword that opened them ends at.
     */
    const statementStartFollows = (end: number): boolean => {
      if (!statementRun) return false;
      const previous = output[end - 1];
      if (previous === undefined) return true;
      // A statement already read as one ends where it ends, however many
      // tokens it holds: an expansion splices its replacement in that way.
      if (previous.tag === "protected")
        return previous.category === "stmt" || previous.category === "item";
      if (previous.tag === "group")
        return (
          previous.delimiter === "brace" &&
          braceOpens(walkedRun, end - 1) !== "other"
        );
      if (previous.tag !== "token") return false;
      return previous.raw === ";" || labelColonEnds(end);
    };
    /**
     * Whether the next node stands where a type is written, discounting the
     * `:` of a label, which annotates nothing.
     */
    const typePositionHere = (): boolean =>
      !labelColonEnds(output.length) && typePositionFollows(output);
    while (index < input.length) {
      const node = input[index]!;
      const walked = output.at(-1);
      if (!typeRegion && walked?.tag === "token" && walked.raw === ":") {
        const parameters = output.at(-2);
        if (
          parameters?.tag === "group" &&
          parameters.delimiter === "parenthesis" &&
          parameterList(parameters, runAhead(index), output.length - 2)
        ) {
          typeRegion = true;
          functionTypes = 0;
        }
      } else if (typeRegion && walked?.tag === "token") {
        if (walked.raw === "=>") {
          if (functionTypes > 0) functionTypes -= 1;
          else typeRegion = false;
        } else if (
          walked.raw === ";" ||
          walked.raw === "," ||
          walked.raw === "="
        )
          typeRegion = false;
      }
      if (typeRegion) {
        // The brace after the whole type is the function's body.
        if (
          node.tag === "group" &&
          node.delimiter === "brace" &&
          !typeOperandFollows(walked)
        )
          typeRegion = false;
        // A parameter list with an arrow after it belongs to a function type
        // written inside the return type, and that arrow is its own.
        const after = input[index + 1];
        if (
          typeRegion &&
          node.tag === "group" &&
          node.delimiter === "parenthesis" &&
          after?.tag === "token" &&
          after.raw === "=>"
        )
          functionTypes += 1;
      }
      // A class field's initializer is evaluated as a function of its own,
      // where neither `yield` nor `await` is an expression. The rest of a
      // member -- its computed name, a decorator -- is inside whatever
      // function holds the class. A member list the class element reader could
      // not take whole -- one holding a decorator TypeScript rejects -- is
      // walked as tokens, so a member ends where that reader ends one, and the
      // initializer and the expression it began end with it.
      if (category === "classElement") {
        if (classElementEndsBefore(output.slice(memberStart), node)) {
          memberStart = output.length;
          enterRegionContexts(enclosingContexts);
          expressionRegion = false;
        } else if (walked?.tag === "token" && walked.raw === "=")
          enterRegionContexts(
            withAwait(withYield(enclosingContexts, false), false),
          );
      }
      // Each arrow reached is opened and each one left is closed, so that a
      // nested arrow's own header decides the contexts of its body and the
      // arrow around it gets them back when the nested one ends.
      while (openArrows.length > 0 && index >= openArrows.at(-1)!.end)
        openArrows.pop();
      const closure = closureEndAt(input, index);
      if (closure?.kind === "arrow")
        openArrows.push({ end: closure.end, async: closure.async });
      contexts = withinOpenArrow(regionContexts);
      if (walked?.tag === "token") {
        // A declaration keyword ends the declaration before it, so it closes
        // both regions the same way a `;` does.
        if (expressionRegionEnds.has(walked.raw)) {
          expressionRegion = false;
          typeAliasRegion = false;
        } else if (typeAliasInitializerFollows(output)) typeAliasRegion = true;
        else if (
          // Nothing inside the type a type alias declares opens an expression.
          // Its `=>` is a function type's arrow, not an arrow function's.
          !typeAliasRegion &&
          (expressionRegionHeads.has(walked.raw) ||
            // The `=` of a type alias opens a type, not an expression.
            (initializerFollows(output) && !typePositionFollows(output)))
        )
          expressionRegion = true;
      }
      // A statement list holds an expression statement as readily as it holds
      // a declaration, so an expression begins wherever a statement does. A
      // run walked as tokens has no enforested statement to say so, and
      // without this an expression macro written as a statement -- or inside
      // the arguments of the call that is one -- was looked up only among the
      // statement macros, found nowhere, and emitted verbatim as a call to a
      // name the output never defines.
      if (statementStartFollows(output.length)) expressionRegion = true;
      const coreKeyword = input[index + 1];
      const separatedCoreBody = input[index + 2];
      const compactCoreBody = input[index + 1];
      const coreBody =
        node.tag === "token" &&
        node.raw === "#core" &&
        compactCoreBody?.tag === "group" &&
        compactCoreBody.delimiter === "parenthesis"
          ? compactCoreBody
          : node.tag === "token" &&
              node.raw === "#" &&
              coreKeyword?.tag === "token" &&
              coreKeyword.raw === "core" &&
              separatedCoreBody?.tag === "group" &&
              separatedCoreBody.delimiter === "parenthesis"
            ? separatedCoreBody
            : undefined;
      if (coreBody !== undefined) {
        const protectedCapture =
          coreBody.children.length === 1 &&
          coreBody.children[0]?.tag === "protected"
            ? coreBody.children[0]
            : undefined;
        const nested = visit(
          createSyntaxSequence(protectedCapture?.children ?? coreBody.children),
          currentEnvironment,
          protectedCapture?.category ?? category,
          parentInvocation,
          lexicalModule,
          protectedCapture === undefined
            ? contexts
            : contextsWithin(
                protectedCapture,
                walkedRun,
                output.length,
                contexts,
              ),
          true,
          recursiveBinding,
        );
        if (nested.syntax.length === 0) {
          currentEnvironment = nested.environment;
          index += coreBody === compactCoreBody ? 2 : 3;
          continue;
        }
        // Erasing the `#core` marker must not erase the space in front of it,
        // or the item it wraps runs into whatever preceded it.
        const spaced = withLeadingTrivia(
          nested.syntax,
          node.tag === "token" ? node.leadingTrivia : [],
        );
        const origins = [...new Set(spaced.map(({ origin }) => origin))];
        const categorized =
          category === "item"
            ? enforestSequence(spaced, category, lexicalModule, contexts)
            : undefined;
        const completed = createProtectedSyntax({
          id: options.allocateSyntaxId(),
          span: spanEnvelope(spaced.map(({ span }) => span)),
          origin:
            origins.length === 1
              ? origins[0]!
              : options.origins.composed(origins),
          scopes: spaced[0]?.scopes ?? node.scopes,
          category,
          children:
            categorized === undefined
              ? spaced
              : createSyntaxSequence([categorized]),
        });
        output.push(completed);
        currentEnvironment = nested.environment;
        index += coreBody === compactCoreBody ? 2 : 3;
        continue;
      }
      const sourceOf = (syntax: Syntax): SourceId | undefined =>
        options.origins.selectPrimarySource(syntax.origin)?.sourceId;
      const resolveSpelling = (
        spelling: string,
        position: number,
        positionSourceId?: SourceId | undefined,
        lookupCategory: SyntaxCategory = category,
        written: Syntax = node,
      ) => {
        const category = lookupCategory;
        // Template literals use the defining module, but a capture spliced
        // into that template keeps the lexical macro imports of the source in
        // which it was written. Without this, a captured function body inside
        // `#core(function ... $body)` can only see macros imported by the
        // function-shadow definition, not macros imported at its call site.
        if (shadowsMacro(spelling, category)) return undefined;
        // Syntax resolves against the macros in scope where it was written. A
        // template's tokens were written in the module defining the template,
        // whichever file's expansion walks them: an operator's replacement is
        // produced while the call site is read and walked under the call
        // site's module, and resolving there would leave a helper macro the
        // template calls unexpanded unless the call site happens to import it
        // too.
        const lookupModule =
          moduleWrittenIn(written) ??
          (positionSourceId !== undefined &&
          positionSourceId === options.sourceId &&
          !options.scopeStore.hasUnmatchedIntroduction(written.scopes)
            ? options.module
            : lexicalModule);
        const recursiveMacro = lookupModule.get(spelling, category);
        if (
          recursiveBinding !== undefined &&
          recursiveMacro?.binding.id === recursiveBinding
        )
          return recursiveMacro;
        const generatedMacro = activeModules
          .slice(options.modules?.length ?? 1)
          .reverse()
          .map((module) => module.get(spelling, category))
          .find((macro) => macro !== undefined);
        if (generatedMacro !== undefined) return generatedMacro;
        if (options.resolveMacro !== undefined) {
          return options.resolveMacro({
            spelling,
            category,
            modules: activeModules,
            lexicalModule: lookupModule,
            position,
            positionSourceId,
          });
        }
        return options.expansionStore !== undefined &&
          activeExpansionEnvironment !== undefined
          ? activeModules
              .map((module) =>
                resolveCompiledMacro({
                  module,
                  store: options.expansionStore!,
                  environment: activeExpansionEnvironment!,
                  spelling,
                  category,
                  phase: options.phase,
                }),
              )
              .find((macro) => macro !== undefined)
          : [...activeModules]
              .reverse()
              .map((module) => module.get(spelling, category))
              .find((macro) => macro !== undefined);
      };
      const compactLet =
        node.tag === "token" &&
        node.raw === "#let" &&
        input[index + 1]?.tag === "group" &&
        input[index + 2]?.tag === "group";
      const splitLet =
        node.tag === "token" &&
        node.raw === "#" &&
        input[index + 1]?.tag === "token" &&
        (input[index + 1] as TokenSyntax).raw === "let" &&
        input[index + 2]?.tag === "group" &&
        input[index + 3]?.tag === "group";
      if (compactLet || splitLet) {
        const argumentsIndex = index + (compactLet ? 1 : 2);
        const argumentsGroup = input[argumentsIndex] as Extract<
          Syntax,
          { readonly tag: "group" }
        >;
        const body = input[argumentsIndex + 1] as Extract<
          Syntax,
          { readonly tag: "group" }
        >;
        const read =
          argumentsGroup.delimiter === "parenthesis" &&
          body.delimiter === "brace"
            ? readLetBinding(argumentsGroup.children)
            : undefined;
        if (read !== undefined) {
          const value = visit(
            createSyntaxSequence(read.value),
            currentEnvironment,
            "expr",
            parentInvocation,
            lexicalModule,
            contexts,
            false,
            recursiveBinding,
          );
          const expanded = visit(
            body.children,
            value.environment,
            "expr",
            parentInvocation,
            lexicalModule,
            contexts,
            false,
            recursiveBinding,
          );
          currentEnvironment = expanded.environment;
          index = argumentsIndex + 2;
          const empty =
            value.syntax.length === 0
              ? { at: argumentsGroup, part: "value" }
              : expanded.syntax.length === 0
                ? { at: body, part: "body" }
                : undefined;
          if (empty !== undefined) {
            const origin = primaryOrigin(empty.at);
            if (origin === undefined)
              throw new TypeError(
                `The ${empty.part} of #let expanded to nothing, and has no source to report it at`,
              );
            diagnostics.push(
              expansionDiagnosticRegistry.create(unreadableSyntaxCode, {
                primaryOrigin: origin,
                messageArguments: [
                  "an expression",
                  `the ${empty.part} of #let expanded to nothing`,
                ],
              }),
            );
            continue;
          }
          const name = read.name;
          const copy = () =>
            createToken({
              ...name,
              id: options.allocateSyntaxId(),
              leadingTrivia: [],
            });
          const valueExpression = expressionOf(name, value.syntax);
          const frame = liftFrames.at(-1);
          // The body is moved into a function applied to the value, which
          // gives each evaluation a binding of its own -- unless the body
          // suspends the function it stands in, which a nested function
          // cannot do for it. Then the value is assigned to a variable
          // declared in that function, so `await` and `yield` stay in it,
          // and each function in the body that reads the variable takes a
          // copy of its own when it is created.
          const lifted = frame !== undefined && suspends(expanded.syntax);
          if (lifted) frame.names.push(name);
          const bodyExpression = expressionOf(
            name,
            lifted ? capturingClosures(expanded.syntax, name) : expanded.syntax,
          );
          const written = lifted
            ? [
                writtenGroup(name, "parenthesis", [
                  copy(),
                  writtenToken(name, "=", "punctuation"),
                  valueExpression,
                  writtenToken(name, ",", "punctuation"),
                  bodyExpression,
                ]),
              ]
            : [
                writtenGroup(name, "parenthesis", [
                  writtenGroup(name, "parenthesis", [copy()]),
                  writtenToken(name, "=>", "punctuation"),
                  bodyExpression,
                ]),
                writtenGroup(name, "parenthesis", [valueExpression]),
              ];
          output.push(
            ...withLeadingTrivia(
              [expressionOf(node, written)],
              node.tag === "token" ? node.leadingTrivia : [],
            ),
          );
          continue;
        }
      }
      const compactParameterize =
        node.tag === "token" &&
        node.raw === "#parameterize" &&
        input[index + 1]?.tag === "group" &&
        input[index + 2]?.tag === "group";
      const splitParameterize =
        node.tag === "token" &&
        node.raw === "#" &&
        input[index + 1]?.tag === "token" &&
        (input[index + 1] as TokenSyntax).raw === "parameterize" &&
        input[index + 2]?.tag === "group" &&
        input[index + 3]?.tag === "group";
      if (compactParameterize || splitParameterize) {
        const argumentsIndex = index + (compactParameterize ? 1 : 2);
        const argumentsGroup = input[argumentsIndex] as Extract<
          Syntax,
          { readonly tag: "group" }
        >;
        const body = input[argumentsIndex + 1] as Extract<
          Syntax,
          { readonly tag: "group" }
        >;
        const read =
          argumentsGroup.delimiter === "parenthesis" &&
          body.delimiter === "brace"
            ? readParameterization(argumentsGroup.children)
            : undefined;
        if (read !== undefined) {
          const nameNode = read.name[0]!;
          const parameter = (
            [
              "expr",
              "type",
              "stmt",
              "item",
              "binding",
              "classElement",
              "typeMember",
              "jsxChild",
            ] as const
          )
            .map((candidate) =>
              resolveSpelling(
                read.spelling,
                nameNode.span.start,
                sourceOf(nameNode),
                candidate,
                nameNode,
              ),
            )
            .find((candidate) => candidate?.parameter === true);
          if (parameter === undefined) {
            const origin = primaryOrigin(nameNode);
            if (origin !== undefined)
              diagnostics.push(
                expansionDiagnosticRegistry.create(notSyntaxParameterCode, {
                  primaryOrigin: origin,
                  messageArguments: [read.spelling],
                }),
              );
          }
          const parameterization =
            parameter === undefined
              ? undefined
              : Object.freeze({
                  binding: parameter.binding.id,
                  replacement: createSyntaxSequence(read.replacement),
                  lexicalModule: moduleWrittenIn(nameNode) ?? lexicalModule,
                  required: read.required,
                });
          if (parameterization !== undefined)
            parameterizations.push(parameterization);
          let nested;
          try {
            nested = visit(
              body.children,
              currentEnvironment,
              category,
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
          } finally {
            if (parameterization !== undefined) parameterizations.pop();
          }
          if (parameterization !== undefined) {
            const used = usedParameterizations.delete(parameterization);
            const origin = parameterization.required
              ? requiredUseOrigin(body)
              : undefined;
            if (!used && origin !== undefined)
              diagnostics.push(
                expansionDiagnosticRegistry.create(
                  unusedRequiredParameterCode,
                  { primaryOrigin: origin, messageArguments: [read.spelling] },
                ),
              );
          }
          currentEnvironment = nested.environment;
          index = argumentsIndex + 2;
          if (nested.syntax.length === 0) continue;
          // Erasing the marker keeps the layout that stood in front of it.
          const spaced = withLeadingTrivia(
            nested.syntax,
            node.tag === "token" ? node.leadingTrivia : [],
          );
          const origins = [...new Set(spaced.map(({ origin }) => origin))];
          const categorized =
            category === "item"
              ? enforestSequence(spaced, category, lexicalModule, contexts)
              : undefined;
          // A body that is already one expression is that expression. Wrapped
          // again, it would lose the precedence it was parsed with and print in
          // parentheses of its own.
          const sole = spaced[0];
          if (
            category === "expr" &&
            spaced.length === 1 &&
            sole?.tag === "protected" &&
            sole.category === "expr"
          ) {
            output.push(sole);
            continue;
          }
          output.push(
            createProtectedSyntax({
              id: options.allocateSyntaxId(),
              span: spanEnvelope(spaced.map(({ span }) => span)),
              origin:
                origins.length === 1
                  ? origins[0]!
                  : options.origins.composed(origins),
              scopes: spaced[0]?.scopes ?? node.scopes,
              category,
              children:
                categorized === undefined
                  ? spaced
                  : createSyntaxSequence([categorized]),
            }),
          );
          continue;
        }
      }
      let resolvedHeadIndex = index;
      // A macro found in a nested category — a declaration's binder, a JSX
      // child — is invoked as that category, not as the one being walked.
      let resolvedCategory: SyntaxCategory = category;
      let resolvedSpelling = node.tag === "token" ? node.raw : "";
      /**
       * Whether this position spells a member's name rather than a macro head.
       * A property is written `name: T` and a method `name(...)`, and either
       * may share a macro's spelling without meaning it, so a member list
       * dispatches only where the name could not be naming a member of its
       * own. A member macro is therefore written as a bare name or in front of
       * a brace, never in the shape of a method signature.
       */
      const memberNameFollows = (): boolean => {
        const next = input[index + 1];
        if (next === undefined) return false;
        if (next.tag === "group")
          return (
            next.delimiter === "parenthesis" || next.delimiter === "bracket"
          );
        return next.tag === "token" && [":", "?", "<", "!"].includes(next.raw);
      };
      /**
       * Whether the key of the member being walked is still ahead. A member
       * list may be walked flat, so this looks back only as far as the
       * separator that ended the previous member: past the first `:` of this
       * one comes its type, where a type macro is written the way it is
       * written anywhere else.
       */
      const beforeMemberType = (): boolean => {
        // Type arguments hold commas and a `?` of their own -- `Map<string,
        // number>`, `A extends B ? C : D` -- and none of them separates
        // members or opens one's type. They are counted forwards, since a
        // `<` still open at the end of what has been walked encloses
        // everything after it.
        let typeArguments = 0;
        let afterMemberName = false;
        for (const walked of output) {
          if (walked.tag !== "token") continue;
          const nested = angles(walked, "<") - angles(walked, ">");
          if (nested !== 0) {
            typeArguments = Math.max(0, typeArguments + nested);
            continue;
          }
          if (typeArguments > 0) continue;
          if (walked.raw === ";" || walked.raw === ",") afterMemberName = false;
          else if (walked.raw === ":" || walked.raw === "?")
            afterMemberName = true;
        }
        return !afterMemberName;
      };
      const namesMember =
        category === "typeMember" && beforeMemberType() && memberNameFollows();
      /**
       * Whether this position names a member of something rather than heading
       * an invocation. `xs.map(f)` reads a property called `map`, and
       * dispatching a macro of that name there would rewrite the property
       * access into whatever the macro produces -- so a file that merely has a
       * macro named `map` in scope would have every `.map(...)` in it silently
       * rewritten.
       */
      const namesProperty = ((): boolean => {
        const previous = output.at(-1);
        return (
          previous?.tag === "token" &&
          (previous.raw === "." ||
            previous.raw === "?." ||
            previous.raw === "#")
        );
      })();
      /**
       * Whether this position spells a label: the one a statement carries, or
       * the one a `break` or `continue` leaves by. A label lives in a
       * namespace of its own -- no expression can read one, and no binding can
       * shadow one -- so a label spelled like a macro is still a label.
       */
      const namesLabel = ((): boolean => {
        if (node.tag !== "token" || node.kind !== "identifier") return false;
        const previous = output.at(-1);
        if (
          previous?.tag === "token" &&
          (previous.raw === "break" || previous.raw === "continue")
        )
          return true;
        const next = input[index + 1];
        return (
          next?.tag === "token" &&
          next.raw === ":" &&
          statementStartFollows(output.length)
        );
      })();
      /**
       * Whether this position spells the name of a method an object literal
       * declares: `name(parameters) { body }`, with `get`, `set`, `async` and
       * a generator star written in front of the name. A member of an object
       * literal is walked as the expression it usually is, and a method's name
       * is the one member of one that is not: dispatching there rewrote every
       * method whose name a macro in scope happened to share.
       */
      const namesObjectMethod = ((): boolean => {
        if (!objectMember || node.tag !== "token") return false;
        // Only what stands in this member, which begins after the `,` that
        // ended the one before it.
        let entryStart = 0;
        for (let at = output.length - 1; at >= 0; at -= 1) {
          const walked = output[at]!;
          if (walked.tag === "token" && walked.raw === ",") {
            entryStart = at + 1;
            break;
          }
        }
        if (
          !output
            .slice(entryStart)
            .every(
              (walked) =>
                walked.tag === "token" && methodNamePrefixes.has(walked.raw),
            )
        )
          return false;
        // The type parameters the method may declare, `twice<T>(value: T)`,
        // and then its parameter list.
        let at = index + 1;
        if (angles(input[at], "<") > 0) {
          let depth = 0;
          for (; at < input.length; at += 1) {
            depth += angles(input[at], "<") - angles(input[at], ">");
            if (depth <= 0) {
              at += 1;
              break;
            }
          }
        }
        const parameters = input[at];
        if (
          parameters?.tag !== "group" ||
          parameters.delimiter !== "parenthesis"
        )
          return false;
        // The body the member ends with, which is what makes it a method.
        // Between it and the parameter list stands the return type, if one is
        // written, and that may itself be an object type -- so the brace that
        // is the body is the last node of the member rather than the first
        // brace after the parameters. A member ending in anything else is an
        // ordinary expression: `{ collect(values) }` calls a macro.
        let depth = 0;
        let last: Syntax | undefined;
        for (at += 1; at < input.length; at += 1) {
          const ahead = input[at]!;
          depth = Math.max(0, depth + angles(ahead, "<") - angles(ahead, ">"));
          if (depth === 0 && ahead.tag === "token" && ahead.raw === ",") break;
          last = ahead;
        }
        return last?.tag === "group" && last.delimiter === "brace";
      })();
      /**
       * Whether this position spells the name of a class member. A class body
       * is walked as tokens wherever its member reader could not take it, and
       * a name written in front of a parameter list, a `:`, a `?` or a `!`
       * names a member there as surely as it does in a type's member list.
       */
      const namesClassMember =
        category === "classElement" &&
        classMemberNameFollows(output.slice(memberStart)) &&
        memberNameFollows();
      /**
       * Whether this position spells an ordinary name rather than the head of
       * an invocation. A macro's spelling is not reserved, and every one of
       * these positions is a place where a name means itself: dispatching
       * there rewrites syntax that never mentioned the macro.
       */
      const namesSomethingElse =
        namesMember ||
        namesProperty ||
        namesLabel ||
        namesObjectMethod ||
        namesClassMember ||
        namesNamespaceAlias(output);
      /**
       * Whether this position reads a type, whatever the syntax around it is
       * being walked as: an annotation, a type argument, a constraint, the
       * right of a type alias's `=`. A name written there is a type and can be
       * nothing else, so it is looked up among type macros and among no
       * others. Asking the walked space first dispatched an item macro in
       * `type T = mkThing` and spliced `export const thing = 1;` where the
       * type belongs.
       *
       * In a member list a bare name reads a member until the member's own
       * `:`, and the separator in front of it says nothing about which -- `,`
       * stands between members and between type arguments alike -- so the list
       * is asked rather than the token before the name.
       */
      const readsType =
        category === "type" ||
        (category === "typeMember" ? !beforeMemberType() : typeFollows());
      /**
       * Whether the space being walked is the space this position reads. A
       * type walked as a type is both; a type written inside a declaration is
       * read as a type and walked as an item, and only the type space answers
       * for it.
       */
      const readsWalkedSpace = category === "type" || !readsType;
      let resolvedMacro =
        node.tag === "token" && !namesSomethingElse && readsWalkedSpace
          ? resolveSpelling(node.raw, node.span.start, sourceOf(node))
          : undefined;
      // A type is written in many places the surrounding syntax is not a type:
      // an annotation, a return type, a constraint, a member of a union. Where
      // the position is not certainly a type, a type macro is still looked up
      // after the tokens a type can follow: finding one there costs nothing,
      // and a name that is one is a type wherever it was written.
      if (
        resolvedMacro === undefined &&
        node.tag === "token" &&
        (readsType ? !namesSomethingElse : inTypeRegion() || typePositionHere())
      ) {
        resolvedMacro = resolveSpelling(
          node.raw,
          node.span.start,
          sourceOf(node),
          "type",
        );
        if (resolvedMacro !== undefined) resolvedCategory = "type";
      }
      // The top level of a module takes statements as readily as declarations,
      // so a statement macro is written there the same way it is written in a
      // block. Looking only for an item macro found it in every function body
      // and nowhere else.
      if (
        resolvedMacro === undefined &&
        node.tag === "token" &&
        category === "item" &&
        readsWalkedSpace
      ) {
        resolvedMacro = resolveSpelling(
          node.raw,
          node.span.start,
          sourceOf(node),
          "stmt",
        );
        if (resolvedMacro !== undefined) resolvedCategory = "stmt";
      }
      if (
        resolvedMacro === undefined &&
        node.tag === "token" &&
        category !== "expr" &&
        readsWalkedSpace &&
        // What a class extends is an expression even though `extends` also
        // introduces a type elsewhere. Otherwise the `=` of a type alias
        // introduces a type, so an expression macro is not looked up after it:
        // without that, `type A = name;` dispatched an expression macro
        // spelled `name`.
        (classHeritageFollows(output) ||
          (!typeAliasInitializerFollows(output) &&
            (initializerFollows(output) || expressionRegion)))
      ) {
        resolvedMacro = resolveSpelling(
          node.raw,
          node.span.start,
          sourceOf(node),
          "expr",
        );
        if (resolvedMacro !== undefined) resolvedCategory = "expr";
      }
      // The binder of a declaration is its own category, so a macro standing
      // there is looked up among binding macros rather than the statements or
      // items around it.
      if (
        resolvedMacro === undefined &&
        node.tag === "token" &&
        category !== "binding" &&
        binderFollows(output)
      ) {
        resolvedMacro = resolveSpelling(
          node.raw,
          node.span.start,
          sourceOf(node),
          "binding",
        );
        if (resolvedMacro !== undefined) resolvedCategory = "binding";
      }
      // A JSX child macro is written as a braced head, `{each (...)}`, because
      // that is the only place a name can go between elements. The name inside
      // the braces is what the invocation is looked up under.
      if (
        resolvedMacro === undefined &&
        category === "jsxChild" &&
        node.tag === "group" &&
        node.delimiter === "brace"
      ) {
        const head = node.children[0];
        if (head?.tag === "token" && head.kind === "identifier") {
          const candidate = resolveSpelling(
            head.raw,
            head.span.start,
            sourceOf(head),
            category,
            head,
          );
          if (candidate !== undefined) {
            resolvedMacro = candidate;
            resolvedSpelling = head.raw;
          }
        }
      }
      /**
       * The space this position reads, where it reads one space and a bare
       * name written there could be nothing but an invocation of a macro
       * declared for it. A macro declared for another space is left alone and
       * emitted verbatim, which TypeScript reports as a name it cannot find,
       * as an implicitly-typed member, or -- when it is not asking for either
       * -- as nothing at all.
       *
       * Not asked where a bare name is ordinary syntax: a member list names
       * members, a declaration names what it binds, a qualified name names a
       * property, and a name in front of a `:` names a key or a label.
       */
      const spaceRead = (): SyntaxCategory | undefined => {
        const next = input[index + 1];
        if (
          namesSomethingElse ||
          binderFollows(output) ||
          (next?.tag === "token" && next.raw === ":")
        )
          return undefined;
        if (readsType) return "type";
        if (category === "typeMember") return "typeMember";
        // A type is looked up after these too, though the position is not
        // certainly one -- a `,` separates arguments as well as type
        // arguments. Naming the space would name the wrong one, so a name
        // that resolved nowhere is left to TypeScript here.
        if (inTypeRegion() || typePositionHere()) return undefined;
        // An expression region is opened by `=>` among others, and a function
        // type's arrow is spelled the same way, so it says only that an
        // expression may be being written. A space is named where one
        // certainly is.
        return category === "expr" ||
          classHeritageFollows(output) ||
          initializerFollows(output)
          ? "expr"
          : undefined;
      };
      const mismatchedSpace =
        resolvedMacro === undefined &&
        node.tag === "token" &&
        node.kind === "identifier"
          ? spaceRead()
          : undefined;
      if (
        mismatchedSpace !== undefined &&
        node.tag === "token" &&
        !shadowsMacro(node.raw, mismatchedSpace)
      ) {
        const elsewhere = (
          [
            "item",
            "stmt",
            "expr",
            "type",
            "classElement",
            "typeMember",
            "binding",
            "jsxChild",
          ] as const
        ).find(
          (candidate) =>
            candidate !== mismatchedSpace &&
            resolveSpelling(
              node.raw,
              node.span.start,
              sourceOf(node),
              candidate,
            ) !== undefined,
        );
        if (elsewhere !== undefined) {
          const source = options.origins.selectPrimarySource(node.origin);
          // Held rather than reported. The expander knows the macros and the
          // bindings this module writes; it does not know `lib.d.ts`, an
          // ambient declaration, a `declare global`, or that a member list
          // names members of its own, so a name it cannot account for is not
          // thereby a name nothing defines. Reporting on its own knowledge
          // refused `type Halved = Partial<{ a: number }>` in a module holding
          // a macro spelled `Partial`. The sentence goes to the side that
          // resolves names, to be written where that side says the name is
          // missing.
          if (source !== undefined)
            unresolvedNameExplanations.push(
              expansionDiagnosticRegistry.create(wrongCategoryMacroCode, {
                primaryOrigin: {
                  sourceId: source.sourceId,
                  start: source.span.start,
                  end: source.span.end,
                  originId: node.origin,
                },
                messageArguments: [node.raw, elsewhere, mismatchedSpace],
              }),
            );
        }
      }
      /**
       * A macro is visible to what follows its definition, the way a `const`
       * is, so a name used above its definition is not a macro there. Left
       * alone, the invocation is emitted as a call to a name the output does
       * not define, and TypeScript says the name is missing and nothing about
       * the macro below it -- so the sentence that names the definition is
       * written in place of that one.
       *
       * Held rather than reported, for the same reason a mismatched space is.
       * Whether the output defines the name is TypeScript's to answer, and a
       * macro spelled `Event` or `JSON` leaves a global standing above its
       * definition. So this goes to the side that resolves names, to be
       * written only where that side says the name is missing.
       *
       * Not said at all where the name is deliberately something else:
       * shadowed by an ordinary binding, naming a property or a member, or
       * spelling a core form whose interception was never authorized.
       */
      if (
        resolvedMacro === undefined &&
        !namesSomethingElse &&
        node.tag === "token" &&
        node.kind === "identifier" &&
        !shadowsMacro(node.raw, category) &&
        lexicalModule.get(node.raw, category) !== undefined &&
        !isCoreForm(
          node.raw,
          category,
          coreFormKind(lexicalModule.get(node.raw, category)!.binding),
        )
      ) {
        const source = options.origins.selectPrimarySource(node.origin);
        if (source !== undefined)
          unresolvedNameExplanations.push(
            expansionDiagnosticRegistry.create(macroNotYetVisibleCode, {
              primaryOrigin: {
                sourceId: source.sourceId,
                start: source.span.start,
                end: source.span.end,
                originId: node.origin,
              },
              messageArguments: [node.raw],
            }),
          );
      }
      // A definition context is read at module level. One written inside a
      // block is not processed, and carried through into the emitted
      // TypeScript the host compiler would report an unexpected identifier on
      // a line of macro language. Reporting it here names what happened.
      if (
        category !== "item" &&
        node.tag === "token" &&
        (node.raw === "syntax" || node.raw === "operator") &&
        definitionShapeFollows(input, index)
      ) {
        const source = options.origins.selectPrimarySource(node.origin);
        if (source !== undefined)
          diagnostics.push(
            expansionDiagnosticRegistry.create(unprocessedDefinitionCode, {
              primaryOrigin: {
                sourceId: source.sourceId,
                start: source.span.start,
                end: source.span.end,
                originId: node.origin,
              },
              messageArguments: [definitionSpelling(input, index)],
            }),
          );
      }
      if (
        resolvedMacro === undefined &&
        readsWalkedSpace &&
        node.tag === "group" &&
        node.delimiter === "parenthesis"
      ) {
        const punctuationHeads = activeModules
          .flatMap(({ macros }) => macros)
          .filter(
            (candidate) =>
              candidate.category === category &&
              candidate.binding.kind === "macro" &&
              // A syntax parameter stands for its replacement by its spelling
              // alone, so a group that begins with it is an ordinary group.
              !candidate.parameter &&
              // Only a punctuation-spelled macro turns its enclosing
              // parentheses into the invocation. An identifier-spelled macro
              // in this position is just the head of a parenthesized
              // expression, and treating the group as its invocation consumes
              // the parentheses and stops the expander from descending.
              punctuationSpelled(candidate.binding.spelling) &&
              operatorWidthAt(node.children, 0, candidate.binding.spelling) !==
                undefined,
          )
          .sort(
            (left, right) =>
              right.binding.spelling.length - left.binding.spelling.length,
          );
        for (const candidate of punctuationHeads) {
          const visible = resolveSpelling(
            candidate.binding.spelling,
            node.span.start,
            sourceOf(node),
          );
          if (visible?.binding.id !== candidate.binding.id) continue;
          resolvedMacro = visible;
          resolvedSpelling = candidate.binding.spelling;
          break;
        }
      }
      // A macro is matched by its spelling here whether that spelling is
      // punctuation or a name, so this reaches the walked space the way the
      // lookup above does, and is held to the same space the position reads.
      if (
        resolvedMacro === undefined &&
        readsWalkedSpace &&
        node.tag === "token"
      ) {
        const punctuationHeads = activeModules
          .flatMap(({ macros }) => macros)
          .filter(
            (candidate) =>
              candidate.category === category &&
              candidate.binding.kind === "macro" &&
              operatorWidthAt(input, index, candidate.binding.spelling) !==
                undefined,
          )
          .sort(
            (left, right) =>
              right.binding.spelling.length - left.binding.spelling.length,
          );
        for (const candidate of punctuationHeads) {
          const visible = resolveSpelling(
            candidate.binding.spelling,
            node.span.start,
            sourceOf(node),
          );
          if (visible?.binding.id !== candidate.binding.id) continue;
          resolvedMacro = visible;
          resolvedSpelling = candidate.binding.spelling;
          break;
        }
      }
      if (
        resolvedMacro === undefined &&
        category === "item" &&
        node.tag === "token" &&
        itemDispatchPrefixes.has(node.raw)
      ) {
        let candidateIndex = index;
        while (true) {
          const prefix = input[candidateIndex];
          if (prefix?.tag !== "token" || !itemDispatchPrefixes.has(prefix.raw))
            break;
          candidateIndex += 1;
        }
        const candidate = input[candidateIndex];
        if (candidate?.tag === "token") {
          resolvedMacro = resolveSpelling(
            candidate.raw,
            candidate.span.start,
            sourceOf(candidate),
            category,
            candidate,
          );
          resolvedHeadIndex = candidateIndex;
          resolvedSpelling = candidate.raw;
        }
      }
      if (
        resolvedMacro === undefined &&
        (category === "item" || category === "stmt") &&
        // A separator ends the segment before it, so no operand begins there.
        // The walk stands on one once the statement it ended has been
        // emitted, and reading forward from there reached the operator of the
        // statement *after* it and offered it an operand beginning with the
        // separator. No rule can match that, so a statement that expanded
        // correctly still reported a refusal naming a rule nobody wrote.
        !(node.tag === "token" && (node.raw === ";" || node.raw === ","))
      ) {
        // Infix operators dispatch from the beginning of their complete
        // expression, item, or statement rather than from the operator token.
        // Search only the current top-level comma/semicolon-delimited segment;
        // groups delimit nested operands and are recursively visited later.
        for (
          let candidateIndex = index + 1;
          candidateIndex < input.length;
          candidateIndex += 1
        ) {
          const candidate = input[candidateIndex];
          if (candidate?.tag === "group" || candidate?.tag === "protected")
            break;
          if (candidate?.tag !== "token") continue;
          if (candidate.raw === ";" || candidate.raw === ",") break;
          const matches = activeModules
            .flatMap(({ operators }) => operators)
            .filter(
              ({ category: operatorCategory, fixity }) =>
                operatorCategory === category && fixity === "infix",
            )
            .flatMap((operator) => {
              const width = operatorWidthAt(
                input,
                candidateIndex,
                operator.spelling,
              );
              const candidateMacro =
                width === undefined
                  ? undefined
                  : resolveSpelling(
                      operator.spelling,
                      candidate.span.start,
                      sourceOf(candidate),
                      category,
                      candidate,
                    );
              return candidateMacro === undefined ||
                candidateMacro.binding.id !== operator.binding
                ? []
                : [{ candidateMacro, width: width! }];
            })
            .sort((left, right) => right.width - left.width);
          if (matches.length === 0) continue;
          resolvedMacro = matches[0]!.candidateMacro;
          resolvedHeadIndex = candidateIndex;
          resolvedSpelling = candidate.raw;
          break;
        }
      }
      // Applied after every lookup, not only the first: the operator-spelling
      // fallback below matches an identifier-spelled macro too, and would
      // otherwise dispatch the very name the member is declaring.
      if (namesSomethingElse) resolvedMacro = undefined;
      // Recorded wherever the walk declines to read a name as an invocation,
      // so that whatever else asks whether an invocation survived can ask the
      // walk that would have dispatched it rather than matching spellings.
      if (
        resolvedMacro === undefined &&
        node.tag === "token" &&
        node.kind === "identifier" &&
        (namesSomethingElse ||
          binderFollows(output) ||
          shadowsMacro(node.raw, "expr") ||
          shadowsMacro(node.raw, "type"))
      )
        namedOrigins.add(node.origin);
      if (
        resolvedMacro !== undefined &&
        resolvedMacro.binding.kind === "macro" &&
        resolvedCategory === "expr" &&
        punctuationSpelled(resolvedMacro.binding.spelling) &&
        endsOperand(
          output,
          output.length,
          category === "expr" || expressionRegion,
        )
      )
        resolvedMacro = undefined;
      const macro =
        (suppressPending || suppressedHeadIndex === index) &&
        resolvedMacro !== undefined
          ? undefined
          : resolvedMacro;
      if (suppressPending && resolvedMacro !== undefined) {
        suppressPending = false;
        if (resolvedHeadIndex > index) suppressedHeadIndex = resolvedHeadIndex;
      }
      // A generated core head is commonly definition-scoped, so it may not
      // resolve to the caller's shadow at all. The escape still applies only
      // to that syntactic head: do not carry its pending suppression into the
      // first macro nested in the emitted form. Item prefixes keep it pending
      // until the actual declaration keyword (`export function`, for example).
      if (
        suppressPending &&
        node.tag === "token" &&
        !(category === "item" && itemDispatchPrefixes.has(node.raw))
      ) {
        suppressPending = false;
      }
      if (suppressedHeadIndex === index) suppressedHeadIndex = undefined;
      // A bound reached during expansion is a fact about this file, so it is
      // reported against the invocation that reached it rather than thrown
      // past every caller. Left to escape, a macro that does not terminate
      // ended the build with a stack trace naming no file, no line and no
      // macro -- and it escaped the compiler session too, so every host
      // integration crashed the same way.
      if (
        macro !== undefined &&
        macro.parameter &&
        abortedSpelling === undefined
      ) {
        const head = input[resolvedHeadIndex] ?? node;
        const headWidth = punctuationSpelled(macro.binding.spelling)
          ? (operatorWidthAt(
              input,
              resolvedHeadIndex,
              macro.binding.spelling,
            ) ?? 1)
          : 1;
        output.push(...input.slice(index, resolvedHeadIndex));
        let depth = parameterizations.length - 1;
        while (
          depth >= 0 &&
          parameterizations[depth]!.binding !== macro.binding.id
        )
          depth -= 1;
        if (depth >= 0) {
          const parameterization = parameterizations[depth]!;
          usedParameterizations.add(parameterization);
          // The replacement is expanded under the parameterizations that were
          // in effect where it was written, not under this one and those inside
          // it: `#parameterize(% = f(%)) { ... }` means the enclosing `%`.
          const inner = parameterizations.splice(depth);
          let nested;
          try {
            nested = visit(
              createSyntaxSequence(parameterization.replacement.map(freshCopy)),
              currentEnvironment,
              macro.category,
              parentInvocation,
              parameterization.lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
          } finally {
            parameterizations.push(...inner);
          }
          currentEnvironment = nested.environment;
          const trivia = head.tag === "token" ? head.leadingTrivia : [];
          // The replacement stands where the parameter was written, so it is
          // spaced as the parameter was, not as the replacement was in the
          // template: `lookup(%)` stays `lookup(topic)`.
          const replaced = withoutLeadingTrivia(nested.syntax);
          // An expression keeps the node that bounds it, or the operators
          // around the use would re-bind against the replacement's own.
          if (
            (macro.category === "expr" || macro.category === "type") &&
            replaced.length > 1
          ) {
            const origins = [...new Set(replaced.map(({ origin }) => origin))];
            output.push(
              ...withLeadingTrivia(
                [
                  createProtectedSyntax({
                    id: options.allocateSyntaxId(),
                    span: spanEnvelope(replaced.map(({ span }) => span)),
                    origin:
                      origins.length === 1
                        ? origins[0]!
                        : options.origins.composed(origins),
                    scopes: replaced[0]!.scopes,
                    category: macro.category,
                    children: replaced,
                  }),
                ],
                trivia,
              ),
            );
          } else output.push(...withLeadingTrivia(replaced, trivia));
          index = resolvedHeadIndex + headWidth;
          continue;
        }
        if (macro.rules.length === 0) {
          const origin = primaryOrigin(head);
          if (origin !== undefined)
            diagnostics.push(
              expansionDiagnosticRegistry.create(
                unparameterizedSyntaxParameterCode,
                {
                  primaryOrigin: origin,
                  messageArguments: [macro.binding.spelling],
                },
              ),
            );
          output.push(
            ...input.slice(resolvedHeadIndex, resolvedHeadIndex + headWidth),
          );
          index = resolvedHeadIndex + headWidth;
          continue;
        }
        // With no parameterization in effect, a parameter with rules expands
        // by them like any other macro.
      }
      if (macro !== undefined && abortedSpelling === undefined) {
        if (macro.binding.kind === "operator")
          offeredOperators.add((input[resolvedHeadIndex] ?? node).origin);
        const macroModule =
          activeModules.find(
            (candidate) =>
              candidate.get(macro.binding.spelling, macro.category) === macro,
          ) ??
          activeModules.find(({ macros }) =>
            macros.some(({ binding }) => binding === macro.binding),
          ) ??
          lexicalModule;
        const cursor = createSyntaxCursor(input);
        cursor.advance(index);
        let replacementEnvironment: BindingEnvironment | undefined;
        let eraseReplacement = false;
        let result;
        try {
          result = invokeMacro({
            ...options,
            macro,
            cursor,
            category: resolvedCategory,
            contexts,
            coreInterception:
              options.coreInterceptionForMacro?.({
                macro,
                lexicalModule,
                spelling: resolvedSpelling,
                origin: input[resolvedHeadIndex]?.origin ?? node.origin,
              }) ?? options.coreInterception,
            consumeClass:
              options.consumeClassForMacro?.(macro, contexts) ??
              options.consumeClass,
            environment: currentEnvironment,
            parentInvocation,
            expandReplacement: (request) => {
              // A replacement may declare macros and ordinary syntax together,
              // so every `#syntax { ... }` in it is processed and removed and
              // whatever surrounds them carries on as the replacement.
              const remaining: Syntax[] = [];
              let declaredMacros = false;
              for (
                let cursor = 0;
                cursor < request.syntax.length;
                cursor += 1
              ) {
                const marker = request.syntax[cursor]!;
                const body = request.syntax[cursor + 1];
                if (
                  options.generatedDefinitions === undefined ||
                  options.expansionStore === undefined ||
                  activeExpansionEnvironment === undefined ||
                  marker.tag !== "token" ||
                  marker.raw !== "#syntax" ||
                  body?.tag !== "group" ||
                  body.delimiter !== "brace"
                ) {
                  remaining.push(marker);
                  continue;
                }
                const generated = processGeneratedDefinitions({
                  syntax: createSyntaxSequence([marker, body]),
                  sourceId: options.generatedDefinitions.sourceId,
                  phase: options.phase,
                  definitionScopes: marker.scopes,
                  origins: options.origins,
                  store: options.expansionStore,
                  environment: activeExpansionEnvironment,
                  allocateSyntaxId: options.allocateSyntaxId,
                  allocateBindingId: options.allocateBindingId,
                  diagnosticOrigin: options.diagnosticOrigin,
                });
                generatedDefinitionTraces.push(generated.trace);
                diagnostics.push(...generated.diagnostics);
                if (generated.accepted && generated.compiled !== undefined) {
                  activeExpansionEnvironment = generated.environment;
                  activeModules.push(generated.compiled);
                }
                declaredMacros = true;
                cursor += 1;
              }
              if (declaredMacros && remaining.length === 0) {
                const marker = request.syntax[0]!;
                eraseReplacement = true;
                return createProtectedSyntax({
                  id: options.allocateSyntaxId(),
                  span: spanEnvelope(request.syntax.map(({ span }) => span)),
                  origin: marker.origin,
                  scopes: marker.scopes,
                  category: request.category,
                  children: createSyntaxSequence(request.syntax),
                });
              }
              if (declaredMacros) {
                request = {
                  ...request,
                  syntax: createSyntaxSequence(remaining),
                };
              }
              // Give a statement replacement its interior categories before it
              // is walked, so that a macro spliced into an expression position
              // inside it is recognized as an expression. A replacement that
              // does not yet parse as a statement list — because it still holds
              // an unexpanded invocation the parser cannot place — is walked raw
              // exactly as before.
              const preEnforested =
                request.category === "stmt" &&
                !holdsStatementOperator(request.syntax)
                  ? options.enforestStatements?.({
                      syntax: request.syntax,
                      contexts,
                      lexicalModule: macroModule,
                    })
                  : undefined;
              const nested = visit(
                createSyntaxSequence(preEnforested ?? request.syntax),
                request.environment,
                request.category,
                request.invocationId,
                macroModule,
                contexts,
                false,
                macroModule.definitions.some(
                  ({ definition, macro: candidate }) =>
                    candidate === macro &&
                    definition.kind === "syntax" &&
                    definition.recursive,
                )
                  ? macro.binding.id
                  : recursiveBinding,
              );
              replacementEnvironment = nested.environment;
              return enforestSequence(
                nested.syntax,
                request.category,
                macroModule,
                contexts,
                node,
              );
            },
          });
        } catch (error) {
          const cycle = error instanceof ExpansionCycleError;
          if (!cycle && !(error instanceof ResourceLimitError)) throw error;
          const source = options.origins.selectPrimarySource(node.origin);
          if (source === undefined) throw error;
          abortedSpelling = resolvedSpelling;
          diagnostics.push(
            expansionDiagnosticRegistry.create(
              cycle ? expansionCycleCode : expansionLimitCode,
              {
                primaryOrigin: {
                  sourceId: source.sourceId,
                  start: source.span.start,
                  end: source.span.end,
                  originId: node.origin,
                },
                messageArguments: cycle
                  ? [resolvedSpelling]
                  : [resolvedSpelling, (error as ResourceLimitError).kind],
              },
            ),
          );
          output.push(node);
          index += 1;
          continue;
        }
        // Replacement expansion completes before its enclosing invocation.
        // Prepending retains invocation/preorder order: parent, then descendants.
        traces.unshift(result.trace);
        if (!result.expanded) {
          // A failure that claims nothing defines the name is held for the
          // side that resolves names, the way a mismatched space is; one about
          // the syntax written here is expansion's own to report.
          (result.explainsUnresolvedName
            ? unresolvedNameExplanations
            : diagnostics
          ).push(result.diagnostic);
          output.push(node);
          if (resolvedHeadIndex > index)
            suppressedHeadIndex = resolvedHeadIndex;
          index += 1;
          continue;
        }
        // The invocation's own leading trivia positioned it on the page, and
        // it is consumed along with the invocation. Handing it to the
        // replacement keeps the expansion where the call stood.
        if (!eraseReplacement) {
          const head = input[resolvedHeadIndex] ?? node;
          const trivia = head.tag === "token" ? head.leadingTrivia : [];
          // An expression or a type keeps the node that says where it begins
          // and ends. Spreading its children would splice the tokens loose
          // into whatever surrounds the call, so the operators there would
          // re-bind against them: `sum(1, 2) * 10` would expand to
          // `1 + 2 * 10` and compute 21 rather than 30, and `orNull(string)[]`
          // would expand to `string | null[]`, an array of `null` -- with
          // nothing in either case to say it had happened.
          const spliceWhole =
            (result.syntax.category === "expr" ||
              result.syntax.category === "type") &&
            result.syntax.children.length > 1;
          output.push(
            ...withLeadingTrivia(
              spliceWhole ? [result.syntax] : result.syntax.children,
              trivia,
            ),
          );
        }
        currentEnvironment = replacementEnvironment ?? result.environment;
        if (options.scopeStore.size(result.followingScopes) > 0) {
          input = createSyntaxSequence([
            ...input.slice(0, result.cursor.index),
            ...input
              .slice(result.cursor.index)
              .map((syntax) => addScopes(syntax, result.followingScopes)),
          ]);
        }
        index = result.cursor.index;
        // A list of members, items, statements or class elements separates on
        // a token of its own, and a macro that emits whole units terminates
        // the last one itself. The separator written after such an invocation
        // then terminates nothing, and standing in the output it reads as a
        // unit of its own: a member list reports a missing property or
        // signature, and a statement list or a class body is left with an
        // empty statement or an empty member. An invocation spans the
        // separator written after it, kept only where it terminates something
        // the macro left open.
        if (
          !eraseReplacement &&
          separatesList(lastTokenOf(result.syntax), resolvedCategory) &&
          separatesList(input[index], resolvedCategory)
        )
          index += 1;
        continue;
      }
      if (node.tag === "group" || node.tag === "protected") {
        if (
          node.tag === "group" &&
          (node.delimiter === "jsx-element" ||
            node.delimiter === "jsx-fragment")
        ) {
          // An element's children begin after its opening tag closes and end
          // at its closing tag. Everything before that is the tag itself,
          // whose attribute braces hold expressions and whose type arguments
          // hold types.
          const tag = jsxTagShape(node.children);
          const childEnd = node.children.findIndex(
            (child) => child.tag === "token" && child.raw === "</",
          );
          const head = tag.tagEnd < 0 ? node.children.length : tag.tagEnd + 1;
          const tail = childEnd < 0 ? node.children.length : childEnd;
          const expandChild = (child: Syntax): readonly Syntax[] => {
            if (
              child.tag !== "group" ||
              (child.delimiter !== "brace" &&
                child.delimiter !== "jsx-element" &&
                child.delimiter !== "jsx-fragment")
            )
              return [child];
            const nested = visit(
              createSyntaxSequence([child]),
              currentEnvironment,
              "expr",
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
            currentEnvironment = nested.environment;
            return nested.syntax;
          };
          const jsxChildren: Syntax[] = [];
          if (tag.typeArguments === undefined) {
            jsxChildren.push(
              ...node.children.slice(0, head).flatMap(expandChild),
            );
          } else {
            const { from, to } = tag.typeArguments;
            jsxChildren.push(
              ...node.children.slice(0, from + 1).flatMap(expandChild),
            );
            // A generic element's type arguments are types, and a type macro
            // written among them resolves there like one written in any other
            // type argument list.
            const nested = visit(
              createSyntaxSequence(node.children.slice(from + 1, to)),
              currentEnvironment,
              "type",
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
            currentEnvironment = nested.environment;
            jsxChildren.push(...nested.syntax);
            jsxChildren.push(
              ...node.children.slice(to, head).flatMap(expandChild),
            );
          }
          if (head < tail) {
            // The children are walked as one sequence so a macro invocation
            // can span several of them, the way a block form does.
            const nested = visit(
              createSyntaxSequence(node.children.slice(head, tail)),
              currentEnvironment,
              "jsxChild",
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
            currentEnvironment = nested.environment;
            jsxChildren.push(...nested.syntax);
          }
          jsxChildren.push(...node.children.slice(tail));
          output.push(
            createGroup({
              ...node,
              id: options.allocateSyntaxId(),
              children: createSyntaxSequence(jsxChildren),
            }),
          );
          index += 1;
          continue;
        }
        if (node.tag === "group" && node.delimiter === "template") {
          const children: Syntax[] = [];
          let substitution: Syntax[] = [];
          // A template literal holds expressions, and a template literal *type*
          // holds types: `` `get${string & K}` `` is a type, not an expression.
          // Reading every substitution as an expression made an ordinary
          // template literal type unreadable -- and at a use site it escaped as
          // a thrown error rather than a diagnostic, so one of them anywhere in
          // a file ended the whole compilation.
          const substitutionCategory: SyntaxCategory =
            category === "type" || typeFollows() ? "type" : "expr";
          const expandSubstitution = () => {
            if (substitution.length === 0) return;
            const enforested = enforestOrReport(
              createSyntaxSequence(substitution),
              substitutionCategory,
              lexicalModule,
              contexts,
            );
            const nested = visit(
              createSyntaxSequence(
                enforested === undefined ? substitution : [enforested],
              ),
              currentEnvironment,
              substitutionCategory,
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
            currentEnvironment = nested.environment;
            children.push(...nested.syntax);
            substitution = [];
          };
          for (const child of node.children) {
            if (
              child.tag === "token" &&
              (child.kind === "template-head" ||
                child.kind === "template-middle" ||
                child.kind === "template-tail")
            ) {
              expandSubstitution();
              children.push(child);
            } else substitution.push(child);
          }
          expandSubstitution();
          output.push(
            createGroup({
              ...node,
              id: options.allocateSyntaxId(),
              children: createSyntaxSequence(children),
            }),
          );
          index += 1;
          continue;
        }
        // A group standing in an expression holds expressions, and an operator
        // written inside one has to be dispatched there too, parentheses as
        // well as brackets. Otherwise `(a <- b)` and every call argument
        // spelled with a custom operator would keep the reading the ordinary
        // parse gives them -- `a < (-b)` for an operator spelled `<-` --
        // silently and with no diagnostic. The group is only entered when an operator's spelling
        // actually stands in it, so an ordinary parenthesised expression and an
        // arrow's parameter list are left as they were.
        if (
          node.tag === "group" &&
          (node.delimiter === "bracket" || node.delimiter === "parenthesis") &&
          category === "expr" &&
          activeModules
            .flatMap(({ operators }) => operators)
            .some(
              (operator) =>
                operator.category === "expr" &&
                node.children.some(
                  (_, childIndex) =>
                    operatorWidthAt(
                      node.children,
                      childIndex,
                      operator.spelling,
                    ) !== undefined,
                ),
            )
        ) {
          const children: Syntax[] = [];
          let segment: Syntax[] = [];
          const expandSegment = () => {
            if (segment.length === 0) return;
            const enforested = enforestOrReport(
              createSyntaxSequence(segment),
              "expr",
              lexicalModule,
              contexts,
            );
            const nested = visit(
              createSyntaxSequence(
                enforested === undefined ? segment : [enforested],
              ),
              currentEnvironment,
              "expr",
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            );
            currentEnvironment = nested.environment;
            children.push(...nested.syntax);
            segment = [];
          };
          for (const child of node.children) {
            if (child.tag === "token" && child.raw === ",") {
              expandSegment();
              children.push(child);
            } else segment.push(child);
          }
          expandSegment();
          output.push(
            createGroup({
              ...node,
              id: options.allocateSyntaxId(),
              children: createSyntaxSequence(children),
            }),
          );
          index += 1;
          continue;
        }
        if (
          node.tag === "group" &&
          node.delimiter === "brace" &&
          category === "expr" &&
          !inTypeRegion() &&
          node.children.some(
            (child) => child.tag === "token" && child.raw === ":",
          )
        ) {
          const children: Syntax[] = [];
          let member: Syntax[] = [];
          const expandExpression = (
            syntax: readonly Syntax[],
            /** Whether `syntax` is a whole member, whose head may name it. */
            wholeMember = false,
          ): Syntax[] => {
            if (syntax.length === 0) return [];
            const enforested = options.enforestExpression?.({
              syntax: createSyntaxSequence(syntax),
              contexts,
              lexicalModule,
            });
            const nested = visit(
              enforested === undefined
                ? createSyntaxSequence(syntax)
                : createSyntaxSequence([enforested]),
              currentEnvironment,
              "expr",
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
              wholeMember,
            );
            currentEnvironment = nested.environment;
            return [...nested.syntax];
          };
          const expandMember = () => {
            if (member.length === 0) return;
            const colon = member.findIndex(
              (child) => child.tag === "token" && child.raw === ":",
            );
            const methodHead =
              colon >= 0 &&
              member
                .slice(0, colon)
                .some(
                  (child) =>
                    child.tag === "group" && child.delimiter === "parenthesis",
                );
            if (colon >= 0 && !methodHead) {
              // A property name is not an expression, but a computed one holds
              // one inside its brackets.
              const key = member.slice(0, colon + 1).map((child) => {
                if (child.tag !== "group" || child.delimiter !== "bracket") {
                  if (child.tag === "token" && child.kind === "identifier")
                    namedOrigins.add(child.origin);
                  return child;
                }
                const nested = visit(
                  child.children,
                  currentEnvironment,
                  "expr",
                  parentInvocation,
                  lexicalModule,
                  contexts,
                  false,
                  recursiveBinding,
                );
                currentEnvironment = nested.environment;
                return createGroup({
                  ...child,
                  id: options.allocateSyntaxId(),
                  children: nested.syntax,
                });
              });
              children.push(
                ...key,
                ...expandExpression(member.slice(colon + 1)),
              );
            } else {
              children.push(...expandExpression(member, true));
            }
            member = [];
          };
          // A method's type parameters and return type hold commas of their
          // own -- `*run(): Generator<number, void, unknown> {` -- which do not
          // end the member. Angle brackets are counted only in a method's head:
          // in a property's value or a spread they compare.
          let methodHead = true;
          let typeArguments = 0;
          for (const child of node.children) {
            if (
              child.tag === "token" &&
              child.raw === "," &&
              typeArguments === 0
            ) {
              expandMember();
              children.push(child);
              methodHead = true;
              continue;
            }
            const previous = member.at(-1);
            member.push(child);
            if (!methodHead) continue;
            if (child.tag !== "token") {
              if (child.tag === "group" && child.delimiter === "brace") {
                methodHead = false;
                typeArguments = 0;
              }
              continue;
            }
            const nested = angles(child, "<") - angles(child, ">");
            if (nested !== 0)
              typeArguments = Math.max(0, typeArguments + nested);
            else if (
              (child.raw === "..." && previous === undefined) ||
              (child.raw === ":" &&
                typeArguments === 0 &&
                !(
                  previous?.tag === "group" &&
                  previous.delimiter === "parenthesis"
                ))
            )
              methodHead = false;
          }
          expandMember();
          output.push(
            createGroup({
              ...node,
              id: options.allocateSyntaxId(),
              children: createSyntaxSequence(children),
            }),
          );
          index += 1;
          continue;
        }
        // An import or export specifier list holds names of its own, so it is
        // emitted as written rather than walked.
        if (
          node.tag === "group" &&
          node.delimiter === "brace" &&
          specifierListFollows(output)
        ) {
          output.push(node);
          index += 1;
          continue;
        }
        // A binding pattern names what a declaration binds. Between its
        // brackets stand the keys of the properties it reads, the targets it
        // binds them to -- a name, or a pattern of its own -- the default of
        // each, and the keys computed for them. A key is a name and a target
        // is a binder, while a default and a computed key are expressions;
        // none of them is a type, however the `:` between a key and its target
        // reads elsewhere. Walked as one run, the `:` opened a type and
        // everything past it in the pattern was read as one, so a macro in a
        // nested default or a computed key was looked up among type macros,
        // found nowhere, and emitted verbatim.
        if (
          node.tag === "group" &&
          category === "binding" &&
          (node.delimiter === "brace" || node.delimiter === "bracket") &&
          // A pattern stands where a binder does: at the head of its entry,
          // after the modifiers a parameter property carries and the `...` of
          // a rest parameter. Past the `=` of a default a brace opens an
          // object literal or the body of the function that is one, and past
          // the `:` of an annotation it opens an object type.
          parameterBinder(
            output.slice(
              output.findLastIndex(
                (walked) => walked.tag === "token" && walked.raw === ",",
              ) + 1,
            ),
          ).length === 0
        ) {
          const patternContexts = contextsWithin(
            node,
            runAhead(index),
            output.length,
            contexts,
          );
          const walkAs = (
            nodes: readonly Syntax[],
            as: SyntaxCategory,
          ): readonly Syntax[] => {
            if (nodes.length === 0) return [];
            const nested = visit(
              createSyntaxSequence(nodes),
              currentEnvironment,
              as,
              parentInvocation,
              lexicalModule,
              patternContexts,
              false,
              recursiveBinding,
            );
            currentEnvironment = nested.environment;
            return nested.syntax;
          };
          const named = (child: Syntax): Syntax => {
            if (child.tag === "token" && child.kind === "identifier")
              namedOrigins.add(child.origin);
            return child;
          };
          const spelt = (child: Syntax | undefined, raw: string): boolean =>
            child?.tag === "token" && child.raw === raw;
          const expandEntry = (entry: readonly Syntax[]): readonly Syntax[] => {
            const emitted: Syntax[] = [];
            let at = 0;
            if (spelt(entry[at], "...")) {
              emitted.push(entry[at]!);
              at += 1;
            }
            // The key of a property, and the `:` in front of the target it
            // reads into. An array pattern writes no key, and a shorthand
            // property is its own target.
            if (node.delimiter === "brace") {
              const colon = entry.findIndex(
                (child, offset) => offset >= at && spelt(child, ":"),
              );
              for (; colon >= 0 && at <= colon; at += 1) {
                const child = entry[at]!;
                if (child.tag === "group" && child.delimiter === "bracket")
                  emitted.push(
                    createGroup({
                      ...child,
                      id: options.allocateSyntaxId(),
                      children: createSyntaxSequence(
                        walkAs(child.children, "expr"),
                      ),
                    }),
                  );
                else emitted.push(named(child));
              }
            }
            // The target: a name, or a pattern of its own. Then the default,
            // which is an expression.
            const equals = entry.findIndex(
              (child, offset) => offset >= at && spelt(child, "="),
            );
            const target = equals < 0 ? entry.length : equals;
            for (; at < target; at += 1) {
              const child = entry[at]!;
              if (child.tag === "group")
                emitted.push(...walkAs([child], "binding"));
              else emitted.push(named(child));
            }
            if (equals >= 0) {
              emitted.push(entry[equals]!);
              emitted.push(...walkAs(entry.slice(equals + 1), "expr"));
            }
            return emitted;
          };
          const children: Syntax[] = [];
          let entry: Syntax[] = [];
          for (const child of node.children) {
            if (spelt(child, ",")) {
              children.push(...expandEntry(entry), child);
              entry = [];
              continue;
            }
            entry.push(child);
          }
          children.push(...expandEntry(entry));
          output.push(
            createGroup({
              ...node,
              id: options.allocateSyntaxId(),
              children: createSyntaxSequence(children),
            }),
          );
          index += 1;
          continue;
        }
        // A raw brace body reached under a statement or item category is a
        // statement list. Enforesting it here assigns interior categories, so
        // an expression macro inside it is seen as an expression rather than
        // walked as part of the enclosing statement. A body that is already
        // enforested, or that does not parse as a statement list, is left for
        // the ordinary descent below.
        // Statements inside a function body are statements however the
        // expression around it is categorized, so a statement macro written in
        // a template's arrow or function body resolves in the statement space.
        const typeGroupFollows = typeFollows();
        const bodyCategory: SyntaxCategory =
          // A group sitting among JSX children holds an expression: a braced
          // container, or a nested element.
          node.tag === "group" && category === "jsxChild"
            ? "expr"
            : // An interface body is a member list wherever the interface is
              // declared, and the `interface` that heads it says so however
              // the syntax around the declaration is being walked.
              node.tag === "group" &&
                node.delimiter === "brace" &&
                braceOpens(walkedRun, output.length) === "interface"
              ? "typeMember"
              : node.tag === "group" &&
                  node.delimiter === "brace" &&
                  // A function body holds statements wherever the function
                  // itself stands. Asking only in expression category left the
                  // body of a `function` or method emitted by an item template
                  // walked as items, where no expression macro resolves.
                  (category === "expr" ||
                    category === "stmt" ||
                    category === "item" ||
                    category === "classElement" ||
                    // A parameter's default may be a function, and its body is a
                    // statement list however the parameter list is walked.
                    category === "binding") &&
                  // A method in an object literal is written without
                  // `function`, and its body is as much a statement list. So is
                  // a class static block. A brace inside a return type is an
                  // object type, however the type around it is written, and so
                  // is one inside the type a type alias declares.
                  !inTypeRegion() &&
                  (functionBodyFollows(output, output.length) ||
                    braceOpens(walkedRun, output.length) === "function" ||
                    (category === "classElement" &&
                      staticBlockFollows(output.at(-1))))
                ? "stmt"
                : // A class body holds members wherever the class stands. Read
                  // as a statement list, `value = f(x);` is an assignment, and a
                  // member no statement can spell leaves the body unread.
                  node.tag === "group" &&
                    node.delimiter === "brace" &&
                    (category === "expr" ||
                      category === "stmt" ||
                      category === "item") &&
                    braceOpens(walkedRun, output.length) === "class"
                  ? "classElement"
                  : // A computed member name is an expression, evaluated where
                    // the class is.
                    node.tag === "group" &&
                      node.delimiter === "bracket" &&
                      category === "classElement" &&
                      computedMemberNameFollows(output.slice(memberStart), node)
                    ? "expr"
                    : node.tag === "group" &&
                        node.delimiter === "parenthesis" &&
                        catchBinderFollows(output.at(-1))
                      ? "binding"
                      : // A bracket inside a member list holds a type, not
                        // another member: a mapped type's key, an index
                        // signature's, a computed one. Walking it as a member
                        // list made `{ [K in keyof list<string>]: 1 }` read
                        // `list` as the name of a member rather than as the type
                        // macro it is.
                        node.tag === "group" &&
                          node.delimiter === "bracket" &&
                          category === "typeMember"
                        ? "type"
                        : // A brace standing where a type is written is an
                          // object type, and its contents are a member list
                          // rather than one more type.
                          node.tag === "group" &&
                            node.delimiter === "brace" &&
                            (category === "type" || typeGroupFollows)
                          ? "typeMember"
                          : node.tag === "group" &&
                              category !== "type" &&
                              (node.delimiter === "bracket" ||
                                node.delimiter === "parenthesis") &&
                              typeGroupFollows
                            ? "type"
                            : // A function's parameter list holds binders: the
                              // patterns, the names in them, their annotations
                              // and their defaults. A member's parameter list is
                              // walked as tokens where the class body is, and
                              // read as members its patterns were read as member
                              // lists -- where a `:` opens a type, so the default
                              // written past one never reached an expression.
                              // Asked after the type readings, so a parenthesised
                              // function type inside a return type stays a type.
                              node.tag === "group" &&
                                node.delimiter === "parenthesis" &&
                                parameterList(
                                  node,
                                  runAhead(index),
                                  output.length,
                                )
                              ? "binding"
                              : node.tag === "group" &&
                                  category !== "expr" &&
                                  ((node.delimiter === "parenthesis" &&
                                    (conditionFollows(output) ||
                                      classHeritageFollows(output))) ||
                                    initializerFollows(output) ||
                                    // An argument list, a parenthesised operand, an
                                    // index: a group reached inside an expression
                                    // region holds an expression however the
                                    // statement around it is categorized.
                                    ((node.delimiter === "parenthesis" ||
                                      node.delimiter === "bracket") &&
                                      expressionRegion))
                                ? "expr"
                                : node.tag === "group" &&
                                    node.delimiter === "parenthesis" &&
                                    decoratorArgumentsFollow(output)
                                  ? "expr"
                                  : category;
        const innerContexts = contextsWithin(
          node,
          runAhead(index),
          output.length,
          contexts,
        );
        const statementBody =
          node.tag === "group" &&
          node.delimiter === "brace" &&
          bodyCategory === "stmt" &&
          !holdsStatementOperator(node.children) &&
          node.children.some((child) => child.tag === "token")
            ? options.enforestStatements?.({
                syntax: node.children,
                contexts: innerContexts,
                lexicalModule,
              })
            : undefined;
        // A class body is enforested as its members, as the body of a class
        // declared at module level is, so a static block is read as the
        // statement list it is and each member is walked on its own.
        const classMembers =
          node.tag === "group" &&
          node.delimiter === "brace" &&
          bodyCategory === "classElement" &&
          braceOpens(walkedRun, output.length) === "class" &&
          node.children.some((child) => child.tag === "token")
            ? options.enforestClassElements?.({
                syntax: node.children,
                contexts: innerContexts,
                lexicalModule,
              })
            : undefined;
        /**
         * A block is a definition context of its own, so a macro generated
         * inside one is visible for the rest of that block and no further.
         * Generated definitions are recorded in expansion-wide state, which is
         * restored when the block ends. Otherwise a macro a statement macro
         * installs for one body would stay visible afterwards -- and where two
         * bodies install the same name, whichever ran last would be the one in
         * scope after them. That is what the hygiene the language promises
         * rules out, and what `processLocalDefinitionContext` exists for.
         *
         * An item's definitions are deliberately not restored: a macro
         * generated at module level is visible to the items that follow it.
         */
        const opensBlock =
          node.tag === "group" &&
          node.delimiter === "brace" &&
          bodyCategory === "stmt";
        const enclosingModules = activeModules.length;
        const enclosingExpansionEnvironment = activeExpansionEnvironment;
        // A function body, or the concise body of an arrow, is where a `#let`
        // inside it declares its variable: each call has its own.
        const soleBrace =
          node.tag === "protected" &&
          node.children.length === 1 &&
          node.children[0]!.tag === "group" &&
          node.children[0]!.delimiter === "brace";
        const conciseArrow =
          node.tag === "protected" &&
          node.form === "arrow" &&
          !(
            node.children.at(-1)?.tag === "group" &&
            (node.children.at(-1) as Extract<Syntax, { tag: "group" }>)
              .delimiter === "brace"
          );
        const frame: LiftFrame | undefined =
          conciseArrow ||
          (((node.tag === "group" && node.delimiter === "brace") ||
            soleBrace) &&
            braceOpens(walkedRun, output.length) === "function")
            ? { names: [] }
            : undefined;
        if (frame !== undefined) liftFrames.push(frame);
        let nested;
        try {
          nested = visit(
            createSyntaxSequence(
              classMembers ?? statementBody ?? node.children,
            ),
            currentEnvironment,
            node.tag === "protected" ? node.category : bodyCategory,
            parentInvocation,
            lexicalModule,
            innerContexts,
            false,
            recursiveBinding,
            // A brace left in the expression space after every other reading
            // was ruled out is an object literal, and its members are walked
            // as the expressions they are but for the name of a method.
            node.tag === "group" &&
              node.delimiter === "brace" &&
              bodyCategory === "expr",
            node.tag === "group" &&
              (node.delimiter === "parenthesis" ||
                node.delimiter === "bracket"),
          );
        } finally {
          if (frame !== undefined) liftFrames.pop();
        }
        if (opensBlock) {
          activeModules.length = enclosingModules;
          activeExpansionEnvironment = enclosingExpansionEnvironment;
        }
        currentEnvironment = nested.environment;
        if (node.tag === "protected" && nested.syntax.length === 0) {
          index += 1;
          continue;
        }
        const children =
          frame === undefined || frame.names.length === 0
            ? nested.syntax
            : conciseArrow
              ? withConciseBodyDeclaring(nested.syntax, frame.names)
              : soleBrace
                ? createSyntaxSequence(
                    nested.syntax.map((child) =>
                      child.tag === "group" && child.delimiter === "brace"
                        ? createGroup({
                            ...child,
                            id: options.allocateSyntaxId(),
                            children: declaringFirst(
                              child.children,
                              frame.names,
                            ),
                          })
                        : child,
                    ),
                  )
                : declaringFirst(nested.syntax, frame.names);
        output.push(
          node.tag === "group"
            ? createGroup({
                ...node,
                id: options.allocateSyntaxId(),
                children,
              })
            : createProtectedSyntax({
                ...node,
                id: options.allocateSyntaxId(),
                children,
              }),
        );
      } else {
        output.push(node);
      }
      index += 1;
    }
    regions.pop();
    return Object.freeze({
      syntax: createSyntaxSequence(output),
      environment: currentEnvironment,
    });
  };

  // A module is where a `#let` outside any function declares its variable.
  const moduleFrame: LiftFrame | undefined =
    options.category === "item" ? { names: [] } : undefined;
  if (moduleFrame !== undefined) liftFrames.push(moduleFrame);
  let visited;
  try {
    visited = visit(
      options.syntax,
      options.environment,
      options.category,
      options.parentInvocation,
      options.module,
      options.contexts ?? new Set(),
    );
  } finally {
    if (moduleFrame !== undefined) liftFrames.pop();
  }
  const moduleNames = moduleFrame?.names ?? [];
  const expanded =
    moduleNames.length === 0
      ? visited
      : {
          ...visited,
          syntax: (() => {
            const at = afterDirectives(visited.syntax);
            const anchor = moduleNames[0]!;
            return createSyntaxSequence([
              ...visited.syntax.slice(0, at),
              createProtectedSyntax({
                id: options.allocateSyntaxId(),
                span: { start: anchor.span.start, end: anchor.span.start },
                origin: anchor.origin,
                scopes: anchor.scopes,
                category: "item",
                children: liftedDeclaration(anchor, moduleNames),
              }),
              ...visited.syntax.slice(at),
            ]);
          })(),
        };
  /**
   * The whole expansion has to read as one node of the category asked for. A
   * template that does not produce one is something its author wrote -- two
   * statements where an expression was wanted, or JSX in a file whose
   * extension cannot hold it -- so it is reported, rather than leaving here as
   * a thrown error that abandons the expansion of every file in the project
   * and names neither the macro nor where it was written.
   */
  const categorized = (): SyntaxSequence => {
    if (diagnostics.length > 0) return expanded.syntax;
    if (expanded.syntax.length === 0) return createSyntaxSequence([]);
    try {
      return createSyntaxSequence([
        enforestSequence(
          expanded.syntax,
          options.category,
          options.module,
          options.contexts ?? new Set(),
        ),
      ]);
    } catch (error) {
      if (!(error instanceof EnforestationError)) throw error;
      const at = expanded.syntax[0];
      const source =
        at === undefined
          ? undefined
          : options.origins.selectPrimarySource(at.origin);
      if (at !== undefined && source !== undefined)
        diagnostics.push(
          expansionDiagnosticRegistry.create(uncategorizedExpansionCode, {
            primaryOrigin: {
              sourceId: source.sourceId,
              start: source.span.start,
              end: source.span.end,
              originId: at.origin,
            },
            messageArguments: [error.category, error.syntaxText],
          }),
        );
      else throw error;
      return expanded.syntax;
    }
  };
  const syntax = categorized();
  return Object.freeze({
    syntax,
    environment: expanded.environment,
    traces: Object.freeze(
      [...traces].sort((left, right) => left.invocationId - right.invocationId),
    ),
    diagnostics: Object.freeze(diagnostics),
    unresolvedNameExplanations: Object.freeze(unresolvedNameExplanations),
    generatedDefinitionTraces: Object.freeze(generatedDefinitionTraces),
    generatedModules: Object.freeze(activeModules.slice(1)),
    expansionEnvironment: activeExpansionEnvironment,
    offeredOperators,
    namedOrigins,
  });
}
