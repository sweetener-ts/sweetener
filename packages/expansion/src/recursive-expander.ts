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
  classElementEndsBefore,
  classMemberNameFollows,
  typeOperandFollows,
} from "@sweetener/enforestation";
import { EnforestationError } from "./enforestation-error.js";
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
  readonly generatedDefinitionTraces: readonly GeneratedDefinitionsTrace[];
  readonly generatedModules: readonly CompileParsedMacrosResult[];
  readonly expansionEnvironment: ExpansionEnvironment | undefined;
  /**
   * The operator tokens this expansion offered to their operator's rules,
   * whether or not a rule took them. An operator standing in the output that
   * was never offered is one whose expression could not be read.
   */
  readonly offeredOperators: ReadonlySet<Syntax["origin"]>;
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
  const offeredOperators = new Set<Syntax["origin"]>();
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

  /**
   * Whether a brace group in expression position opens a function body rather
   * than an object literal. A macro template commonly wraps statements in an
   * arrow or function expression, and the statements inside are statements
   * however the enclosing replacement is categorized.
   */
  const functionBodyFollows = (preceding: readonly Syntax[]): boolean => {
    const lastToken = (node: Syntax | undefined): TokenSyntax | undefined => {
      let current = node;
      while (current !== undefined && current.tag !== "token") {
        current = current.children.at(-1);
      }
      return current;
    };
    const previous = preceding.at(-1);
    if (lastToken(previous)?.raw === "=>") return true;
    // `function (...) {`, including a name and a generator star.
    if (previous?.tag !== "group" || previous.delimiter !== "parenthesis")
      return false;
    for (let index = preceding.length - 2; index >= 0; index -= 1) {
      const candidate = preceding[index]!;
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
    if (previous.raw === "=" && typeArgumentDepth(preceding) > 0) return true;
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
    for (let at = preceding.length - 2; at >= 0; at -= 1) {
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
   * How deep in type arguments the end of `nodes` stands, counted forwards: a
   * `<` still open there encloses everything after it.
   */
  const typeArgumentDepth = (nodes: readonly Syntax[]): number => {
    let depth = 0;
    for (const node of nodes) {
      depth += angles(node, "<");
      depth = Math.max(0, depth - angles(node, ">"));
    }
    return depth;
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

  /** Whether the next node stands where a declaration names what it binds. */
  const binderFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    if (previous?.tag !== "token") return false;
    return ["const", "let", "var", "using"].includes(previous.raw);
  };

  /** Whether a parenthesis group names what a `catch` binds. */
  const catchBinderFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    return previous?.tag === "token" && previous.raw === "catch";
  };

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
  ): readonly SyntaxSequence[] => {
    const segments: SyntaxSequence[] = [];
    let segment: Syntax[] = [];
    for (const node of sequence) {
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

  const regionBindings = (sequence: SyntaxSequence): RegionBindings => {
    const extract = options.extractBindings;
    const values = new Set<string>();
    const types = new Set<string>();
    if (extract === undefined) return Object.freeze({ values, types });
    const addBinders = (
      entries: readonly SyntaxSequence[],
      into: Set<string>,
    ): void => {
      for (const entry of entries) {
        for (const name of extract(entry)) into.add(name.spelling);
      }
    };
    /**
     * A statement list's entries arrive protected, so the declarations in them
     * are one level down. A brace is never entered: what it binds belongs to
     * the region it opens, not to this one.
     */
    const collect = (
      nodes: readonly Syntax[],
      inImport: boolean,
      // True once a statement or item node has been entered. What a
      // declaration binds belongs to the region around it, but what its
      // parameters and loop head bind belongs to the region it opens, and that
      // region is walked separately. Without this a parameter leaked into the
      // module and shadowed the macro for the whole file.
      nested: boolean,
    ): void => {
      for (let at = 0; at < nodes.length; at += 1) {
        const node = nodes[at]!;
        if (node.tag === "protected") {
          collect(node.children, inImport, true);
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
          if (inImport && node.delimiter === "brace") {
            // `import { a, b as c }` binds the local name of each specifier.
            for (const segment of bindingSegments(node.children)) {
              const local = segment.at(-1);
              if (local?.tag === "token" && local.kind === "identifier")
                values.add(local.raw);
            }
            continue;
          }
          if (node.delimiter !== "parenthesis") continue;
          if (bindsParameters(node, nodes.slice(at + 1), nodes.slice(0, at)))
            addBinders(bindingSegments(node.children), values);
          else collect(node.children, false, nested);
          continue;
        }
        if (node.tag !== "token") continue;
        // `# let (name = value) { body }` names the variable of a `#let`, which
        // the expansion declares itself where the body needs one.
        const afterHash =
          nodes[at - 1]?.tag === "token" &&
          (nodes[at - 1] as TokenSyntax).raw === "#";
        if (valueDeclarationKeywords.has(node.raw) && !afterHash) {
          addBinders(bindingSegments(nodes.slice(at + 1)), values);
          continue;
        }
        const named = namedDeclarations.get(node.raw);
        if (named !== undefined) {
          const name = nodes[at + 1];
          if (name?.tag === "token" && name.kind === "identifier") {
            if (named !== "type") values.add(name.raw);
            if (named !== "value") types.add(name.raw);
          }
          continue;
        }
        if (node.raw === "import") {
          collect(nodes.slice(at + 1), true, nested);
          return;
        }
        // An arrow's single parameter is written without parentheses.
        const following = nodes[at + 1];
        if (
          node.kind === "identifier" &&
          following?.tag === "token" &&
          following.raw === "=>"
        )
          values.add(node.raw);
      }
    };
    collect(sequence, false, false);
    return Object.freeze({ values, types });
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
   * in `nodes`: `async` and a type parameter list are read past. Undefined
   * where a type parameter list does not close.
   */
  const arrowHeadBefore = (
    nodes: readonly Syntax[],
    end: number,
  ): number | undefined => {
    let at = end - 1;
    if (angles(nodes[at], ">") > 0) {
      let depth = 0;
      for (; at >= 0; at -= 1) {
        const node = nodes[at]!;
        depth += angles(node, ">") - angles(node, "<");
        if (depth <= 0) break;
      }
      if (at < 0) return undefined;
      at -= 1;
    }
    const modifier = nodes[at];
    if (modifier?.tag === "token" && modifier.raw === "async") at -= 1;
    return at;
  };

  /**
   * Whether an arrow's parameters can begin at `end` in `nodes`. An arrow is an
   * assignment expression, so it begins where one does: at the start of a
   * group or a statement, or after an assignment, a comma, a conditional's `?`
   * or `:`, `=>`, `return` and the like. A parenthesis group after an operand
   * -- a name, a literal, a closing group, a member access -- is that operand's
   * argument list, and after any other operator it is a parenthesized operand;
   * neither is ever an arrow's parameters, whatever follows it.
   */
  const arrowParametersCanFollow = (
    nodes: readonly Syntax[],
    end: number,
  ): boolean => {
    const at = arrowHeadBefore(nodes, end);
    if (at === undefined) return false;
    const previous = nodes[at];
    if (previous === undefined) return true;
    if (previous.tag === "group") return previous.delimiter === "brace";
    if (previous.tag === "protected") return previous.category !== "expr";
    return (
      previous.tag === "token" && assignmentExpressionHeads.has(previous.raw)
    );
  };

  /**
   * Where the `=>` of an arrow stands in `following`, when the parameter list
   * just before `from` begins one; the list's head ends at `end` in
   * `preceding`.
   *
   * A return type may stand between the parameters and `=>`. In a
   * conditional's consequent TypeScript reads one only when the arrow is
   * followed by the conditional's own `:`, so `c ? (x): T => x : y` is an arrow
   * while in `c ? (x) : (y) => y` the consequent is `(x)`.
   *
   * TypeScript decides that by parsing the body and looking at the token after
   * it; `arrowBodyEnd` instead counts the `?` and `:` written beside the body.
   * The two agree: every group is already one node here, so a `?` or `:` at
   * this level belongs to a conditional -- an object literal's, an
   * annotation's and a type's are all inside a group -- and the count pairs
   * them exactly as the grammar nests them.
   */
  const arrowAfterParameters = (
    preceding: readonly Syntax[],
    end: number,
    following: readonly Syntax[],
    from: number,
  ): number | undefined => {
    if (!arrowParametersCanFollow(preceding, end)) return undefined;
    const spelled = (node: Syntax | undefined, raw: string): boolean =>
      node?.tag === "token" && node.raw === raw;
    if (spelled(following[from], "=>")) return from;
    if (!spelled(following[from], ":")) return undefined;
    let arrow = from + 1;
    let typeArguments = 0;
    for (; arrow < following.length; arrow += 1) {
      const node = following[arrow]!;
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
    if (arrow === following.length) return undefined;
    if (!spelled(preceding[arrowHeadBefore(preceding, end)!], "?"))
      return arrow;
    return arrowBodyEnd(following, arrow + 1).conditional ? arrow : undefined;
  };

  /**
   * Where a concise arrow body starting at `from` in `nodes` ends: at a `,` or
   * `;` beside it, or at a `:` that belongs to a conditional around the arrow
   * rather than to one in its body. `conditional` says which it was.
   */
  const arrowBodyEnd = (
    nodes: readonly Syntax[],
    from: number,
  ): { readonly end: number; readonly conditional: boolean } => {
    let conditionals = 0;
    for (let at = from; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      if (node.tag !== "token") continue;
      if (node.raw === "?") conditionals += 1;
      else if (node.raw === ":") {
        if (conditionals === 0) return { end: at, conditional: true };
        conditionals -= 1;
      } else if (node.raw === "," || node.raw === ";")
        return { end: at, conditional: false };
    }
    return { end: nodes.length, conditional: false };
  };

  /**
   * Whether a parenthesis group holds names being bound rather than an
   * expression: a parameter list, or what a `catch` binds.
   */
  const bindsParameters = (
    node: Syntax,
    after: readonly Syntax[],
    preceding: readonly Syntax[],
  ): boolean => {
    if (node.tag !== "group" || node.delimiter !== "parenthesis") return false;
    if (catchBinderFollows(preceding)) return true;
    // A control-flow header is not a parameter list, though it is followed by a
    // body like one. What a `for` binds is written with a keyword inside it, so
    // it is found by reading the header rather than by reading its entries.
    const previous = preceding.at(-1);
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
    return parameterList(preceding, node, after, 0);
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
    preceding: readonly Syntax[],
    inExpression: boolean,
  ): boolean => {
    const previous = preceding.at(-1);
    if (previous === undefined) return false;
    if (previous.tag === "protected") return previous.category === "expr";
    if (previous.tag === "group") {
      if (previous.delimiter !== "brace") return true;
      // A brace ends an operand when it is an object literal. Where a statement
      // is read it is a block, and after an arrow or a function head it is a
      // body -- neither of which anything is applied to.
      return inExpression && !functionBodyFollows(preceding.slice(0, -1));
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
          endsOperand(preceding.slice(0, -1), inExpression)
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

  /** Whether a brace written next is a class static block, `static {`. */
  const staticBlockFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    return previous?.tag === "token" && previous.raw === "static";
  };

  interface BraceHeader {
    readonly opens: "function" | "class" | "other";
    /** Where a function's parameter list stands in what precedes the brace. */
    readonly parameters?: number;
    /**
     * Whether `yield` is an expression inside the brace, where the brace
     * decides that for itself: a function body by whether the function is a
     * generator, and a class static block never. Undefined where the brace is
     * inside whatever function holds it.
     */
    readonly yields: boolean | undefined;
  }
  const otherBrace: BraceHeader = { opens: "other", yields: undefined };
  const classBrace: BraceHeader = { opens: "class", yields: undefined };

  /**
   * Whether the function whose parameter list stands at `parameters` is a
   * generator. The star is written in front of the name -- `function* name(`,
   * `async *name(`, `static *[key](` -- or in place of one, `function* (`; a
   * type parameter list may stand between the name and the parameters.
   */
  const generatorHeader = (
    preceding: readonly Syntax[],
    parameters: number,
  ): boolean => {
    let at = parameters - 1;
    if (angles(preceding[at], ">") > 0) {
      let depth = 0;
      for (; at >= 0; at -= 1) {
        const node = preceding[at]!;
        depth += angles(node, ">") - angles(node, "<");
        if (depth <= 0) break;
      }
      at -= 1;
    }
    const star = (node: Syntax | undefined): boolean =>
      node?.tag === "token" && node.raw === "*";
    return star(preceding[at]) || star(preceding[at - 1]);
  };

  /**
   * What a brace group opens, read from what stands before it: the body of a
   * function, arrow or method, and whether that function is a generator; the
   * body of a class; or anything else -- a block, an object literal, a
   * `switch`, a class static block. Only the syntax already walked is
   * consulted, as `functionBodyFollows` does.
   */
  const braceHeader = (preceding: readonly Syntax[]): BraceHeader => {
    const previous = preceding.at(-1);
    // An arrow is never a generator.
    if (lastTokenOf(previous)?.raw === "=>")
      return { opens: "function", yields: false };
    // A static block is evaluated as a function of its own, where `yield` is
    // not an expression.
    if (staticBlockFollows(preceding)) return { opens: "other", yields: false };
    // The header is read back to where the statement or member began. A
    // class body is recognized by its keyword, which also covers
    // `class A extends mixin(B) {` with a parameter list in front of its body.
    let parameters: number | undefined;
    // Type arguments in a return type hold commas of their own:
    // `Generator<number, number, number>`.
    let typeArguments = 0;
    for (let at = preceding.length - 1; at >= 0; at -= 1) {
      const node = preceding[at]!;
      if (node.tag === "token") {
        typeArguments += angles(node, ">");
        typeArguments = Math.max(0, typeArguments - angles(node, "<"));
        if (typeArguments > 0 || angles(node, "<") > 0) continue;
        if (node.raw === "class") return classBrace;
        if (
          statementBoundaries.has(node.raw) ||
          node.raw === "=" ||
          node.raw === "?"
        )
          break;
        // A return type annotation stands between a parameter list and the
        // body: `m(): Promise<T> {`. A colon with nothing after it annotates
        // nothing, and is a `case (x): {` or the `: {` of a conditional.
        const before = preceding[at - 1];
        if (
          parameters === undefined &&
          node.raw === ":" &&
          at !== preceding.length - 1 &&
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
        !typeOperandFollows(preceding[at - 1])
      )
        break;
    }
    if (previous?.tag === "group" && previous.delimiter === "parenthesis")
      parameters = preceding.length - 1;
    if (parameters === undefined) return otherBrace;
    const opener = preceding[parameters - 1];
    const functionBrace: BraceHeader = {
      opens: "function",
      parameters,
      yields: generatorHeader(preceding, parameters),
    };
    // A function, method or accessor names itself, or is `function` or `*`;
    // a computed name is a bracket group and a generic one ends in `>`.
    if (opener?.tag === "group")
      return opener.delimiter === "bracket" ? functionBrace : otherBrace;
    if (opener?.tag !== "token") return otherBrace;
    if (controlKeywords.has(opener.raw)) return otherBrace;
    if (
      opener.raw === "await" &&
      lastTokenOf(preceding[parameters - 2])?.raw === "for"
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
    preceding: readonly Syntax[],
  ): "function" | "class" | "other" => braceHeader(preceding).opens;

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
   * Whether `group`, standing after `preceding` and before `following` from
   * `from` on, is a function's parameter list: an arrow's, where an arrow can
   * begin and with `=>` after it and any return type, or the one the header of
   * the body after it names. An object type written as a return type is passed
   * over on the way to the body.
   */
  const parameterList = (
    preceding: readonly Syntax[],
    group: Syntax,
    following: readonly Syntax[],
    from: number,
  ): boolean => {
    if (group.tag !== "group" || group.delimiter !== "parenthesis")
      return false;
    if (
      arrowAfterParameters(preceding, preceding.length, following, from) !==
      undefined
    )
      return true;
    let typeArguments = 0;
    for (let at = from; at < following.length; at += 1) {
      const node = following[at]!;
      if (node.tag === "token") {
        if (at === from && node.raw !== ":") return false;
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
        if (at === from) return false;
        continue;
      }
      if (typeOperandFollows(following[at - 1])) continue;
      return (
        braceHeader([...preceding, group, ...following.slice(from, at)])
          .parameters === preceding.length
      );
    }
    return false;
  };

  /**
   * The contexts inside `node`, which stands after `preceding` and before
   * `following` from `from` on. Whether `yield` is an expression is decided by
   * the function it is written directly in, so a function body is a generator
   * or not by its own header -- `function*`, `*method()` -- whatever function
   * encloses it, and an arrow never is one. A parameter list, even a
   * generator's, and a class static block admit no `yield`. Any other group, a
   * block or an object literal or an argument list, is inside whatever
   * function holds it and inherits.
   */
  const contextsWithin = (
    node: Syntax,
    preceding: readonly Syntax[],
    following: readonly Syntax[],
    from: number,
    inherited: ReadonlySet<MacroContext>,
  ): ReadonlySet<MacroContext> =>
    withYield(
      inherited,
      node.tag === "protected" && node.form === "arrow"
        ? false
        : braceBody(node)
          ? braceHeader(preceding).yields
          : parameterList(preceding, node, following, from)
            ? false
            : undefined,
    );

  /**
   * `contexts` with `yield` an expression or not, as `yields` says; unchanged
   * where it is undefined.
   */
  const withYield = (
    contexts: ReadonlySet<MacroContext>,
    yields: boolean | undefined,
  ): ReadonlySet<MacroContext> => {
    if (yields === undefined || contexts.has("generator") === yields)
      return contexts;
    const changed = new Set(contexts);
    if (yields) changed.add("generator");
    else changed.delete("generator");
    return changed;
  };

  /**
   * Where a function, arrow or class written as tokens ends, when one begins
   * at `at`: the index just past it. Syntax a template spliced into a group
   * is not parsed, so a closure there is a run of tokens rather than one node.
   * An arrow's body runs to the next `,` or `;` standing beside it.
   *
   * An arrow is told apart from a `function` because the two differ in what
   * they are: an arrow is never a generator, so `yield` is not an expression
   * anywhere in it, while a `function*` written here opens one.
   */
  const closureEndAt = (
    nodes: readonly Syntax[],
    at: number,
  ):
    | { readonly end: number; readonly kind: "function" | "class" | "arrow" }
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
    const start = token(at, "async") ? at + 1 : at;
    if (token(start, "function")) {
      const end = braceAfter(start + 1);
      return end === undefined ? undefined : { end, kind: "function" };
    }
    if (at === start && token(at, "class")) {
      const end = braceAfter(at + 1);
      return end === undefined ? undefined : { end, kind: "class" };
    }
    const parameters = nodes[start];
    const named =
      parameters?.tag === "token" && parameters.kind === "identifier";
    const listed =
      parameters?.tag === "group" && parameters.delimiter === "parenthesis";
    if (!named && !listed) return undefined;
    const arrow = listed
      ? arrowAfterParameters(nodes, start, nodes, start + 1)
      : arrowParametersCanFollow(nodes, start) && token(start + 1, "=>")
        ? start + 1
        : undefined;
    if (arrow === undefined) return undefined;
    const { end } = arrowBodyEnd(nodes, arrow + 1);
    return end === arrow + 1 ? undefined : { end, kind: "arrow" };
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
          node.delimiter === "brace" ? braceOpens(nodes.slice(0, at)) : "other";
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
          (child, index) =>
            child.tag === "group" &&
            child.delimiter === "brace" &&
            braceOpens(node.children.slice(0, index)) === "function" &&
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
     * Where the arrow this walk stands inside ends, as an index into `input`;
     * 0 when it stands in none.
     *
     * An arrow is never a generator, so `yield` is not an expression anywhere
     * in one however the function around it is written. Where the arrow is a
     * node, `contextsWithin` answers for it on the way in. Where it is only a
     * run of tokens -- a replacement before it is parsed, a block holding a
     * statement operator, which is walked raw by design -- there is nothing to
     * descend into, and the generator context of the function around it
     * reached the arrow's body: a macro declared `context generator` was
     * admitted there and wrote a `yield` inside an arrow, which TypeScript
     * then reports on generated code.
     */
    let arrowEndsAt = 0;
    const enterRegionContexts = (next: ReadonlySet<MacroContext>) => {
      regionContexts = next;
      contexts = arrowEndsAt > 0 ? withYield(next, false) : next;
    };
    let input = initialInput;
    regions.push(regionBindings(initialInput));
    const output: Syntax[] = [];
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
      typeRegion ||
      (category === "expr" || expressionRegion
        ? typeFollowsInExpression(output)
        : typePositionFollows(output));
    while (index < input.length) {
      const node = input[index]!;
      const walked = output.at(-1);
      if (!typeRegion && walked?.tag === "token" && walked.raw === ":") {
        const parameters = output.at(-2);
        if (
          parameters?.tag === "group" &&
          parameters.delimiter === "parenthesis" &&
          parameterList(
            output.slice(0, -2),
            parameters,
            [walked, ...input.slice(index)],
            0,
          )
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
      // where `yield` is not an expression. The rest of a member -- its
      // computed name, a decorator -- is inside whatever function holds the
      // class. A member list the class element reader could not take whole
      // -- one holding a decorator TypeScript rejects -- is walked as tokens,
      // so a member ends where that reader ends one, and the initializer and
      // the expression it began end with it.
      if (category === "classElement") {
        if (classElementEndsBefore(output.slice(memberStart), node)) {
          memberStart = output.length;
          enterRegionContexts(enclosingContexts);
          expressionRegion = false;
        } else if (walked?.tag === "token" && walked.raw === "=")
          enterRegionContexts(withYield(enclosingContexts, false));
      }
      // Measured only outside any arrow already open: one written inside
      // another is inside it too, and the contexts are already narrowed.
      if (index >= arrowEndsAt) {
        if (arrowEndsAt > 0) {
          arrowEndsAt = 0;
          contexts = regionContexts;
        }
        const closure = closureEndAt(input, index);
        if (closure?.kind === "arrow") {
          arrowEndsAt = closure.end;
          contexts = withYield(regionContexts, false);
        }
      }
      if (walked?.tag === "token") {
        if (expressionRegionEnds.has(walked.raw)) expressionRegion = false;
        else if (
          expressionRegionHeads.has(walked.raw) ||
          // The `=` of a type alias opens a type, not an expression.
          (initializerFollows(output) && !typePositionFollows(output))
        )
          expressionRegion = true;
      }
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
            : contextsWithin(protectedCapture, output, [], 0, contexts),
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
        node.tag === "token" &&
        !namesMember &&
        !namesProperty &&
        readsWalkedSpace
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
        (readsType ? !namesProperty : typeRegion || typePositionFollows(output))
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
       * name written there could be nothing but an invocation of it. A macro
       * declared for another space is left alone and emitted verbatim, which
       * TypeScript reports as a name it cannot find, as an implicitly-typed
       * member, or -- when it is not asking for either -- as nothing at all.
       *
       * Not asked where a bare name is ordinary syntax: a member list names
       * members, a declaration names what it binds, a qualified name names a
       * property, and a name in front of a `:` names a key or a label.
       */
      const spaceRead = (): SyntaxCategory | undefined => {
        const next = input[index + 1];
        if (
          namesProperty ||
          namesMember ||
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
        if (typeRegion || typePositionFollows(output)) return undefined;
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
          if (source !== undefined)
            diagnostics.push(
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
       * is, so a name used above its definition is not a macro there. It is
       * reported here: left alone, the invocation is emitted as a call to a
       * name the output does not define, and the only report would come from
       * TypeScript, which says the name is missing and nothing about the macro
       * below it.
       *
       * Not reported where the name is deliberately something else: shadowed
       * by an ordinary binding, naming a property or a member, or spelling a
       * core form whose interception was never authorized.
       */
      if (
        resolvedMacro === undefined &&
        !namesMember &&
        !namesProperty &&
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
          diagnostics.push(
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
      if (namesMember || namesProperty) resolvedMacro = undefined;
      if (
        resolvedMacro !== undefined &&
        resolvedMacro.binding.kind === "macro" &&
        resolvedCategory === "expr" &&
        punctuationSpelled(resolvedMacro.binding.spelling) &&
        endsOperand(output, category === "expr" || expressionRegion)
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
          diagnostics.push(result.diagnostic);
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
          // whose attribute braces hold expressions.
          const childStart = node.children.findIndex(
            (child) => child.tag === "token" && child.raw === ">",
          );
          const childEnd = node.children.findIndex(
            (child) => child.tag === "token" && child.raw === "</",
          );
          const head = childStart < 0 ? node.children.length : childStart + 1;
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
          const jsxChildren: Syntax[] = [
            ...node.children.slice(0, head).flatMap(expandChild),
          ];
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
          !typeRegion &&
          node.children.some(
            (child) => child.tag === "token" && child.raw === ":",
          )
        ) {
          const children: Syntax[] = [];
          let member: Syntax[] = [];
          const expandExpression = (syntax: readonly Syntax[]): Syntax[] => {
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
                if (child.tag !== "group" || child.delimiter !== "bracket")
                  return child;
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
              children.push(...expandExpression(member));
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
            : node.tag === "group" &&
                node.delimiter === "brace" &&
                // A function body holds statements wherever the function
                // itself stands. Asking only in expression category left the
                // body of a `function` or method emitted by an item template
                // walked as items, where no expression macro resolves.
                (category === "expr" ||
                  category === "stmt" ||
                  category === "item" ||
                  category === "classElement") &&
                // A method in an object literal is written without
                // `function`, and its body is as much a statement list. So is
                // a class static block. A brace inside a return type is an
                // object type, however the type around it is written.
                !typeRegion &&
                (functionBodyFollows(output) ||
                  braceOpens(output) === "function" ||
                  (category === "classElement" && staticBlockFollows(output)))
              ? "stmt"
              : // A class body holds members wherever the class stands. Read
                // as a statement list, `value = f(x);` is an assignment, and a
                // member no statement can spell leaves the body unread.
                node.tag === "group" &&
                  node.delimiter === "brace" &&
                  (category === "expr" ||
                    category === "stmt" ||
                    category === "item") &&
                  braceOpens(output) === "class"
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
                      catchBinderFollows(output)
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
                            : category;
        const innerContexts = contextsWithin(
          node,
          output,
          input,
          index + 1,
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
          braceOpens(output) === "class" &&
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
            braceOpens(output) === "function")
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
    generatedDefinitionTraces: Object.freeze(generatedDefinitionTraces),
    generatedModules: Object.freeze(activeModules.slice(1)),
    expansionEnvironment: activeExpansionEnvironment,
    offeredOperators,
  });
}
