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
  createGroup,
  createMissingToken,
  createProtectedSyntax,
  createRootSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  createToken,
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
  uncategorizedExpansionCode,
  unprocessedDefinitionCode,
  wrongCategoryMacroCode,
} from "./diagnostics.js";
import { EnforestationError } from "./enforestation-error.js";
import { ExpansionCycleError } from "./progress.js";
import type { CompiledMacroBinding, MacroContext } from "./invocation.js";
import type { CoreDispatchTrace } from "./core-shadowing.js";
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
  readonly consumeClassForMacro?:
    ((macro: CompiledMacroBinding) => SyntaxClassConsumer) | undefined;
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
 * Joining their text regardless of what stood between them read `a < - b`,
 * which is a comparison against a negation, as the operator: a silent
 * misreading of ordinary TypeScript, in a file that merely had the operator in
 * scope.
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
    if (
      [
        ":",
        "as",
        "satisfies",
        "extends",
        "|",
        "&",
        "<",
        ",",
        "?",
        "[",
        "(",
        "=>",
        // Words that exist only in a type. Without these a type macro after
        // one of them was not looked up at all, so `keyof list<string>` kept
        // the macro's own spelling and no diagnostic said why.
        "readonly",
        "keyof",
        "infer",
        "unique",
        "asserts",
        "is",
      ].includes(previous.raw)
    )
      return true;
    // The `=` of a type alias introduces a type, unlike every other `=`.
    return typeAliasInitializerFollows(preceding);
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

  /**
   * Whether the next node stands in a class heritage clause. What a class
   * extends is an expression -- `class E extends make()<T> {}` -- while what an
   * interface extends, or a type parameter is constrained by, is a type. All
   * three are written after `extends`, so the class is found by looking back
   * for the keyword, stopping at the `<` that would make this a constraint.
   */
  const classHeritageFollows = (preceding: readonly Syntax[]): boolean => {
    const previous = preceding.at(-1);
    if (previous?.tag !== "token" || previous.raw !== "extends") return false;
    for (let at = preceding.length - 2; at >= 0; at -= 1) {
      const node = preceding[at]!;
      if (node.tag !== "token") continue;
      if (node.raw === "class") return true;
      if (
        node.raw === "<" ||
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

  const contextsForContainer = (
    node: Extract<Syntax, { readonly tag: "protected" }>,
    inherited: ReadonlySet<MacroContext>,
  ): ReadonlySet<MacroContext> => {
    if (node.category !== "item") return inherited;
    const bodyIndex = node.children.findIndex(
      (child) => child.tag === "protected" && child.category === "stmt",
    );
    const header =
      bodyIndex < 0 ? node.children : node.children.slice(0, bodyIndex);
    const functionIndex = header.findIndex(
      (child) => child.tag === "token" && child.raw === "function",
    );
    const generator =
      functionIndex >= 0 &&
      header
        .slice(functionIndex + 1)
        .some((child) => child.tag === "token" && child.raw === "*");
    return generator
      ? new Set<MacroContext>([...inherited, "generator"])
      : inherited;
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
          if (bindsParameters(node, nodes[at + 1], nodes.slice(0, at)))
            addBinders(bindingSegments(node.children), values);
          else collect(node.children, false, nested);
          continue;
        }
        if (node.tag !== "token") continue;
        if (valueDeclarationKeywords.has(node.raw)) {
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

  /**
   * Whether a parenthesis group holds names being bound rather than an
   * expression: a parameter list, or what a `catch` binds.
   */
  const bindsParameters = (
    node: Syntax,
    following: Syntax | undefined,
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
    // The body may already have been enforested, in which case it arrives
    // protected rather than as the brace it was read from.
    if (following?.tag === "group" && following.delimiter === "brace")
      return true;
    if (following?.tag === "protected") return true;
    if (following?.tag !== "token") return false;
    return following.raw === "=>" || following.raw === ":";
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
    return colon?.tag === "token" && colon.raw === ":";
  };

  /** The name a definition declares, for the diagnostic that reports it. */
  const definitionSpelling = (sequence: SyntaxSequence, at: number): string => {
    const first = sequence[at + 1];
    if (first?.tag === "token" && first.raw === "class") {
      const name = sequence[at + 2];
      return name?.tag === "token" ? name.raw : "this definition";
    }
    return first?.tag === "token" ? first.raw : "this definition";
  };

  /** Regions enclosing the position being walked, outermost first. */
  const regions: RegionBindings[] = [];

  /**
   * The macro whose expansion hit a bound, once one has. Expansion stops
   * dispatching after that: the bound is global, so every later invocation
   * would reach it again and report the same thing.
   */
  let abortedSpelling: string | undefined;

  const shadowsMacro = (spelling: string, category: SyntaxCategory): boolean =>
    regions.some((region) =>
      category === "type"
        ? region.types.has(spelling)
        : region.values.has(spelling),
    );

  const visit = (
    initialInput: SyntaxSequence,
    environment: BindingEnvironment,
    category: SyntaxCategory,
    parentInvocation: InvocationId | undefined,
    lexicalModule: CompileParsedMacrosResult,
    contexts: ReadonlySet<MacroContext>,
    suppressHead = false,
    recursiveBinding?: BindingId,
  ): {
    readonly syntax: SyntaxSequence;
    readonly environment: BindingEnvironment;
  } => {
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
    while (index < input.length) {
      const node = input[index]!;
      const walked = output.at(-1);
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
            : contextsForContainer(protectedCapture, contexts),
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
      ) => {
        const category = lookupCategory;
        // Template literals use the defining module, but a capture spliced
        // into that template keeps the lexical macro imports of the source in
        // which it was written. Without this, a captured function body inside
        // `#core(function ... $body)` can only see macros imported by the
        // function-shadow definition, not macros imported at its call site.
        if (shadowsMacro(spelling, category)) return undefined;
        const lookupModule =
          positionSourceId !== undefined &&
          positionSourceId === options.sourceId &&
          !options.scopeStore.hasUnmatchedIntroduction(node.scopes)
            ? options.module
            : lexicalModule;
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
        for (let at = output.length - 1; at >= 0; at -= 1) {
          const walked = output[at]!;
          if (walked.tag !== "token") continue;
          if (walked.raw === ";" || walked.raw === ",") return true;
          if (walked.raw === ":" || walked.raw === "?") return false;
        }
        return true;
      };
      const namesMember =
        category === "typeMember" && beforeMemberType() && memberNameFollows();
      /**
       * Whether this position names a member of something rather than heading
       * an invocation. `xs.map(f)` reads a property called `map`, and
       * dispatching a macro of that name there rewrote the property access
       * into whatever the macro produced -- so a file that merely had a macro
       * named `map` in scope had every `.map(...)` in it silently rewritten.
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
      let resolvedMacro =
        node.tag === "token" && !namesMember && !namesProperty
          ? resolveSpelling(node.raw, node.span.start, sourceOf(node))
          : undefined;
      // A type is written in many places the surrounding syntax is not a type:
      // an annotation, a return type, a constraint, a member of a union.
      if (
        resolvedMacro === undefined &&
        node.tag === "token" &&
        category !== "type" &&
        typePositionFollows(output)
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
        category === "item"
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
          );
          if (candidate !== undefined) {
            resolvedMacro = candidate;
            resolvedSpelling = head.raw;
          }
        }
      }
      // A member list is the one place a bare name is ordinary syntax, so a
      // macro spelled there but declared for another category is left alone
      // and emitted verbatim -- TypeScript then reports an implicit `any`
      // member, or nothing at all when it is not asking for one. Report the
      // mismatch here, where the macro and the category are both known.
      if (
        resolvedMacro === undefined &&
        category === "typeMember" &&
        node.tag === "token" &&
        node.kind === "identifier" &&
        !namesMember
      ) {
        const elsewhere = (
          ["item", "stmt", "expr", "type", "classElement"] as const
        ).find(
          (candidate) =>
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
                messageArguments: [node.raw, elsewhere, category],
              }),
            );
        }
      }
      // A definition context is read at module level. One written inside a
      // block is not processed, and was carried through into the emitted
      // TypeScript, where the host compiler reported an unexpected identifier
      // on a line of macro language. Reporting it here names what happened.
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
        node.tag === "group" &&
        node.delimiter === "parenthesis"
      ) {
        const punctuationHeads = activeModules
          .flatMap(({ macros }) => macros)
          .filter(
            (candidate) =>
              candidate.category === category &&
              candidate.binding.kind === "macro" &&
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
      if (resolvedMacro === undefined && node.tag === "token") {
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
          );
          resolvedHeadIndex = candidateIndex;
          resolvedSpelling = candidate.raw;
        }
      }
      if (
        resolvedMacro === undefined &&
        (category === "item" || category === "stmt")
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
      if (macro !== undefined && abortedSpelling === undefined) {
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
              options.consumeClassForMacro?.(macro) ?? options.consumeClass,
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
          // and ends. Spreading its children spliced the tokens loose into
          // whatever surrounded the call, so the operators there re-bound
          // against them: `sum(1, 2) * 10` expanded to `1 + 2 * 10` and
          // computed 21 rather than 30, and `orNull(string)[]` expanded to
          // `string | null[]`, an array of `null` -- with nothing in either
          // case to say it had happened.
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
            category === "type" || typePositionFollows(output)
              ? "type"
              : "expr";
          const expandSubstitution = () => {
            if (substitution.length === 0) return;
            const enforested = enforestSequence(
              createSyntaxSequence(substitution),
              substitutionCategory,
              lexicalModule,
              contexts,
            );
            const nested = visit(
              createSyntaxSequence([enforested]),
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
        // written inside one has to be dispatched there too. Only brackets were
        // walked this way, so `(a <- b)` and every call argument spelled with a
        // custom operator kept the reading the ordinary parse gave them --
        // `a < (-b)` for an operator spelled `<-` -- silently and with no
        // diagnostic. The group is only entered when an operator's spelling
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
            const enforested = enforestSequence(
              createSyntaxSequence(segment),
              "expr",
              lexicalModule,
              contexts,
            );
            const nested = visit(
              createSyntaxSequence([enforested]),
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
          for (const child of node.children) {
            if (child.tag === "token" && child.raw === ",") {
              expandMember();
              children.push(child);
            } else member.push(child);
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
                  category === "item") &&
                functionBodyFollows(output)
              ? "stmt"
              : node.tag === "group" &&
                  node.delimiter === "parenthesis" &&
                  catchBinderFollows(output)
                ? "binding"
                : // A bracket inside a member list holds a type, not another
                  // member: a mapped type's key, an index signature's, a
                  // computed one. Walking it as a member list made
                  // `{ [K in keyof list<string>]: 1 }` read `list` as the name
                  // of a member rather than as the type macro it is.
                  node.tag === "group" &&
                    node.delimiter === "bracket" &&
                    category === "typeMember"
                  ? "type"
                  : // A brace standing where a type is written is an object
                    // type, and its contents are a member list rather than one
                    // more type.
                    node.tag === "group" &&
                      node.delimiter === "brace" &&
                      (category === "type" || typePositionFollows(output))
                    ? "typeMember"
                    : node.tag === "group" &&
                        category !== "type" &&
                        (node.delimiter === "bracket" ||
                          node.delimiter === "parenthesis") &&
                        typePositionFollows(output)
                      ? "type"
                      : node.tag === "group" &&
                          category !== "expr" &&
                          ((node.delimiter === "parenthesis" &&
                            conditionFollows(output)) ||
                            initializerFollows(output) ||
                            // An argument list, a parenthesised operand, an index:
                            // a group reached inside an expression region holds an
                            // expression however the statement around it is
                            // categorized.
                            ((node.delimiter === "parenthesis" ||
                              node.delimiter === "bracket") &&
                              expressionRegion))
                        ? "expr"
                        : category;
        const statementBody =
          node.tag === "group" &&
          node.delimiter === "brace" &&
          bodyCategory === "stmt" &&
          !holdsStatementOperator(node.children) &&
          node.children.some((child) => child.tag === "token")
            ? options.enforestStatements?.({
                syntax: node.children,
                contexts,
                lexicalModule,
              })
            : undefined;
        const nested = visit(
          createSyntaxSequence(statementBody ?? node.children),
          currentEnvironment,
          node.tag === "protected" ? node.category : bodyCategory,
          parentInvocation,
          lexicalModule,
          node.tag === "protected"
            ? contextsForContainer(node, contexts)
            : contexts,
          false,
          recursiveBinding,
        );
        currentEnvironment = nested.environment;
        if (node.tag === "protected" && nested.syntax.length === 0) {
          index += 1;
          continue;
        }
        output.push(
          node.tag === "group"
            ? createGroup({
                ...node,
                id: options.allocateSyntaxId(),
                children: nested.syntax,
              })
            : createProtectedSyntax({
                ...node,
                id: options.allocateSyntaxId(),
                children: nested.syntax,
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

  const expanded = visit(
    options.syntax,
    options.environment,
    options.category,
    options.parentInvocation,
    options.module,
    options.contexts ?? new Set(),
  );
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
  });
}
