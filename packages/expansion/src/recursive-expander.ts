import {
  definitionContextScope,
  type Binding,
  type BindingEnvironment,
  type ScopeMark,
} from "@sweetener/hygiene";
import type { SyntaxClassConsumer } from "@sweetener/pattern";
import {
  ResourceLimitError,
  type BindingId,
  type Diagnostic,
  type InvocationId,
  type ScopeId,
  type ScopeSetId,
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
  isIdentifierToken,
  isPropertyNameToken,
  leadingLineBreak,
  spanEnvelope,
  type ExpressionForm,
  type GroupSyntax,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
  type SyntaxCursor,
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
  foldPositionCode,
} from "./diagnostics.js";
import {
  foldCarrier,
  isFoldAccumulator,
  readLetBinding,
  readParameterization,
  type FoldCarrier,
} from "@sweetener/template";
import {
  arrowBodyExtent,
  asyncArrowHead,
  asyncModifies,
  asyncNamedArrow,
  continuesExpression,
  createClassMemberWalk,
  createTypeTracker,
  type ClassMemberWalk,
  staticClassMember,
  parameterBinder,
  readTypeParenthesis,
  returnTypeReadsInConsequent,
  callFollowsTypeArguments,
  typeArgumentsFollow,
  typeOperandFollows,
  type ArrowBodyExtent,
} from "@sweetener/enforestation";
import { EnforestationError } from "./enforestation-error.js";
import { chainLink, joinedChain, type ChainLink } from "./chain-joining.js";
import { separatesList } from "./macro-extent.js";
import type { NormalizedSyntax } from "./normalized-syntax.js";
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
  invokeMacroStepwise,
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
  | "followingScope"
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
  }) => NormalizedSyntax;
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
      }) => readonly NormalizedSyntax[] | undefined)
    | undefined;
  readonly enforestItems?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        /** Module whose macros are in scope for the syntax being enforested. */
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => readonly NormalizedSyntax[] | undefined)
    | undefined;
  /** Enforests a run of JSX children, for a macro that emits several. */
  readonly enforestJsxChildren?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => readonly NormalizedSyntax[] | undefined)
    | undefined;
  /** Enforests a run of interface members, for a macro that emits several. */
  readonly enforestTypeMembers?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => readonly NormalizedSyntax[] | undefined)
    | undefined;
  /** Enforests a run of class members, for a macro that emits several. */
  readonly enforestClassElements?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => readonly NormalizedSyntax[] | undefined)
    | undefined;
  /** Enforest one expression without throwing when the sequence is a fragment. */
  readonly enforestExpression?:
    | ((request: {
        readonly syntax: SyntaxSequence;
        readonly contexts: ReadonlySet<MacroContext>;
        /** Module whose macros are in scope for the syntax being enforested. */
        readonly lexicalModule?: CompileParsedMacrosResult | undefined;
      }) => NormalizedSyntax | undefined)
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
  /**
   * The bindings the invocations' binding contracts declared, with the scopes
   * each binds with, for the renaming that keeps them apart from the call
   * site's names (see `InvokeMacroOptions.bindingsDeclared`).
   */
  readonly declaredBindings: readonly Binding[];
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

/** A string that spells a name, as an enum member may be named: `'K'`. */
const enumStringName =
  /^(['"])([\p{ID_Start}_$][\p{ID_Continue}$\u200c\u200d]*)\1$/u;

const itemDispatchPrefixes = new Set([
  "export",
  "default",
  "declare",
  "async",
  "abstract",
]);

/** Whether a spelling is punctuation rather than an identifier. */
/** Whether the node at `offset` in `nodes` is the token spelled `raw`. */
function tokenAt(
  nodes: readonly Syntax[],
  offset: number,
  raw: string,
): boolean {
  const node = nodes[offset];
  return node?.tag === "token" && node.raw === raw;
}

/**
 * Where the brace that opens a body stands after `from`, as the index just
 * past it; undefined where the run ends or a `,` or `;` ends the header first.
 *
 * A brace written where a return type is is an object type, so the node in
 * front of it decides.
 */
function braceAfterIn(
  nodes: readonly Syntax[],
  from: number,
): number | undefined {
  for (let index = from; index < nodes.length; index += 1) {
    const node = nodes[index]!;
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
}

/**
 * Every space a macro can be declared for, in the order a name is looked for
 * in them. Written once rather than per lookup: the scan that asks whether a
 * name is a macro in some other space runs for every name the walk cannot
 * resolve, and built inside it the list was an array per name.
 */
const macroSpaces = Object.freeze([
  "item",
  "stmt",
  "expr",
  "type",
  "classElement",
  "typeMember",
  "binding",
  "jsxChild",
] as const);

/**
 * Whether an expression or a type spliced as `syntax` still says where it
 * begins and ends without a node around it: a lone token, or a node that
 * already bounds itself.
 *
 * A lone group does not. The braces of `{ value: 1 }` spliced loose after
 * `=>` read as a block holding a label, and the function returns nothing.
 * The same is so of a macro's result and of a capture. Nor does a lone token
 * the parser read as an expression of a form of its own: `yield` with nothing
 * to yield is a whole assignment expression, and spliced loose after `??` it
 * no longer parses.
 */
export function boundsItself(
  syntax: readonly Syntax[],
  form: ExpressionForm | undefined,
): boolean {
  return (
    form === undefined && syntax.length === 1 && syntax[0]!.tag !== "group"
  );
}

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
/**
 * A `<` the walk has passed and nothing has closed: how many angles it still
 * holds open, and what reading ahead to where it closes found, once read.
 */
interface OpenAngles {
  readonly held: number;
  answer: { readonly until: number; readonly encloses: boolean } | undefined;
}

interface SyntaxRun {
  /** The syntax walked so far, read from its start. */
  readonly walked: readonly Syntax[];
  /** What follows it, read from `from` on. */
  readonly following: readonly Syntax[];
  readonly from: number;
  /**
   * Whether the run is a run of statements, where no method stands: a
   * parameter list there is a function's only behind the `function` that
   * declares it.
   */
  readonly statements?: boolean | undefined;
  /**
   * Whether the run is a class body's members or one member of an object
   * literal, where no statement stands: a method there may be named `if`
   * or `for`, and its parameter list is no statement's head.
   */
  readonly members?: boolean | undefined;
}

/**
 * The function bodies enclosing the syntax being walked, innermost last,
 * with the variables `#let` has declared in each. A module is the outermost.
 */
interface LiftFrame {
  readonly names: TokenSyntax[];
}

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
  readonly values: ReadonlyMap<string, readonly Binder[]>;
  readonly types: ReadonlyMap<string, readonly Binder[]>;
}

/**
 * One name a region binds: the stretch of the region's run it is bound in,
 * and the scopes it was written with.
 *
 * A binding hides a macro of its spelling within its scope and nowhere
 * else, and its scope is the language's: a parameter's is its function, a
 * `catch` binding's its block, a loop variable's its loop, a type
 * parameter's what declares it, a mapped type's key's that type, and the
 * name `infer` declares has its `extends` clause and its true branch.
 * `let`, `const`, a class and a declared function are bound in the block
 * they are written in, and `var` in the function. Bound instead in the
 * whole run that held it, a parameter written in a replacement walked as
 * tokens hid the macro from everything the replacement wrote after the
 * function, and `infer`'s name hid it in the false branch too.
 *
 * A reference is to a binder only where it carries every scope the binder
 * does, which is the rule hygiene resolves a name by. A binder a template
 * wrote does not capture a name its call site wrote, nor a binder the call
 * site wrote a name the template wrote.
 */
interface Binder extends Extent {
  readonly scopes: ScopeSetId;
  /**
   * Whether this is a class's type parameter, which the class's static
   * members do not see: a static member belongs to the class itself, and
   * no one instance's type argument.
   */
  readonly ofClass: boolean;
}

/** A stretch of a run: indexes into it, from `from` up to `to`. */
interface Extent {
  readonly from: number;
  readonly to: number;
}

/**
 * The names a walk is recording, by namespace. Neither map is made until a
 * name is found for it: most of the syntax a region holds declares nothing,
 * and a walk that made a pair for each of them spent more on the empty
 * answer than on reading it.
 */
interface CollectedBindings {
  values: Map<string, Binder[]> | undefined;
  types: Map<string, Binder[]> | undefined;
}

/**
 * A region the walk stands in: what its run binds, and where in that run the
 * walk has got to -- the node it is reading, or the one it has descended
 * into.
 */
interface Region {
  /** Grows as the walk expands a declaration into the run. */
  readonly bindings: CollectedBindings;
  at: number;
  /**
   * What expansions in the run have declared in the block it stands in, to
   * be declared in turn in the run around it where the run is one
   * statement's: an item macro is expanded inside the item it stands in,
   * and what it declares is the module's. A block keeps them, but for
   * `hoisted`.
   */
  readonly declared: CollectedBindings;
  /** The `var`s among `declared`, which a block does not keep. */
  readonly hoisted: CollectedBindings;
  /**
   * The scopes binding contracts in the run gave the syntax following
   * them, to be given in turn to what follows in the run around it, as
   * `declared` is declared there.
   */
  following: ScopeSetId;
  /**
   * The following scopes every node of the run not yet walked carries
   * already. The contracts of one definition context share its scope, so
   * after the first of them the rest of the run is given nothing new.
   */
  given: ScopeSetId;
  /**
   * The scope of the definition context the run is part of: the block,
   * the function or namespace body, or the module, whose rest a
   * `following` binding contract binds in.
   */
  readonly context: () => ScopeId;
  /**
   * Where the walk entered the region, in the order scopes are allocated,
   * for telling what stood in it then from what a template wrote into it
   * since. Undefined for the module the walk began with.
   */
  readonly entered: ScopeMark | undefined;
  /**
   * The region's own scope, once a macro has been generated in it: that
   * macro was defined here, so its template carries the scope, as
   * everything written here does where the walk reads it.
   */
  scope: ScopeId | undefined;
  /**
   * Where the run is a class body, the stretches of it its static members
   * take, which the class's type parameters do not reach. Undefined for
   * any other run.
   */
  readonly statics: readonly Extent[] | undefined;
}

/** Where a run spells the infix operators asked about, as `infixSpellings` reads it. */
interface InfixSpellings {
  readonly spellings: string;
  readonly positions: readonly number[];
  readonly segmentEnds: readonly number[];
}

/** What a run spells when no infix operator is asked about. */
const noInfixSpellings: InfixSpellings = Object.freeze({
  spellings: "",
  positions: Object.freeze([]),
  segmentEnds: Object.freeze([]),
});

/**
 * What every walk of one expansion shares: the state it builds up and the
 * readings it asks of the syntax around a position.
 */
function createExpansionScope(options: ExpandMacroSyntaxOptions) {
  const traces: MacroTraceEvent[] = [];
  const diagnostics: Diagnostic[] = [];
  const unresolvedNameExplanations: Diagnostic[] = [];
  const declaredBindings: Binding[] = [];
  /**
   * Hold a sentence about the name `written` for the side that resolves
   * names, or report it, where that side's answer would be about another
   * scope.
   *
   * A name a template wrote means what its definition site sees, and is
   * printed unrenamed at the call site, where TypeScript resolves it against
   * whatever the call site binds under that spelling. Holding it let a local
   * at the call site answer for a macro the template named, and the use
   * compiled to a read of that local with nothing said.
   *
   * A name the author wrote is held against the place it was written, which
   * TypeScript's sentence is matched by, so it must have one.
   */
  const holdForTypeScript = (written: Syntax, diagnostic: Diagnostic): void => {
    if (options.scopeStore.hasUnmatchedIntroduction(written.scopes)) {
      diagnostics.push(diagnostic);
      return;
    }
    if (options.origins.selectPrimarySource(written.origin) === undefined)
      throw new Error(
        `A sentence about ${diagnostic.code} was held for a name the author wrote, but the name has no source position for TypeScript's answer to be matched against.`,
      );
    unresolvedNameExplanations.push(diagnostic);
  };
  const offeredOperators = new Set<Syntax["origin"]>();
  const namedOrigins = new Set<Syntax["origin"]>();
  const generatedDefinitionTraces: GeneratedDefinitionsTrace[] = [];
  const activeModules: CompileParsedMacrosResult[] = [
    ...(options.modules ?? [options.module]),
  ];
  if (activeModules.length === 0)
    throw new RangeError("Expansion requires at least one macro module");

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
  const typePositionFollows = (
    preceding: readonly Syntax[],
    end = preceding.length,
  ): boolean => {
    const previous = preceding[end - 1];
    if (previous?.tag !== "token") return false;
    // What a class extends is an expression, however much the `extends` of an
    // interface or a conditional type introduces a type.
    if (previous.raw === "extends" && classHeritageFollows(preceding, end))
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
    if (previous.raw === "=" && typeArgumentsOpen(preceding, end)) return true;
    // The `=` of a type alias introduces a type, unlike every other `=`.
    return typeAliasInitializerFollows(preceding, end);
  };

  /**
   * Where the run of brackets ending at each length of a run walked so far
   * begins, by run: the length itself where no bracket ends there. Each is
   * read from the one before it, once, as the run grows, so a reference with
   * a bracket after a bracket -- `o[0][0]`, as long as it is written -- does
   * not read back over every bracket before each one.
   *
   * Asked only of runs that grow at their end and never change behind it,
   * which are the runs the walk writes its output to.
   */
  const bracketRunStarts = new WeakMap<readonly Syntax[], number[]>();
  const bracketRunStart = (nodes: readonly Syntax[], end: number): number => {
    let starts = bracketRunStarts.get(nodes);
    if (starts === undefined) {
      starts = [0];
      bracketRunStarts.set(nodes, starts);
    }
    for (let at = starts.length; at <= end; at += 1) {
      const node = nodes[at - 1]!;
      starts.push(
        node.tag === "group" && node.delimiter === "bracket"
          ? starts[at - 1]!
          : at,
      );
    }
    return starts[end]!;
  };

  /**
   * Where the type reference `preceding` ends with begins: a name, qualified
   * or not, with the type arguments and the `[]` or indexed accesses written
   * after it. Undefined where `preceding` does not end with a name.
   *
   * A bracket written after a type reference is part of the type -- an array
   * type or an indexed access -- wherever the reference itself stood where a
   * type is read, which only the token in front of the reference says.
   */
  const typeReferenceStart = (
    preceding: readonly Syntax[],
  ): number | undefined => {
    let at = bracketRunStart(preceding, preceding.length);
    let closed = angles(preceding[at - 1], ">");
    if (closed > 0) {
      at -= 1;
      while (closed > 0 && at > 0) {
        at -= 1;
        closed += angles(preceding[at], ">") - angles(preceding[at], "<");
      }
      if (closed > 0) return undefined;
    }
    const name = (node: Syntax | undefined) =>
      node?.tag === "token" &&
      (node.kind === "identifier" || node.kind === "keyword");
    if (!name(preceding[at - 1])) return undefined;
    at -= 1;
    while (
      preceding[at - 1]?.tag === "token" &&
      (preceding[at - 1] as TokenSyntax).raw === "." &&
      name(preceding[at - 2])
    )
      at -= 2;
    return at;
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
  const typeFollowsInExpression = (
    preceding: readonly Syntax[],
    end = preceding.length,
  ): boolean => {
    const previous = preceding[end - 1];
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
    end = preceding.length,
  ): boolean => {
    const previous = preceding[end - 1];
    if (previous?.tag !== "token" || previous.raw !== "=") return false;
    // An alias is written `type`, its name, and the type parameters it takes,
    // so that is all that is read back over. An alias names itself, so `type`
    // is never the token directly in front of its `=`: reading back from there
    // took the `type` of a class field or a variable spelled that way -- `type
    // = () => { ... }` -- for an alias, and read the arrow's body as the type
    // it would then declare. Reading back further, to wherever a `type` was
    // written in the statement, read the statement once for every `=` in it.
    let at = end - 2;
    if (angles(preceding[at], ">") > 0) {
      let open = 0;
      for (; at >= 0; at -= 1) {
        const node = preceding[at]!;
        if (node.tag !== "token") return false;
        open += angles(node, ">") - angles(node, "<");
        if (open <= 0) break;
      }
      if (open !== 0) return false;
      at -= 1;
    }
    const name = preceding[at];
    const keyword = preceding[at - 1];
    return (
      name?.tag === "token" &&
      (name.kind === "identifier" || name.kind === "keyword") &&
      keyword?.tag === "token" &&
      keyword.raw === "type"
    );
  };

  /**
   * Whether the next node stands after an `=`. What follows one is an
   * expression wherever it appears — a parameter's default, a class field's
   * initializer — even when the syntax around it is being walked as something
   * else.
   */
  /**
   * The tokens after which a brace begins an operand: the words that take one
   * and the operators. `=` is `initializerFollows`'s, `=>` opens a function's
   * body, and `<`, `>` and `:` stand in types and labels as often.
   */
  const operandBraceAfter = new Set([
    "return",
    "throw",
    "yield",
    "await",
    "void",
    "typeof",
    "delete",
    "in",
    "of",
    "instanceof",
    "?",
    "??",
    "||",
    "&&",
    "!",
    "~",
    "+",
    "-",
    "*",
    "/",
    "%",
    "**",
    "==",
    "===",
    "!=",
    "!==",
    "<=",
    "&",
    "|",
    "^",
    "<<",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "**=",
    "&&=",
    "||=",
    "??=",
    "&=",
    "|=",
    "^=",
    "<<=",
    ",",
  ]);

  /**
   * Whether `brace`, written after `preceding`, begins an operand -- an
   * object literal -- wherever the walk stands: `return { a: 1 }` in a block
   * walked as tokens. A `return` or a `yield` with a line break before the
   * brace ends where TypeScript inserts a `;`, and the brace is a block.
   */
  const operandBraceFollows = (
    preceding: readonly Syntax[],
    brace: Syntax,
  ): boolean => {
    const previous = preceding.at(-1);
    if (previous?.tag !== "token" || !operandBraceAfter.has(previous.raw))
      return false;
    return !(
      (previous.raw === "return" || previous.raw === "yield") &&
      leadingLineBreak(brace)
    );
  };

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
   * Tokens after which a declaring keyword is a name: a key's `:`, the end
   * of a member or a statement, a member access, and a call -- `import(`
   * and `type(` read a value. A `function (` declares an anonymous function,
   * and an `export =` assigns the module's export, so each of those is the
   * keyword still.
   */
  const namedBefore = new Set([":", ",", ";", ".", "?."]);

  /** The words of `expressionRegionEnds` that are names but where they declare. */
  const contextualDeclaringWords = new Set(["type", "namespace", "declare"]);

  /**
   * Whether `keyword`, spelled like a declaring keyword, is written as a
   * name: read through a member access, or followed by what follows a name
   * rather than what a declaration writes next -- `{ enum: 1 }`, `{ type }`,
   * `import("m")`, `type = 1`.
   */
  const keywordSpellsName = (
    before: Syntax | undefined,
    keyword: TokenSyntax,
    after: Syntax | undefined,
  ): boolean => {
    if (before?.tag === "token" && (before.raw === "." || before.raw === "?."))
      return true;
    if (after === undefined) return true;
    // A contextual keyword declares only before what it declares, on its own
    // line: `type T`, `namespace N`, `declare const`. Anywhere else it is a
    // name, whatever operator follows it -- `type + x` adds.
    if (contextualDeclaringWords.has(keyword.raw))
      return !(
        after.tag === "token" &&
        !leadingLineBreak(after) &&
        (isIdentifierToken(after) ||
          (keyword.raw === "declare" && after.kind === "keyword"))
      );
    if (after.tag === "group")
      return after.delimiter === "parenthesis" && keyword.raw !== "function";
    if (after.tag !== "token") return false;
    if (after.raw === "=") return keyword.raw !== "export";
    return namedBefore.has(after.raw);
  };

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
   *
   * Read back from every `=` of a long statement, that was the statement once
   * for each `=` in it. So how many `<` are left open at each length of a
   * run is counted forwards once, as the run grows, each `>` closing the
   * nearest one open: that leaves a `<` open exactly where reading back finds
   * one with no `>` to spend on it.
   */
  const openAngles = new WeakMap<readonly Syntax[], number[]>();
  const typeArgumentsOpen = (
    nodes: readonly Syntax[],
    end = nodes.length,
  ): boolean => {
    let open = openAngles.get(nodes);
    if (open === undefined) {
      open = [0];
      openAngles.set(nodes, open);
    }
    for (let at = open.length; at <= end; at += 1) {
      const node = nodes[at - 1]!;
      const before = open[at - 1]!;
      open.push(
        node.tag !== "token"
          ? before
          : node.raw === ";" || node.raw === "}"
            ? 0
            : Math.max(0, before - angleWidth(node.raw, ">")) +
              angleWidth(node.raw, "<"),
      );
    }
    return open[end]! > 0;
  };

  /**
   * Whether the next node stands in a class heritage clause. What a class
   * extends is an expression -- `class E extends make()<T> {}` -- while what an
   * interface extends, or a type parameter is constrained by, is a type. All
   * three are written after `extends`, so the class is found by reading back
   * over the expression to the keyword, stopping at the `<` that would make
   * this a constraint.
   */
  const classHeritageFollows = (
    preceding: readonly Syntax[],
    end = preceding.length,
  ): boolean => {
    let at = end - 1;
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
      // No heritage, and no type argument list in one, holds a `;` or an
      // `=`: the `>` of `one > 2`, counted as closing one, read back over the
      // whole run for every parenthesis written after it.
      if (node.raw === ";" || node.raw === "=") return false;
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
  /**
   * Where in `input` one of `operators` is spelled, in order, and where the
   * segment each position of `input` begins ends: at the next group,
   * protected node, `;` or `,`. Read once for a run and the spellings asked
   * about, rather than from every position in the run up to the end of its
   * segment: a statement of fifty thousand operators read forwards from each
   * of them, though no operator macro was spelled anywhere in it.
   */
  const infixSpellingsByRun = new WeakMap<readonly Syntax[], InfixSpellings>();
  const infixSpellings = (
    input: readonly Syntax[],
    operators: CompileParsedMacrosResult["operators"],
  ) => {
    // With no infix operator in scope there is nothing to find, and a run
    // walked for none of them is not worth reading for where its segments end.
    if (operators.length === 0) return noInfixSpellings;
    const spellings = operators.map(({ spelling }) => spelling).join(" ");
    const known = infixSpellingsByRun.get(input);
    if (known?.spellings === spellings) return known;
    const positions: number[] = [];
    input.forEach((node, at) => {
      if (
        node.tag === "token" &&
        operators.some(
          (operator) =>
            operatorWidthAt(input, at, operator.spelling) !== undefined,
        )
      )
        positions.push(at);
    });
    const segmentEnds = new Array<number>(input.length + 1);
    segmentEnds[input.length] = input.length;
    for (let at = input.length - 1; at >= 0; at -= 1) {
      const node = input[at]!;
      segmentEnds[at] =
        node.tag === "group" ||
        node.tag === "protected" ||
        (node.tag === "token" && (node.raw === ";" || node.raw === ","))
          ? at
          : segmentEnds[at + 1]!;
    }
    const spelled = { spellings, positions, segmentEnds };
    infixSpellingsByRun.set(input, spelled);
    return spelled;
  };

  /** Where the first of `positions`, which ascend, after `index` stands. */
  const firstAfter = (positions: readonly number[], index: number): number => {
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (positions[middle]! <= index) low = middle + 1;
      else high = middle;
    }
    return low;
  };

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

  /** The whole of a run, which is where a declaration in it is bound. */
  const wholeRun: Extent = Object.freeze({
    from: 0,
    to: Number.POSITIVE_INFINITY,
  });

  /** Splits a binding list on the commas that separate its entries. */
  const bindingSegments = (
    sequence: readonly Syntax[],
    // Where the binders begin. A declaration's binders are what follows its
    // keyword, and reading from there rather than from a copy of the tail
    // keeps a statement list's walk linear in its length.
    from = 0,
    // Where they end: a declaration in a run of tokens ends at its `;`, and
    // what follows it is the next statement rather than more binders.
    to = sequence.length,
  ): readonly SyntaxSequence[] => {
    const segments: SyntaxSequence[] = [];
    let segment: Syntax[] = [];
    for (let at = from; at < to; at += 1) {
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

  /** Somewhere to record what is found, before anything has been. */
  const collecting = (): CollectedBindings => ({
    values: undefined,
    types: undefined,
  });
  const noNames: ReadonlyMap<string, readonly Binder[]> = new Map();
  /** A region that binds nothing, shared so the common case allocates none. */
  const noBindings: RegionBindings = Object.freeze({
    values: noNames,
    types: noNames,
  });
  const recordIn = (
    names: Map<string, Binder[]>,
    spelling: string,
    binder: Binder,
  ): void => {
    const binders = names.get(spelling);
    if (binders === undefined) names.set(spelling, [binder]);
    else binders.push(binder);
  };
  /**
   * The binder written with `scopes`, within `extent`.
   *
   * A binder `#capture` published to its call site carries the invocation's
   * introduction scope and its use-site scope together, and nothing the call
   * site writes carries either. It binds what the call site writes, so it is
   * recorded with the call site's scopes. A binder copied from the call site
   * carries the use-site scope alone, and one the template wrote the
   * introduction scope alone; neither is changed, and neither binds a name
   * the call site writes after the invocation.
   */
  const binderWith = (
    scopes: ScopeSetId,
    extent: Extent,
    ofClass: boolean,
  ): Binder => ({
    scopes: options.scopeStore.publishedTo(scopes),
    from: extent.from,
    to: extent.to,
    ofClass,
  });
  const recordValue = (
    into: CollectedBindings,
    spelling: string,
    scopes: ScopeSetId,
    extent: Extent,
  ): void =>
    recordIn(
      (into.values ??= new Map()),
      spelling,
      binderWith(scopes, extent, false),
    );
  const recordType = (
    into: CollectedBindings,
    spelling: string,
    scopes: ScopeSetId,
    extent: Extent,
    ofClass = false,
  ): void =>
    recordIn(
      (into.types ??= new Map()),
      spelling,
      binderWith(scopes, extent, ofClass),
    );
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
    for (const [spelling, binders] of from.values)
      for (const binder of binders)
        recordIn((into.values ??= new Map()), spelling, binder);
    for (const [spelling, binders] of from.types)
      for (const binder of binders)
        recordIn((into.types ??= new Map()), spelling, binder);
  };

  /**
   * What a statement or item declares into the block around it, and the
   * `var`s written anywhere in it outside a function, each read from that
   * node once.
   *
   * A region is walked for its bindings on the way in, and the region around
   * it has already walked through every node it holds: an outer region walked
   * what each nested one walked again, so a file cost its own size times the
   * depth of its nesting. Syntax is immutable, so a node's children never say
   * anything different a second time, and the answer is kept against the node
   * it was read from.
   */
  const declaredByNode = new WeakMap<Syntax, RegionBindings>();
  const hoistedFromNode = new WeakMap<Syntax, RegionBindings>();

  const extractBinders = options.extractBindings;
  const addBinders = (
    entries: readonly SyntaxSequence[],
    into: CollectedBindings,
    extent: Extent,
  ): void => {
    if (extractBinders === undefined) return;
    for (const entry of entries) {
      for (const name of extractBinders(entry))
        recordValue(into, name.spelling, name.scopes, extent);
    }
  };
  /**
   * An import binds its local name in whichever namespaces the module it
   * reads exports it in, and nothing here says which: `import { T }` is as
   * readily a type as a value. Recording only the value namespace left a
   * type macro dispatched on a name the file had imported for itself.
   */
  const importName = (
    node: Syntax | undefined,
    into: CollectedBindings,
  ): void => {
    const local = localName(node);
    if (node === undefined || local === undefined) return;
    recordValue(into, local, node.scopes, wholeRun);
    recordType(into, local, node.scopes, wholeRun);
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
    for (const segment of bindingSegments(list.children))
      importName(segment.at(-1), into);
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
      importName(nodes[from + 2], into);
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
      importName(clause, into);
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
   * Where the type parameter list whose `>` stands just before `end` in `run`
   * opens: the index of the token its `<` is written in, and whether that
   * token opens something else first. `Array<<T>(x: T) => T>` writes the
   * type arguments' `<` and the type parameters' as one `<<`. Undefined where
   * no `>` stands there, or where the list it closes never opened.
   */
  const typeParameterListOpening = (
    run: SyntaxRun,
    end: number,
  ): { readonly open: number; readonly shared: boolean } | undefined => {
    if (angles(nodeAt(run, end - 1), ">") === 0) return undefined;
    let depth = 0;
    for (let at = end - 1; at >= 0; at -= 1) {
      const node = nodeAt(run, at)!;
      depth += angles(node, ">") - angles(node, "<");
      if (depth <= 0) return { open: at, shared: depth < 0 };
    }
    return undefined;
  };

  /**
   * Where the type parameter list whose `>` stands just before `end` in `run`
   * opens, as `typeParameterListOpening` answers it.
   */
  const typeParametersOpenBefore = (
    run: SyntaxRun,
    end: number,
  ): number | undefined => typeParameterListOpening(run, end)?.open;

  /** The words that may modify a type parameter, written before its name. */
  const typeParameterModifiers = new Set(["const", "in", "out"]);

  /**
   * Records the names the type parameter list whose `<` stands at `open` in
   * `nodes` binds, within `extent`: the name each entry begins with, past the
   * modifiers that may stand in front of it. A constraint and a default are
   * types the list reads, not names it binds.
   */
  const bindTypeParameters = (
    nodes: readonly Syntax[],
    open: number,
    into: CollectedBindings,
    extent: Extent,
    ofClass = false,
  ): void => {
    // The list's own `<` is the last its opening token writes.
    let depth = 1;
    let entryBegins = true;
    for (let at = open + 1; at < nodes.length && depth > 0; at += 1) {
      const node = nodes[at]!;
      depth += angles(node, "<") - angles(node, ">");
      if (depth !== 1 || node.tag !== "token") continue;
      if (node.raw === ",") {
        entryBegins = true;
        continue;
      }
      if (!entryBegins) continue;
      const next = nodes[at + 1];
      // A modifier is followed by the parameter's name, or by another
      // modifier: `in out T`. Followed by anything else it is the name,
      // which a contextual keyword may be.
      if (
        typeParameterModifiers.has(node.raw) &&
        next?.tag === "token" &&
        isIdentifierToken(next)
      )
        continue;
      if (isIdentifierToken(node))
        recordType(into, node.raw, node.scopes, extent, ofClass);
      entryBegins = false;
    }
  };

  /**
   * Records what each `infer` written in `nodes` from `from` up to `to`, at
   * any depth, declares, within `extent`.
   *
   * An `infer` in the `extends` clause of a conditional type written inside
   * the clause belongs to that conditional, which binds it in its own true
   * branch when the walk reaches it: in `X extends (Y extends infer U ? U :
   * never) ? U : never` the second `U` is not the first's.
   */
  const bindInferred = (
    nodes: readonly Syntax[],
    into: CollectedBindings,
    extent: Extent,
    from = 0,
    to = nodes.length,
  ): void => {
    for (let at = from; at < to; at += 1) {
      const node = nodes[at]!;
      if (spelling(node) === "extends") {
        const question = conditionalCheckEnd(nodes, at + 1);
        if (question !== undefined && question < to) {
          at = question;
          continue;
        }
      }
      if (node.tag === "group" || node.tag === "protected")
        bindInferred(node.children, into, extent);
      const name = nodes[at + 1];
      if (
        spelling(node) === "infer" &&
        name?.tag === "token" &&
        isIdentifierToken(name)
      )
        recordType(into, name.raw, name.scopes, extent);
    }
  };

  /** Tokens a conditional type's `extends` clause cannot hold. */
  const extendsClauseEndsBefore = new Set([";", "=", ",", ":", "implements"]);

  /**
   * Where the type a conditional type tests against ends, when the `extends`
   * before it stands just before `from` in `nodes`: the index of the `?` the
   * conditional continues with. Undefined where the `extends` is not a
   * conditional's -- a class's or an interface's heritage, a type parameter's
   * constraint.
   */
  const conditionalCheckEnd = (
    nodes: readonly Syntax[],
    from: number,
  ): number | undefined => {
    let depth = 0;
    for (let at = from; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      depth += angles(node, "<") - angles(node, ">");
      if (depth < 0) return undefined;
      if (depth > 0 || node.tag !== "token") continue;
      if (node.raw === "?") return at;
      if (extendsClauseEndsBefore.has(node.raw)) return undefined;
    }
    return undefined;
  };

  /**
   * Where the true branch of the conditional type whose `?` stands at
   * `question` in `nodes` ends: the index of the `:` its false branch follows,
   * past the `?` and `:` of every conditional written inside it.
   */
  const trueBranchEnd = (
    nodes: readonly Syntax[],
    question: number,
  ): number => {
    let depth = 0;
    let open = 1;
    for (let at = question + 1; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      depth += angles(node, "<") - angles(node, ">");
      if (depth !== 0) continue;
      if (spelling(node) === "?") open += 1;
      else if (spelling(node) === ":") {
        open -= 1;
        if (open === 0) return at;
      }
    }
    return nodes.length;
  };

  /** Ends a member of a type literal or an interface, or a class member. */
  const memberEnds: ReadonlySet<string> = new Set([";", ","]);

  /**
   * The index just past the first of `ends` written at or after `from` in
   * `nodes` outside a type argument list, or the length of the run where
   * none is.
   */
  const endingAt = (
    nodes: readonly Syntax[],
    from: number,
    ends: ReadonlySet<string>,
  ): number => {
    let depth = 0;
    for (let at = from; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      depth += angles(node, "<") - angles(node, ">");
      if (depth === 0 && node.tag === "token" && ends.has(node.raw))
        return at + 1;
    }
    return nodes.length;
  };

  /**
   * Whether a statement written as tokens in `nodes` ends in front of the
   * node at `at` by automatic semicolon insertion: a line break stands before
   * it, what stands before the break ends an operand, and the node does not
   * carry that operand's expression on. `const k = 1` ends at the line break
   * in front of a `function` written under it.
   */
  const statementEndsBefore = (nodes: readonly Syntax[], at: number): boolean =>
    leadingLineBreak(nodes[at]) &&
    endsOperand(nodes, at, true) &&
    !continuesExpression(nodes[at]);

  /**
   * The index just past the statement written as tokens from `from` in
   * `nodes`: past its `;`, or at the line break automatic semicolon insertion
   * ends it at; the length of the run where it runs to the end.
   *
   * No angle is counted. A type argument list holds no `;` outside the braces
   * of an object type, and a line break inside one stands after a `<` or a
   * `,`, or before a `>`, none of which lets a statement end there. Counted,
   * the `>` of `one > 2` left the count below zero for the rest of the run:
   * the statement never ended, every `,` after it separated declarators, and
   * the macros written after it were read as names being declared.
   */
  const statementEnd = (nodes: readonly Syntax[], from: number): number => {
    for (let at = from; at < nodes.length; at += 1) {
      if (at > from && statementEndsBefore(nodes, at)) return at;
      if (spelling(nodes[at]) === ";") return at + 1;
    }
    return nodes.length;
  };

  /**
   * The index just past the type alias whose `type` stands at `at` in
   * `nodes`: past its `;`, or where a line break ends its type, which the
   * type tracker every reader of a type asks decides. Read only to its `;`,
   * an alias written without one bound its type parameters on into the
   * statements under it.
   */
  const typeAliasEnd = (nodes: readonly Syntax[], at: number): number => {
    let depth = 0;
    let equals = at + 1;
    for (; equals < nodes.length; equals += 1) {
      const node = nodes[equals]!;
      depth += angles(node, "<") - angles(node, ">");
      if (depth !== 0) continue;
      if (spelling(node) === "=") break;
      if (spelling(node) === ";") return equals + 1;
    }
    const type = createTypeTracker(nodes[equals], false);
    for (let after = equals + 1; after < nodes.length; after += 1) {
      const node = nodes[after]!;
      if (!type.nested() && spelling(node) === ";") return after + 1;
      if (leadingLineBreak(node) && !type.continuesAcross(node)) return after;
      type.take(node);
    }
    return nodes.length;
  };

  /** Whether a `#` stands just before `at`: `# let`, a `#let` written apart. */
  const afterHash = (nodes: readonly Syntax[], at: number): boolean =>
    nodes[at - 1]?.tag === "token" &&
    (nodes[at - 1] as TokenSyntax).raw === "#";

  /** Whether the parenthesis group at `at` in `nodes` is a `for` header. */
  const loopHeaderAt = (nodes: readonly Syntax[], at: number): boolean =>
    spelling(nodes[at - 1]) === "for" ||
    (spelling(nodes[at - 1]) === "await" && spelling(nodes[at - 2]) === "for");

  /**
   * Whether the statement at `at` in `nodes` is the body of a statement that
   * heads it -- written after an `if`, `while`, `for` or `with` header, an
   * `else` or a `do` -- rather than one of the statements of the block or
   * module around it. Such a body is a scope of its own: nothing after it
   * sees what it declares, but for its `var`s.
   */
  const substatementAt = (nodes: readonly Syntax[], at: number): boolean => {
    const previous = nodes[at - 1];
    if (previous?.tag === "token")
      return previous.raw === "else" || previous.raw === "do";
    if (previous?.tag !== "group" || previous.delimiter !== "parenthesis")
      return false;
    const keyword = spelling(nodes[at - 2]);
    return (
      keyword === "if" ||
      keyword === "while" ||
      keyword === "with" ||
      loopHeaderAt(nodes, at - 1)
    );
  };

  /**
   * Where the loop whose header stands at `header` in `nodes` ends: past its
   * body, which is one node where it is a block or was read as a statement,
   * and runs to its `;` where it is tokens.
   */
  const loopEnd = (nodes: readonly Syntax[], header: number): number => {
    const body = nodes[header + 1];
    if (body === undefined) return nodes.length;
    return body.tag === "token" ? statementEnd(nodes, header + 1) : header + 2;
  };

  /**
   * Whether the brace at `at` in `nodes`, or the statement holding only one,
   * is a block a statement opens: not a function's body, a class's, a
   * namespace's or a static block. A `var` written in one belongs to the
   * function around it, as a `let` does not.
   */
  const statementBlockAt = (
    nodes: readonly Syntax[],
    run: SyntaxRun,
    at: number,
  ): boolean => braceBody(nodes[at]!) && braceHeader(run, at) === otherBrace;

  /**
   * Records the binders of the declaration list written from `from` in
   * `nodes`, within `extent`. The list ends at its `;`.
   */
  const bindDeclarationList = (
    nodes: readonly Syntax[],
    from: number,
    into: CollectedBindings,
    extent: Extent,
  ): void =>
    addBinders(
      bindingSegments(nodes, from, statementEnd(nodes, from)),
      into,
      extent,
    );

  /**
   * Where the name of the declaration whose keyword stands at `at` in `nodes`
   * stands: just after the keyword, or after the `*` of a `function*`.
   */
  const declaredNameAt = (nodes: readonly Syntax[], at: number): number =>
    spelling(nodes[at]) === "function" && spelling(nodes[at + 1]) === "*"
      ? at + 2
      : at + 1;

  /** Words a declared `function` or `class` may be written after. */
  const declarationModifiers = new Set(["async", "declare", "abstract"]);

  /**
   * Whether the `function` or `class` at `at` in `nodes`, a run of
   * statements, declares its name in the block it is written in, rather than
   * being an expression whose name is bound inside it alone. A declaration
   * stands where a statement begins, past its modifiers and an `export` or
   * `export default`.
   *
   * The reader says where a statement begins: a run it read is made of the
   * statements themselves, and one of them begins with its first node. The
   * runs it leaves as tokens -- a block holding a statement operator, which
   * must reach the operator unread, and syntax it cannot read at all -- have
   * only what was read in them, the terminators written in them, and the line
   * breaks automatic semicolon insertion ends a statement at to say.
   */
  const declaresAt = (nodes: readonly Syntax[], at: number): boolean => {
    let before = at - 1;
    while (declarationModifiers.has(spelling(nodes[before]) ?? "")) before -= 1;
    const previous = nodes[before];
    if (previous === undefined) return true;
    if (statementEndsBefore(nodes, before + 1)) return true;
    if (previous.tag === "protected")
      return previous.category === "stmt" || previous.category === "item";
    if (previous.tag === "group") return previous.delimiter === "brace";
    return (
      previous.tag === "token" &&
      (previous.raw === ";" ||
        previous.raw === "export" ||
        previous.raw === "default")
    );
  };

  /**
   * Where the declaration whose keyword stands at `at` in `nodes` ends: a type
   * alias at its `;`, a function past its body or at the `;` of a signature,
   * and a class, an interface, an enum or a namespace past its body.
   */
  const declarationEnd = (nodes: readonly Syntax[], at: number): number => {
    const keyword = spelling(nodes[at]);
    if (keyword === "type") return typeAliasEnd(nodes, at);
    let depth = 0;
    for (let scan = at + 1; scan < nodes.length; scan += 1) {
      const node = nodes[scan]!;
      depth += angles(node, "<") - angles(node, ">");
      if (depth !== 0) continue;
      if (keyword === "function") {
        if (node.tag === "group" && node.delimiter === "parenthesis")
          return parameterScopeEnd(nodes, scan) ?? statementEnd(nodes, scan);
      } else if (braceBody(node)) return scan + 1;
      if (spelling(node) === ";") return scan + 1;
    }
    return nodes.length;
  };

  /**
   * Records each `var` written in `nodes` outside a function: in a block, in
   * a statement, in a `for` header. Each is bound in the whole function.
   */
  const hoistVars = (
    nodes: readonly Syntax[],
    into: CollectedBindings,
  ): void => {
    const run = runOf(nodes);
    for (let at = 0; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      if (node.tag === "protected") {
        if (
          (node.category === "stmt" || node.category === "item") &&
          (!braceBody(node) || statementBlockAt(nodes, run, at))
        )
          addBindings(hoistedFrom(node), into);
        continue;
      }
      if (node.tag === "group") {
        if (
          (node.delimiter === "brace" && statementBlockAt(nodes, run, at)) ||
          (node.delimiter === "parenthesis" && loopHeaderAt(nodes, at))
        )
          hoistVars(node.children, into);
        continue;
      }
      if (node.tag === "token" && node.raw === "var" && !afterHash(nodes, at))
        bindDeclarationList(nodes, at + 1, into, wholeRun);
    }
  };

  /** The `var`s a statement or item holds outside a function, read once. */
  const hoistedFrom = (node: ProtectedSyntax): RegionBindings => {
    const read = hoistedFromNode.get(node);
    if (read !== undefined) return read;
    const into = collecting();
    hoistVars(node.children, into);
    const bindings = bindingsOf(into);
    hoistedFromNode.set(node, bindings);
    return bindings;
  };

  /**
   * What a statement or item binds in the block around it, read once: what
   * it declares, and the `var`s it holds. A statement node is not a region of
   * its own, so what it declares belongs to the list it stands in; what its
   * parameters, its loop header and its blocks bind belongs to the regions
   * they open, and is recorded when the walk reaches them.
   */
  const declaredBy = (node: ProtectedSyntax): RegionBindings => {
    const read = declaredByNode.get(node);
    if (read !== undefined) return read;
    const into = collecting();
    const nodes = node.children;
    const run = runOf(nodes);
    for (let at = 0; at < nodes.length; at += 1) {
      const child = nodes[at]!;
      if (child.tag === "protected") {
        if (
          (child.category === "stmt" || child.category === "item") &&
          (!braceBody(child) || statementBlockAt(nodes, run, at))
        )
          addBindings(
            substatementAt(nodes, at) ? hoistedFrom(child) : declaredBy(child),
            into,
          );
        continue;
      }
      if (child.tag === "group") {
        if (
          (child.delimiter === "brace" && statementBlockAt(nodes, run, at)) ||
          (child.delimiter === "parenthesis" && loopHeaderAt(nodes, at))
        )
          hoistVars(child.children, into);
        continue;
      }
      if (child.tag !== "token") continue;
      at = declaration(nodes, at, into) ?? at;
    }
    const bindings = bindingsOf(into);
    declaredByNode.set(node, bindings);
    return bindings;
  };

  /**
   * Records what the token at `at` in `nodes` declares in the block it is
   * written in, when it begins a declaration: an import, a `let`, `const`,
   * `var` or `using`, or a declared function, class, enum, interface, type or
   * namespace. Answers the index of the last node an import took, for the
   * caller to read on past it.
   */
  const declaration = (
    nodes: readonly Syntax[],
    at: number,
    into: CollectedBindings,
  ): number | undefined => {
    const node = nodes[at] as TokenSyntax;
    // An import declaration is read as a whole, before `using` is read as
    // the declaration keyword it is everywhere else.
    if (node.raw === "import") return readImportDeclaration(nodes, at, into);
    // `# let (name = value) { body }` names the variable of a `#let`, which
    // the expansion declares itself where the body needs one.
    if (valueDeclarationKeywords.has(node.raw) && !afterHash(nodes, at)) {
      // A body a statement heads declares only its `var`s around it.
      if (node.raw === "var" || !substatementAt(nodes, at))
        bindDeclarationList(nodes, at + 1, into, wholeRun);
      return undefined;
    }
    if (substatementAt(nodes, at)) return undefined;
    const named = namedDeclarations.get(node.raw);
    const name = nodes[declaredNameAt(nodes, at)];
    if (
      named !== undefined &&
      name?.tag === "token" &&
      isIdentifierToken(name) &&
      ((node.raw !== "function" && node.raw !== "class") ||
        declaresAt(nodes, at))
    ) {
      if (named !== "type") recordValue(into, name.raw, name.scopes, wholeRun);
      if (named !== "value") recordType(into, name.raw, name.scopes, wholeRun);
    }
    return undefined;
  };

  /**
   * Whether a member of a type literal or an interface begins at `at` in
   * `nodes`, a run of them: at the start of the run, after a member's `;` or
   * `,` or a member the reader read, or on a line of its own.
   */
  const typeMemberBeginsAt = (
    nodes: readonly Syntax[],
    at: number,
  ): boolean => {
    const previous = nodes[at - 1];
    if (previous === undefined) return true;
    if (previous.tag === "token" && memberEnds.has(previous.raw)) return true;
    if (previous.tag === "protected" && previous.category === "typeMember")
      return true;
    return leadingLineBreak(nodes[at]);
  };

  /**
   * Whether the type parameter list whose `<` stands at `open` in `nodes`, a
   * run of types or type members, is a signature's: a call signature's,
   * written where a member begins; a construct signature's, after `new`; or
   * a method signature's, after a name that begins a member and the `?` that
   * may follow it. Written after any other name it is that name's type
   * arguments: `a: Array<T>` with a call signature on the line under it.
   */
  const signatureTypeParametersAt = (
    nodes: readonly Syntax[],
    open: number,
  ): boolean => {
    if (typeMemberBeginsAt(nodes, open)) return true;
    let name = open - 1;
    if (spelling(nodes[name]) === "new") return true;
    if (spelling(nodes[name]) === "?") name -= 1;
    const named = nodes[name];
    const isName =
      named?.tag === "token"
        ? isPropertyNameToken(named)
        : named?.tag === "group" && named.delimiter === "bracket";
    return isName && typeMemberBeginsAt(nodes, name);
  };

  /**
   * What the run `nodes`, walked as `category`, binds, each name within the
   * stretch of the run its scope covers.
   *
   * A statement list's entries arrive protected, so the declarations in them
   * are one level down, and each is bound in the whole run. A brace is never
   * entered: what it binds belongs to the region it opens, not to this one,
   * but for the `var`s in a block. Parameters are bound from their list to
   * the end of their function, and a `catch` binding and a loop's from their
   * header to the end of what it heads; a function or class expression's
   * name within that expression.
   *
   * A type parameter binds in the type namespace, for the declaration, the
   * function or the signature it is written in, and `infer` and a mapped
   * type's key do the same for the type they are written in. Read as
   * references, `type List<T> = T[]` had both its `T`s dispatched to a type
   * macro of that spelling.
   */
  /**
   * An enum's members are in scope in its body: `enum E { x = 1, y = x * 2 }`
   * reads `E.x` in the second initializer. Each member's name is bound in the
   * body, at `body`, so a macro spelled like one is not dispatched there.
   */
  /**
   * The name an enum member written as `run` declares: a name, a string
   * spelling one -- `'K' = 1` -- or such a string computed, `['K'] = 1`. A
   * string that spells no name declares nothing a bare name reads.
   */
  const enumMemberName = (
    run: readonly Syntax[],
  ): { readonly name: string; readonly scopes: ScopeSetId } | undefined => {
    let key = run[0];
    if (
      key?.tag === "group" &&
      key.delimiter === "bracket" &&
      key.children.length === 1
    )
      key = key.children[0];
    if (key?.tag !== "token") return undefined;
    if (isIdentifierToken(key)) return { name: key.raw, scopes: key.scopes };
    const quoted = enumStringName.exec(key.raw);
    return quoted === null
      ? undefined
      : { name: quoted[2]!, scopes: key.scopes };
  };
  /**
   * An enum declared in a run: where it stands among the run's nodes, which
   * is what a binding's extent counts, and the body that lists its members.
   */
  interface EnumDeclaration {
    readonly at: number;
    readonly body: GroupSyntax;
    /**
     * Whether it is written as tokens of the run, rather than an item read
     * whole: one read whole binds its own members over its body, as the
     * walk inside it collects them.
     */
    readonly asTokens: boolean;
  }
  /**
   * The enum `children` declare from `start` on -- `enum E { ... }`, after
   * whatever modifiers -- by its name, or undefined where none is declared
   * there.
   */
  const enumDeclaredIn = (
    children: readonly Syntax[],
    start: number,
  ): { readonly name: string; readonly body: GroupSyntax } | undefined => {
    if (spelling(children[start]) !== "enum") return undefined;
    if (spelling(children[start - 1]) === ".") return undefined;
    const name = children[start + 1];
    const body = children[start + 2];
    return name?.tag === "token" &&
      isIdentifierToken(name) &&
      body?.tag === "group" &&
      body.delimiter === "brace"
      ? { name: name.raw, body }
      : undefined;
  };
  /**
   * Every enum the run `nodes` declares, by name: one written as tokens, or
   * an item or a statement read whole. Read once for the run.
   */
  const enumsIn = (
    nodes: readonly Syntax[],
  ): ReadonlyMap<string, readonly EnumDeclaration[]> => {
    const enums = new Map<string, EnumDeclaration[]>();
    const add = (name: string, declaration: EnumDeclaration): void => {
      const list = enums.get(name);
      if (list === undefined) enums.set(name, [declaration]);
      else list.push(declaration);
    };
    for (let at = 0; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      if (node.tag === "protected") {
        if (node.category !== "item" && node.category !== "stmt") continue;
        const keyword = node.children.findIndex(
          (child) => spelling(child) === "enum",
        );
        const declared =
          keyword < 0 ? undefined : enumDeclaredIn(node.children, keyword);
        if (declared !== undefined)
          add(declared.name, { at, body: declared.body, asTokens: false });
        continue;
      }
      const declared = enumDeclaredIn(nodes, at);
      if (declared !== undefined)
        add(declared.name, { at: at + 2, body: declared.body, asTokens: true });
    }
    return enums;
  };
  /**
   * Binds the members each declaration of one enum lists over every one of
   * them: a member is a bare name in each declaration an enum is merged from,
   * `enum E { K = 1 }` and the `enum E { B = K }` after it.
   */
  const bindEnumMembers = (
    declarations: readonly EnumDeclaration[],
    into: CollectedBindings,
  ): void => {
    for (const { body } of declarations)
      for (const { run } of commaSeparatedMembers(body.children, false)) {
        const member = enumMemberName(run);
        if (member === undefined) continue;
        for (const { at } of declarations)
          recordValue(into, member.name, member.scopes, {
            from: at,
            to: at + 1,
          });
      }
  };
  const collectRegion = (
    nodes: readonly Syntax[],
    into: CollectedBindings,
    category: SyntaxCategory,
    // Whether `nodes` is a run of statements or items, which is where a
    // declaration can stand. The inside of an argument list or an array
    // literal is walked in the category of the statement around it, and
    // its first node is an expression all the same: read as the start of a
    // statement, `[function twice() {}, twice(2)]` bound the function's name
    // across the whole array.
    statements: boolean,
    // Whether `nodes` is a member list or one member, where a method may be
    // named like a control statement's keyword (`SyntaxRun.members`).
    memberList = false,
  ): void => {
    const run = runOf(nodes);
    // A run of types or of type members applies type arguments to nothing
    // written in parentheses, so a `<…>` in front of a parenthesis group there
    // is the type parameter list of a signature or a function type.
    const typesRun = category === "type" || category === "typeMember";
    // An enum's members are bare names in its body, and in the body of every
    // declaration it is merged from.
    for (const declarations of enumsIn(nodes).values())
      if (declarations.length > 1 || declarations[0]!.asTokens)
        bindEnumMembers(declarations, into);
    // Where the class member being read begins, in a run of class members. A
    // method declared without a body -- an overload, an abstract method --
    // has no body to say the parenthesis group after its name is its
    // parameter list, and its name is all that says so.
    let memberStart = 0;
    // The member being read, read a node at a time, and whether its name
    // could stand at each of its nodes. Asked again of the whole member at
    // every node, a long initializer cost the square of its length.
    const members =
      category === "classElement" ? createClassMemberWalk() : undefined;
    let nameCouldStand: boolean[] = [];
    for (let at = 0; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      if (members !== undefined) {
        if (members.endsBefore(node)) {
          memberStart = at;
          members.restart();
          nameCouldStand = [];
        }
        nameCouldStand.push(members.nameFollows());
        members.take(node);
      }
      if (node.tag === "protected") {
        if (
          (node.category === "stmt" || node.category === "item") &&
          (!braceBody(node) || statementBlockAt(nodes, run, at))
        )
          addBindings(
            substatementAt(nodes, at) ? hoistedFrom(node) : declaredBy(node),
            into,
          );
        continue;
      }
      if (node.tag === "group") {
        // `[K in keyof T]` heads a mapped type, and binds `K` in the type
        // it maps to.
        const mappedKey = node.children[0];
        if (
          category === "typeMember" &&
          node.delimiter === "bracket" &&
          mappedKey?.tag === "token" &&
          isIdentifierToken(mappedKey) &&
          spelling(node.children[1]) === "in"
        )
          recordType(into, mappedKey.raw, mappedKey.scopes, {
            from: at,
            to: wholeRun.to,
          });
        if (node.delimiter === "brace") {
          if (statementBlockAt(nodes, run, at)) hoistVars(node.children, into);
          continue;
        }
        if (node.delimiter !== "parenthesis") continue;
        // `#parameterize(name = replacement) { body }` has the shape of a
        // parameter list and a body, but names a syntax parameter rather
        // than binding anything. Read as parameters, it shadowed the very
        // macro it was parameterizing.
        const previous = nodes[at - 1];
        if (
          previous?.tag === "token" &&
          (previous.raw === "#parameterize" ||
            previous.raw === "#let" ||
            ((previous.raw === "parameterize" || previous.raw === "let") &&
              afterHash(nodes, at - 1)))
        )
          continue;
        // A member named `for` writes a parameter list where a loop writes
        // its header: `{ for(x: number) { return x; } }`.
        if (!memberList && loopHeaderAt(nodes, at)) {
          const header = node.children;
          const loop = { from: at, to: loopEnd(nodes, at) };
          for (let entry = 0; entry < header.length; entry += 1) {
            const keyword = spelling(header[entry]);
            if (keyword === "let" || keyword === "const" || keyword === "using")
              bindDeclarationList(header, entry + 1, into, loop);
          }
          hoistVars(header, into);
          continue;
        }
        const end = parameterScopeEnd(nodes, at, statements, memberList);
        const open = typeParametersOpenBefore(run, at);
        if (end !== undefined) {
          // A parameter's binder stands after the modifiers of a parameter
          // property and after the `...` of a rest parameter, so what a
          // parameter list binds is read from the binder rather than from
          // the whole parameter.
          addBinders(
            bindingSegments(node.children).map((segment) =>
              createSyntaxSequence(parameterBinder(segment)),
            ),
            into,
            { from: at, to: end },
          );
          if (open !== undefined)
            bindTypeParameters(nodes, open, into, { from: open, to: end });
        } else if (
          open !== undefined &&
          ((typesRun && signatureTypeParametersAt(nodes, open)) ||
            (category === "classElement" &&
              open > memberStart &&
              nameCouldStand[open - 1 - memberStart] === true))
        )
          bindTypeParameters(nodes, open, into, {
            from: open,
            to: endingAt(nodes, at, memberEnds),
          });
        continue;
      }
      if (node.tag !== "token") continue;
      const imported = statements ? declaration(nodes, at, into) : undefined;
      if (imported !== undefined) {
        at = imported;
        continue;
      }
      const named = namedDeclarations.get(node.raw);
      const expression = node.raw === "function" || node.raw === "class";
      if (named !== undefined && (statements || expression)) {
        const nameAt = declaredNameAt(nodes, at);
        const name = nodes[nameAt];
        const declared = statements && (!expression || declaresAt(nodes, at));
        const extent: Extent = declared
          ? { from: at, to: declarationEnd(nodes, at) }
          : { from: at, to: closureEndAt(nodes, at)?.end ?? nodes.length };
        if (name?.tag === "token" && isIdentifierToken(name)) {
          // A function or class expression's name is bound inside it alone.
          if (!declared) {
            if (named !== "type")
              recordValue(into, name.raw, name.scopes, extent);
            if (named !== "value")
              recordType(into, name.raw, name.scopes, extent);
          }
          if (spelling(nodes[nameAt + 1]) === "<")
            bindTypeParameters(
              nodes,
              nameAt + 1,
              into,
              { from: nameAt + 1, to: extent.to },
              node.raw === "class",
            );
        } else if (node.raw === "class" && spelling(name) === "<")
          // A class expression may go unnamed and still declare type
          // parameters.
          bindTypeParameters(
            nodes,
            at + 1,
            into,
            { from: at + 1, to: extent.to },
            true,
          );
        continue;
      }
      // `infer U` declares `U` for the conditional type whose `extends`
      // clause it is written in, however deeply the clause nests it: in that
      // clause, where it is declared and may be read again, and in the true
      // branch. The false branch is outside it.
      if (node.raw === "extends") {
        const question = conditionalCheckEnd(nodes, at + 1);
        if (question !== undefined)
          bindInferred(
            nodes,
            into,
            { from: at, to: trueBranchEnd(nodes, question) },
            at + 1,
            question,
          );
        continue;
      }
      // An arrow's single parameter is written without parentheses, and is
      // bound to the end of the arrow's body.
      const following = nodes[at + 1];
      if (
        isIdentifierToken(node) &&
        following?.tag === "token" &&
        following.raw === "=>"
      )
        recordValue(into, node.raw, node.scopes, {
          from: at,
          to: arrowBodyEnd(nodes, at + 2).end,
        });
    }
  };

  /**
   * What the run `sequence`, walked as `category`, binds; `statements` says
   * whether it is a run of statements or items.
   */
  const regionBindings = (
    sequence: SyntaxSequence,
    category: SyntaxCategory,
    statements: boolean,
    members = false,
  ): CollectedBindings => {
    const into = collecting();
    if (extractBinders !== undefined)
      collectRegion(sequence, into, category, statements, members);
    return into;
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
   * Tokens after which a function type, written as an arrow is, begins, and
   * an arrow expression cannot: after `new` it is a constructor type, `new
   * <T>(x: T) => T`; after a type argument list's `<` one of its types,
   * `Array<(x: T) => T>`; and after `extends`, `as`, `satisfies`, `|` or `&`
   * the type they read.
   */
  const functionTypeHeads = new Set([
    "new",
    "<",
    "<<",
    "extends",
    "as",
    "satisfies",
    "|",
    "&",
  ]);

  /**
   * Where the syntax before an arrow's head ends, when the head ends at `end`
   * in `run`: `async` and a type parameter list are read past. Undefined where
   * a type parameter list does not close.
   */
  const arrowHeadBefore = (run: SyntaxRun, end: number): number | undefined => {
    let at = end - 1;
    if (angles(nodeAt(run, at), ">") > 0) {
      const opening = typeParameterListOpening(run, end);
      if (opening === undefined) return undefined;
      // A `<<` holds the `<` before the list as well as the list's own, and
      // nothing but that `<` stands between the two.
      if (opening.shared) return opening.open;
      at = opening.open - 1;
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
      previous.tag === "token" &&
      (assignmentExpressionHeads.has(previous.raw) ||
        functionTypeHeads.has(previous.raw))
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
   * Where the scope of what the parenthesis group at `at` in `nodes` binds
   * ends, when it holds names being bound rather than an expression: past
   * the function a parameter list belongs to, or past the block of the
   * `catch` it is written after. Undefined for any other group.
   */
  const parameterScopeEnd = (
    nodes: readonly Syntax[],
    at: number,
    /** Whether `nodes` is a run of statements, where no method stands. */
    statements = false,
    /** Whether `nodes` is a member list or a member, where no statement does. */
    members = false,
  ): number | undefined => {
    const node = nodes[at];
    if (node?.tag !== "group" || node.delimiter !== "parenthesis")
      return undefined;
    const previous = nodes[at - 1];
    if (catchBinderFollows(previous)) return Math.min(at + 2, nodes.length);
    // A control-flow header is not a parameter list, though it is followed by a
    // body like one. What a `for` binds is written with a keyword inside it, so
    // it is found by reading the header rather than by reading its entries.
    if (
      !members &&
      previous?.tag === "token" &&
      ["for", "while", "if", "switch", "with"].includes(previous.raw)
    )
      return undefined;
    // Read as parameters, a call's arguments -- a heritage clause's among
    // them -- or a conditional's consequent would bind whatever names they
    // held, shadowing a macro written there. A return type may stand between
    // the parameters and the body, so the whole header is read rather than
    // only what comes next. A body already enforested arrives protected rather
    // than as the brace it was read from, which `parametersFunction` reads
    // through.
    const fn = parametersFunction(
      node,
      { ...runOf(nodes), statements, members },
      at,
    );
    if (fn === undefined) return undefined;
    return "arrow" in fn ? arrowBodyEnd(nodes, fn.arrow + 1).end : fn.body + 1;
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

  /**
   * The stretches of the class body `nodes` its static members take. A body
   * read as members is made of them, and one walked as tokens is split where
   * the member reader would split it.
   */
  const staticMembers = (nodes: readonly Syntax[]): readonly Extent[] => {
    const statics: Extent[] = [];
    const member = createClassMemberWalk();
    let start = 0;
    const end = (at: number): void => {
      if (member.nodes.length > 0 && staticClassMember(member.nodes))
        statics.push({ from: start, to: at });
      member.restart();
      start = at;
    };
    for (let at = 0; at < nodes.length; at += 1) {
      const node = nodes[at]!;
      if (node.tag === "protected" && node.category === "classElement") {
        end(at);
        if (staticClassMember(node.children))
          statics.push({ from: at, to: at + 1 });
        start = at + 1;
        continue;
      }
      if (member.endsBefore(node)) end(at);
      member.take(node);
    }
    end(nodes.length);
    return statics;
  };

  /**
   * Whether the walk stands in a static member of the class whose type
   * parameters the region at `depth` binds: of the first class body inside
   * that region, which is the class's own. A run or two may stand between
   * the two, where the reader wrapped the body as it read the class.
   */
  const inStaticMember = (depth: number): boolean => {
    const body = regions
      .slice(depth + 1)
      .find(({ statics }) => statics !== undefined);
    return (
      body?.statics?.some(({ from, to }) => from <= body.at && body.at < to) ===
      true
    );
  };

  /**
   * What a macro's binding contracts declare in `following`: each binding
   * whose region is the syntax after the invocation, in the namespace its
   * space is, with the scopes the contract gave it. The name the macro
   * emits for it carries the invocation's use-site scope as well, which no
   * syntax following the invocation does, so it is the contract's binding
   * that says whom the name binds: the spec's binding contract adds its
   * scope to the binder and to the region, and nothing else.
   */
  const contractBindings = (bindings: readonly Binding[]): RegionBindings => {
    const into = collecting();
    for (const binding of bindings) {
      if (binding.space === "value" || binding.space === "namespace")
        recordValue(into, binding.spelling, binding.scopes, wholeRun);
      if (binding.space === "type" || binding.space === "namespace")
        recordType(into, binding.spelling, binding.scopes, wholeRun);
    }
    return bindingsOf(into);
  };

  /**
   * Declares in `region`, from `from` to the end of its run, what an
   * expansion wrote there: `declared`, with `hoisted` the `var`s among it.
   * The region's own record grows by what is declared, so a run that
   * declares a name per statement costs its length rather than its square.
   */
  const declareInRun = (
    region: Region,
    declared: RegionBindings,
    hoisted: RegionBindings,
    from: number,
  ): void => {
    const extent: Extent = { from, to: wholeRun.to };
    for (const [spelling, binders] of declared.values)
      for (const binder of binders) {
        recordValue(region.bindings, spelling, binder.scopes, extent);
        recordIn((region.declared.values ??= new Map()), spelling, binder);
      }
    for (const [spelling, binders] of declared.types)
      for (const binder of binders) {
        recordType(region.bindings, spelling, binder.scopes, extent);
        recordIn((region.declared.types ??= new Map()), spelling, binder);
      }
    addBindings(hoisted, region.hoisted);
  };

  /** Regions enclosing the position being walked, outermost first. */
  const regions: Region[] = [];

  /**
   * The macro whose expansion hit a bound, once one has. Expansion stops
   * dispatching after that: the bound is global, so every later invocation
   * would reach it again and report the same thing.
   */

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

  /**
   * Whether the `<` at `at` among the members of an object literal opens
   * angle brackets -- type parameters or type arguments, whose commas do not
   * end the member -- rather than comparing. `member` is what of the member
   * stands before it.
   *
   * Only an expression compares, so in a method's head, which is a signature,
   * every `<` opens. In a value one opens where an operand begins, which makes
   * it a generic arrow's type parameters. After an operand it is TypeScript's
   * question for an instantiation, and the same rule answers it: once the
   * angles close, a call or a tagged template, or something that cannot go on
   * as a comparison's operand, says they held type arguments --
   * `make<A, B>()`, the return type in `(x): Map<K, V> => x`, the type after
   * `as`. Anything else is a comparison: `{ low: a < b, high: c > d }`.
   */
  const anglesOpen = (
    members: readonly Syntax[],
    at: number,
    member: readonly Syntax[],
    signature: boolean,
  ): boolean => {
    if (signature || !endsOperand(member, member.length, true)) return true;
    let depth = 0;
    for (let ahead = at; ahead < members.length; ahead += 1) {
      const node = members[ahead]!;
      if (node.tag !== "token") continue;
      depth += angles(node, "<") - angles(node, ">");
      if (depth > 0) continue;
      const following = members[ahead + 1];
      return (
        callFollowsTypeArguments(following) || typeArgumentsFollow(following)
      );
    }
    return false;
  };

  /** Whether an object literal's member is a shorthand property: `{ x }`. */
  const shorthandProperty = (
    member: readonly Syntax[],
  ): member is readonly [TokenSyntax] =>
    member.length === 1 &&
    member[0]!.tag === "token" &&
    isIdentifierToken(member[0]!);

  /**
   * Whether the brace at `at` in `nodes` is the pattern of an assignment or
   * of a `for` loop's head rather than an object literal: `({ x } = o)`,
   * `for ({ x } of xs)`. Its names are the targets the values are written to.
   */
  const assignmentPatternAt = (
    nodes: readonly Syntax[],
    at: number,
  ): boolean => {
    const next = nodes[at + 1];
    return (
      next?.tag === "token" &&
      (next.raw === "=" || next.raw === "of" || next.raw === "in")
    );
  };

  /**
   * The members of an object literal or an enum body, each with the `,` that
   * ends it. Type parameters and type arguments hold commas of their own --
   * `*run(): Generator<number, void, unknown> {`,
   * `<T, U>(a: T, b: U) => [a, b]`, `A = make<number, string>(x)` -- which
   * do not end the member.
   *
   * `methods` says whether a member may be a method, whose head is a
   * signature, read up to its body, where every `<` opens angles. An enum
   * member is a name and a value and never one.
   */
  const commaSeparatedMembers = (
    children: readonly Syntax[],
    methods: boolean,
  ): {
    readonly run: readonly Syntax[];
    readonly separator: Syntax | undefined;
  }[] => {
    const members: {
      readonly run: readonly Syntax[];
      readonly separator: Syntax | undefined;
    }[] = [];
    let member: Syntax[] = [];
    let methodHead = methods;
    let typeArguments = 0;
    for (let at = 0; at < children.length; at += 1) {
      const child = children[at]!;
      if (child.tag === "token" && child.raw === "," && typeArguments === 0) {
        members.push({ run: member, separator: child });
        member = [];
        methodHead = methods;
        continue;
      }
      const previous = member.at(-1);
      const opensAngles =
        typeArguments > 0 ||
        (child.tag === "token" &&
          child.raw === "<" &&
          anglesOpen(children, at, member, methodHead));
      member.push(child);
      if (opensAngles)
        typeArguments = Math.max(
          0,
          typeArguments + angles(child, "<") - angles(child, ">"),
        );
      if (!methodHead) continue;
      if (child.tag !== "token") {
        if (child.tag === "group" && child.delimiter === "brace") {
          methodHead = false;
          typeArguments = 0;
        }
        continue;
      }
      if (
        typeArguments === 0 &&
        ((child.raw === "..." && previous === undefined) ||
          (child.raw === ":" &&
            !(
              previous?.tag === "group" && previous.delimiter === "parenthesis"
            )))
      )
        methodHead = false;
    }
    members.push({ run: member, separator: undefined });
    return members;
  };

  /**
   * Whether syntax carrying `scopes` stands in `region` as the walk found it
   * there, written in it or copied from what was, rather than written by a
   * template at an invocation made inside it.
   *
   * This is the region's own scope, read where it would be. Hygiene gives
   * each binding form a scope of its own, on its binders and on everything
   * in its body, and a template does not get it: the template was written
   * where its macro was defined, at the top of a module, never inside the
   * function or the block. Without it a binder written in a function body
   * carried only its module's scope, as a template its module defines does
   * too, so a parameter named `twice` captured the `twice` such a template
   * wrote. A macro imported from another module was spared only because its
   * template carries that module's scope instead. The one macro defined
   * inside a region is one a `#syntax` generates there, and its template is
   * given the region's scope itself (`definedWithin`).
   *
   * The module the walk began with is where every macro it can reach was
   * defined, and its scope is the one every token written in it already
   * carries, so a name a template of this module writes does see what the
   * module declares.
   */
  const presentIn = (scopes: ScopeSetId, region: Region): boolean =>
    region.entered === undefined ||
    (region.scope !== undefined &&
      options.scopeStore.has(scopes, region.scope)) ||
    !options.scopeStore.introducedSince(scopes, region.entered);

  /**
   * The scopes of the regions `marker`, a `#syntax` the walk has reached,
   * stands in as the walk found them, which the definitions it generates are
   * given. A macro generated inside a block from syntax the block holds is
   * defined in the block, and its template sees what the block binds, as
   * anything else written there does.
   */
  const definedWithin = (marker: Syntax): ScopeSetId => {
    let scopes = options.scopeStore.empty();
    for (const region of regions)
      if (region.entered !== undefined && presentIn(marker.scopes, region))
        scopes = options.scopeStore.add(
          scopes,
          (region.scope ??= options.scopeStore.freshScope("lexical", "region")),
        );
    return scopes;
  };

  /**
   * Whether syntax carrying `scopes` carries the scope of `region`'s binding
   * form wherever `binder`, written in the region, does.
   *
   * A binder the walk found in the region carries that scope, and so does
   * everything else written there. A template's text does not: it was
   * written where its macro was defined. So a name carrying the
   * introduction scope of an invocation the binder is no part of was written
   * by a template the binder was not, and does not carry it. Asked instead
   * by whether the invocation was made since the walk entered the region,
   * this missed an operator, which is expanded while its expression is read,
   * before the walk enters the function holding it: a parameter named
   * `twice` captured the `twice` such an operator's template wrote.
   *
   * A binder a template wrote into the region does not carry the region's
   * scope either, and a name its template wrote beside it carries the same
   * introduction scope, so that name is answered as present.
   */
  const presentWith = (
    scopes: ScopeSetId,
    binder: Binder,
    region: Region,
  ): boolean =>
    region.entered === undefined ||
    (region.scope !== undefined &&
      options.scopeStore.has(scopes, region.scope)) ||
    !options.scopeStore.introducedApartFrom(scopes, binder.scopes);

  /**
   * Whether `written`, spelled `spelling`, names an ordinary binding rather
   * than a macro of `category`: a binder of that spelling encloses it, in
   * the namespace the category reads, and it carries every scope the binder
   * does, the scope of the region the binder is written in included.
   */
  const shadowsMacro = (
    spelling: string,
    category: SyntaxCategory,
    written: Syntax,
  ): boolean =>
    regions.some((region, depth) => {
      const binders = (
        category === "type" ? region.bindings.types : region.bindings.values
      )?.get(spelling);
      if (binders === undefined) return false;
      const applies = (binder: Binder): boolean =>
        binder.from <= region.at &&
        region.at < binder.to &&
        options.scopeStore.subset(binder.scopes, written.scopes) &&
        !(binder.ofClass && inStaticMember(depth)) &&
        presentWith(written.scopes, binder, region);
      if (binders.length <= scanLimit) return binders.some(applies);
      const index = indexedBinders(binders);
      if (index.unscoped.some(applies)) return true;
      // A binder applies only to a name carrying its largest scope, so only
      // the binders filed under a scope the name carries are asked, read from
      // whichever of the two is shorter.
      const scopes = options.scopeStore.scopesOf(written.scopes);
      if (scopes.length <= index.byScope.size)
        return scopes.some(
          (scope) => index.byScope.get(scope)?.some(applies) === true,
        );
      for (const [scope, filed] of index.byScope)
        if (
          options.scopeStore.has(written.scopes, scope) &&
          filed.some(applies)
        )
          return true;
      return false;
    });

  /**
   * How many binders of one spelling a lookup reads one by one before it
   * files them by scope instead.
   */
  const scanLimit = 8;

  /**
   * The binders of one spelling in one region, filed under each one's
   * largest scope: a name carries every scope of a binder that captures it,
   * so it is asked only of the binders filed under scopes it carries. A
   * region's binders of a spelling grow as the walk declares into the run,
   * and the index files each once, the next time it is asked.
   *
   * Asked of every binder, a run that declares a name of one spelling per
   * statement -- a file of invocations whose template each writes `const v`
   * -- cost the square of its length.
   */
  interface BinderIndex {
    filed: number;
    readonly unscoped: Binder[];
    readonly byScope: Map<ScopeId, Binder[]>;
  }
  const binderIndexes = new WeakMap<readonly Binder[], BinderIndex>();
  const indexedBinders = (binders: readonly Binder[]): BinderIndex => {
    let index = binderIndexes.get(binders);
    if (index === undefined) {
      index = { filed: 0, unscoped: [], byScope: new Map() };
      binderIndexes.set(binders, index);
    }
    for (; index.filed < binders.length; index.filed += 1) {
      const binder = binders[index.filed]!;
      const largest = options.scopeStore.scopesOf(binder.scopes).at(-1);
      if (largest === undefined) {
        index.unscoped.push(binder);
        continue;
      }
      const filed = index.byScope.get(largest);
      if (filed === undefined) index.byScope.set(largest, [binder]);
      else filed.push(binder);
    }
    return index;
  };

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

  /**
   * What reading a brace's header back finds: the kind of body a keyword says
   * the brace opens, or else the function parameter list it was read up to.
   */
  type HeaderRead =
    | { readonly found: BraceHeader }
    | { readonly parameters: number | undefined };

  interface BraceHeader {
    readonly opens: "function" | "class" | "interface" | "enum" | "other";
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
   * An enum body, which holds a list of named members rather than statements,
   * items or an object literal's entries. Nothing in it suspends: a member's
   * value is a constant expression, which no `yield` or `await` may stand in.
   */
  const enumBrace: BraceHeader = {
    opens: "enum",
    yields: false,
    awaits: false,
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
   * is written: a type parameter list between the two is read past, and so is
   * an optional method's `?`. A function written `function* (` names itself
   * nothing, and the star stands there instead.
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
    // An optional method's `?` stands after its name: `async *m?(`.
    const optional = nodeAt(run, at);
    if (optional?.tag === "token" && optional.raw === "?") at -= 1;
    return at;
  };

  /**
   * Whether the parameter list at `parameters` is a `function`'s: the keyword
   * stands in front of its name, in front of a generator's star, or in place
   * of the name -- `function f(`, `function* f(`, `function (`.
   */
  const declaredFunctionAt = (run: SyntaxRun, parameters: number): boolean => {
    const name = functionNameAt(run, parameters);
    for (let at = name; at >= name - 2; at -= 1) {
      const node = nodeAt(run, at);
      if (node?.tag !== "token") return false;
      if (node.raw === "function") return true;
      if (at < name && node.raw !== "*") return false;
    }
    return false;
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
   * The body each declaring keyword opens.
   *
   * An interface body is a member list, and so is an object type written in
   * what the interface extends: `interface I extends Pick<{ a: 1 }, "a">`.
   * Only a module-level interface is read by the item consumer, so this is
   * how a body nested any deeper -- inside a namespace, a `declare global`, a
   * function body, an item recovery swallowed -- is recognized as the member
   * list it is. An enum body is a member list too, and `const enum` and
   * `declare enum` are read past on the way back to the keyword that says so.
   */
  const declarationBraces: ReadonlyMap<string, BraceHeader> = new Map([
    ["class", classBrace],
    ["namespace", namespaceBrace],
    ["module", namespaceBrace],
    ["interface", interfaceBrace],
    ["enum", enumBrace],
  ]);

  /**
   * Whether the word at `at` declares what it is spelled: whether it is the
   * keyword, rather than a member or a key spelled like one. Every one of
   * them is a property name too -- `o.class`, `{ enum: 1 }`, `case K.module:`
   * -- and taking `o.class || { k: x }` for a class header made the object
   * literal a class body, where `x` was never expanded.
   *
   * A keyword is not read through a member access, and is followed by what it
   * declares: a name, a module's string, or, for a class, `extends` or the
   * body of an anonymous class. The brace being asked about, at `end`, may
   * not be in the run yet: the walk asks before it has walked it.
   */
  const declarationKeywordAt = (
    run: SyntaxRun,
    at: number,
    end: number,
  ): boolean => {
    const keyword = nodeAt(run, at);
    if (keyword?.tag !== "token") return false;
    const before = nodeAt(run, at - 1);
    if (before?.tag === "token" && (before.raw === "." || before.raw === "?."))
      return false;
    if (at + 1 === end) return keyword.raw === "class";
    const after = nodeAt(run, at + 1);
    if (after === undefined) return false;
    if (keyword.raw === "class")
      return after.tag === "group"
        ? after.delimiter === "brace"
        : after.tag === "token" &&
            (isIdentifierToken(after) || after.raw === "extends");
    if (after.tag !== "token") return false;
    if (keyword.raw === "module" && after.kind === "string-literal")
      return true;
    return isIdentifierToken(after);
  };

  /**
   * What reading a brace's header back from `from` finds, `end` being where
   * the brace stands: the kind of body its keyword opens, or else the
   * function parameter list it is read up to, if any. The header is read back
   * to where the statement or member began. A class body is recognized by its
   * keyword, which also covers `class A extends mixin(B) {` with a parameter
   * list in front of its body.
   */
  const readHeaderBack = (
    run: SyntaxRun,
    from: number,
    end: number,
  ): HeaderRead | { readonly behind: number } => {
    let parameters: number | undefined;
    // Type arguments in a return type hold commas of their own:
    // `Generator<number, number, number>`.
    let typeArguments = 0;
    for (let at = from; at >= 0; at -= 1) {
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
          if (opens > typeArguments) return { found: interfaceBrace };
          typeArguments -= opens;
          continue;
        }
        if (typeArguments > 0) continue;
        const declared = declarationKeywordAt(run, at, end)
          ? declarationBraces.get(node.raw)
          : undefined;
        if (declared !== undefined) return { found: declared };
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
      if (node.tag !== "group" || node.delimiter !== "brace") continue;
      if (!typeOperandFollows(nodeAt(run, at - 1))) break;
      // Read on from there with nothing read yet, the header is what it is
      // read back from behind that brace, which is read once for all the
      // braces that reach it.
      if (
        parameters === undefined &&
        typeArguments === 0 &&
        at <= run.walked.length
      )
        return { behind: at };
    }
    return { parameters };
  };

  /**
   * What reading a header back from behind each brace already read so finds,
   * by the walked run it stands in. Only what the run has walked is read back
   * over, and what a run has walked never changes.
   */
  const headerReads = new WeakMap<readonly Syntax[], Map<number, HeaderRead>>();

  /**
   * What reading a header back finds from behind `brace`, an object type the
   * header reads on past, with nothing read yet. Every brace of a type that
   * chains them -- `{ a: 1 } | { b: 2 } | ...` -- reads on past the one before
   * it to the same header, so reading back from each in turn read the whole
   * chain behind each one. Each is read once here, and the chain is followed
   * in one loop rather than one call deeper per brace.
   */
  const readHeaderBehind = (run: SyntaxRun, brace: number): HeaderRead => {
    let reads = headerReads.get(run.walked);
    if (reads === undefined) {
      reads = new Map();
      headerReads.set(run.walked, reads);
    }
    const waiting: number[] = [];
    let at = brace;
    let read = reads.get(at);
    while (read === undefined) {
      waiting.push(at);
      const step = readHeaderBack(run, at - 1, Number.POSITIVE_INFINITY);
      if ("behind" in step) {
        at = step.behind;
        read = reads.get(at);
      } else read = step;
    }
    for (const waited of waiting) reads.set(waited, read);
    return read;
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
    const first = readHeaderBack(run, end - 1, end);
    const read =
      "behind" in first ? readHeaderBehind(run, first.behind) : first;
    if ("found" in read) return read.found;
    // A parameter list the header found behind a return type is the one: a
    // return type may be parenthesized itself, `f(x: number): (number) {`,
    // and taking that for the parameter list read the `:` as the name of a
    // function and the body as a block.
    const parameters =
      read.parameters ??
      (previous?.tag === "group" && previous.delimiter === "parenthesis"
        ? end - 1
        : undefined);
    if (parameters === undefined) return otherBrace;
    // A statement holds no method, so a parameter list there with nothing
    // declaring it a function's is a call, and a brace on the line under it
    // is a block of its own: `use(x)` then `{ use(x) }`. On the same line
    // the two cannot be a call and a block, and are read as a method, which
    // is what a literal's member is where the walk took the literal's braces
    // for a block.
    if (
      run.statements === true &&
      leadingLineBreak(nodeAt(run, end)) &&
      !declaredFunctionAt(run, parameters)
    )
      return otherBrace;
    // An optional method writes `?` between its name and its parameter list:
    // `m?(x: number) {`.
    const optional = nodeAt(run, parameters - 1);
    const opener =
      optional?.tag === "token" && optional.raw === "?"
        ? nodeAt(run, parameters - 2)
        : optional;
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
    if (controlKeywords.has(opener.raw) && run.members !== true)
      return otherBrace;
    if (
      opener.raw === "await" &&
      lastTokenOf(nodeAt(run, parameters - 2))?.raw === "for"
    )
      return otherBrace;
    return isPropertyNameToken(opener) ||
      opener.raw === "*" ||
      angles(opener, ">") > 0
      ? functionBrace
      : otherBrace;
  };

  const braceOpens = (run: SyntaxRun, end: number): BraceHeader["opens"] =>
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
    member: ClassMemberWalk,
    group: Extract<Syntax, { readonly tag: "group" }>,
  ): boolean => {
    const annotated = group.children[1];
    if (annotated?.tag === "token" && annotated.raw === ":") return false;
    return member.nameFollows();
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
  ): boolean => parametersFunction(group, run, at) !== undefined;

  /**
   * The function whose parameter list `group`, standing at `at` in `run`, is,
   * when it is one: where an arrow's `=>` stands, or where the body of any
   * other function does. `parameterList` asks the same.
   */
  const parametersFunction = (
    group: Syntax | undefined,
    run: SyntaxRun,
    at: number,
  ): { readonly arrow: number } | { readonly body: number } | undefined => {
    if (group?.tag !== "group" || group.delimiter !== "parenthesis")
      return undefined;
    const arrow = arrowAfterParameters(run, at, at + 1);
    if (arrow !== undefined) return { arrow };
    const length = runLength(run);
    let typeArguments = 0;
    for (let scan = at + 1; scan < length; scan += 1) {
      const node = nodeAt(run, scan)!;
      if (node.tag === "token") {
        if (scan === at + 1 && node.raw !== ":") return undefined;
        const nested = angles(node, "<") - angles(node, ">");
        if (nested !== 0) {
          typeArguments = Math.max(0, typeArguments + nested);
        } else if (typeArguments === 0) {
          // An arrow's own `=>` was answered above, so one here belongs to a
          // function type written in the return type: `m(): () => T {`.
          if (statementBoundaries.has(node.raw) || node.raw === "=")
            return undefined;
        }
        continue;
      }
      if (typeArguments > 0) continue;
      if (!braceBody(node)) {
        if (scan === at + 1) return undefined;
        continue;
      }
      if (typeOperandFollows(nodeAt(run, scan - 1))) continue;
      return braceHeader(run, scan).parameters === at
        ? { body: scan }
        : undefined;
    }
    return undefined;
  };

  /**
   * The accumulators an operand fold built, each already walked. A step
   * holding one reads it as one operand and does not walk it again: it holds
   * the accumulator before it, as deep as the fold has gone.
   */
  const builtAccumulators = new WeakSet<Syntax>();

  /** Reports an operand fold that cannot be built where it stands. */
  const reportFold = (marker: TokenSyntax, problem: string) => {
    const origin = primaryOrigin(marker);
    if (origin === undefined)
      throw new TypeError("A #fold has no source to report it at");
    // A fold handed to another macro reached it as a copy of the one its
    // template wrote.
    let record = options.origins.get(marker.origin);
    while (record?.kind === "copied")
      record = options.origins.get(record.parent);
    diagnostics.push(
      expansionDiagnosticRegistry.create(foldPositionCode, {
        primaryOrigin: origin,
        messageArguments: [problem],
        relatedOrigins:
          record?.kind === "introduced"
            ? [
                {
                  message: "The #fold is written here",
                  origin: options.diagnosticOrigin(record.definition),
                },
              ]
            : [],
      }),
    );
  };

  /**
   * `syntax` again, with ids of its own, for a step that writes `$acc` more
   * than once: each place it stands holds a node of its own. Every token is
   * charged as output, as the template's own copies are, so a step that
   * doubles its accumulator meets the output limit rather than memory's.
   */
  const copyAccumulator = (syntax: Syntax): Syntax => {
    switch (syntax.tag) {
      case "token":
        options.tracker.chargeOutputTokens();
        return createToken({ ...syntax, id: options.allocateSyntaxId() });
      case "group":
        return createGroup({
          ...syntax,
          id: options.allocateSyntaxId(),
          open: copyAccumulator(syntax.open) as TokenSyntax,
          children: syntax.children.map(copyAccumulator),
          close:
            syntax.close.tag === "token"
              ? (copyAccumulator(syntax.close) as TokenSyntax)
              : syntax.close,
        });
      case "protected": {
        const copied = createProtectedSyntax({
          ...syntax,
          id: options.allocateSyntaxId(),
          children: syntax.children.map(copyAccumulator),
        });
        if (builtAccumulators.has(syntax)) builtAccumulators.add(copied);
        return copied;
      }
      case "root":
        throw new TypeError("A fold's accumulator holds no root");
    }
  };

  /**
   * A step's syntax with each `$acc` it wrote filled with `accumulator`, and
   * how many it filled. A fold written in the step has accumulators of its
   * own, and only its initial template, which is evaluated where it is
   * written, can hold one of this fold's.
   */
  const fillAccumulators = (
    nodes: readonly Syntax[],
    accumulator: ProtectedSyntax,
  ): { readonly syntax: SyntaxSequence; readonly filled: number } => {
    let filled = 0;
    const fill = (children: readonly Syntax[]): readonly Syntax[] => {
      let changed = false;
      const result = children.map((node) => {
        const next = fillNode(node);
        changed ||= next !== node;
        return next;
      });
      return changed ? result : children;
    };
    const fillNode = (node: Syntax): Syntax => {
      if (isFoldAccumulator(node)) {
        filled += 1;
        return filled === 1 ? accumulator : copyAccumulator(accumulator);
      }
      if (node.tag === "group") {
        const children = fill(node.children);
        return children === node.children
          ? node
          : createGroup({
              ...node,
              id: options.allocateSyntaxId(),
              children: createSyntaxSequence(children),
            });
      }
      const inner = foldCarrier(node);
      if (inner === undefined || node.tag !== "protected") return node;
      const initial = fillNode(inner.initial);
      return initial === inner.initial
        ? node
        : createProtectedSyntax({
            ...node,
            id: options.allocateSyntaxId(),
            children: [inner.marker, initial, ...inner.steps],
          });
    };
    const syntax = fill(nodes);
    return { syntax: createSyntaxSequence(syntax), filled };
  };

  /**
   * `syntax` wearing `trivia` in front of its first token, whatever that token
   * wore before: an operand fold's result stands where `#fold` was written,
   * and wears the layout written there.
   */
  const wearingLayout = (syntax: Syntax, trivia: readonly Trivia[]): Syntax => {
    const path: (GroupSyntax | ProtectedSyntax)[] = [];
    let current = syntax;
    while (current.tag !== "token") {
      if (current.tag === "root")
        throw new TypeError("An expression or a type holds no root");
      path.push(current);
      const head: Syntax | undefined =
        current.tag === "group" ? current.open : current.children[0];
      if (head === undefined) return syntax;
      current = head;
    }
    let rebuilt: Syntax = createToken({ ...current, leadingTrivia: trivia });
    for (let at = path.length - 1; at >= 0; at -= 1) {
      const node = path[at]!;
      rebuilt =
        node.tag === "group"
          ? createGroup({ ...node, open: rebuilt as TokenSyntax })
          : createProtectedSyntax({
              ...node,
              children: [rebuilt, ...node.children.slice(1)],
            });
    }
    return rebuilt;
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
    // `token` and `braceAfter` are written outside, taking the nodes they read
    // rather than closing over them: this is asked once per node of every run
    // walked, and two closures per node is two allocations per node for two
    // functions that never differ.
    // `task.class` and `task.function` name properties.
    if (tokenAt(nodes, at - 1, ".") || tokenAt(nodes, at - 1, "?."))
      return undefined;
    // `async` modifies what is written after it on the same line; left alone
    // on its own line it is an ordinary name, and the closure under it is one
    // of its own. The enforestation route reads it by the same rule.
    const async = asyncModifies(nodes[at], nodes[at + 1]);
    const start = async ? at + 1 : at;
    if (tokenAt(nodes, start, "function")) {
      const end = braceAfterIn(nodes, start + 1);
      return end === undefined ? undefined : { end, kind: "function", async };
    }
    if (at === start && tokenAt(nodes, at, "class")) {
      const end = braceAfterIn(nodes, at + 1);
      return end === undefined ? undefined : { end, kind: "class", async };
    }
    const parameters = nodes[start];
    // An arrow's one unparenthesized parameter is named by the rule every
    // binder is named by, which the enforester's reader of the same arrow
    // asks: any word TypeScript does not reserve, `type` and `of` and
    // `readonly` included.
    const named = parameters?.tag === "token" && isIdentifierToken(parameters);
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
            : tokenAt(nodes, start + 1, "=>"))
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

  return {
    options,
    activeModules,
    bindingsOf,
    braceBody,
    braceHeader,
    collecting,
    contractBindings,
    declareInRun,
    declaredBy,
    definedWithin,
    firstAfter,
    hoistedFrom,
    infixSpellings,
    noBindings,
    otherBrace,
    staticMembers,
    substatementAt,
    addScopes,
    afterDirectives,
    angles,
    anglesOpen,
    commaSeparatedMembers,
    assignmentPatternAt,
    shorthandProperty,
    binderFollows,
    braceOpens,
    builtAccumulators,
    capturingClosures,
    catchBinderFollows,
    classHeritageFollows,
    closureEndAt,
    computedMemberNameFollows,
    conditionFollows,
    contextsWithin,
    declaringFirst,
    decoratorArgumentsFollow,
    definitionShapeFollows,
    definitionSpelling,
    diagnostics,
    endsOperand,
    enforestOrReport,
    enforestSequence,
    expressionOf,
    expressionRegionEnds,
    keywordSpellsName,
    expressionRegionHeads,
    fillAccumulators,
    freshCopy,
    functionBodyFollows,
    generatedDefinitionTraces,
    holdsStatementOperator,
    initializerFollows,
    operandBraceFollows,
    lastTokenOf,
    liftFrames,
    liftedDeclaration,
    methodNamePrefixes,
    moduleWrittenIn,
    namedOrigins,
    namesNamespaceAlias,
    offeredOperators,
    parameterList,
    parameterizations,
    primaryOrigin,
    regionBindings,
    regions,
    reportFold,
    requiredUseOrigin,
    runOf,
    shadowsMacro,
    specifierListFollows,
    staticBlockFollows,
    suspends,
    traces,
    typeAliasInitializerFollows,
    typeFollowsInExpression,
    typePositionFollows,
    typeReferenceStart,
    holdForTypeScript,
    unresolvedNameExplanations,
    declaredBindings,
    usedParameterizations,
    wearingLayout,
    withAwait,
    withConciseBodyDeclaring,
    withLeadingTrivia,
    withYield,
    withinArrow,
    withoutLeadingTrivia,
    writtenGroup,
    writtenToken,
    /** The expansion environment the macros generated so far extend. */
    activeExpansionEnvironment: options.expansionEnvironment,
    /**
     * The spelling of a macro whose expansion reached a limit; it is not
     * expanded again in this expansion.
     */
    abortedSpelling: undefined as string | undefined,
  };
}

type ExpansionScope = ReturnType<typeof createExpansionScope>;

/**
 * A `#name (...) { ... }` form written in a walked run, with what was read
 * from its parentheses; see `markedFormAt` in `walk`.
 */
interface MarkedForm<Read> {
  readonly argumentsIndex: number;
  readonly argumentsGroup: GroupSyntax;
  readonly body: GroupSyntax;
  readonly read: Read;
}

/** What a position in a walk dispatches; see `dispatchAt` in `walk`. */
type Dispatch =
  | {
      readonly macro: CompiledMacroBinding | undefined;
      readonly resolvedHeadIndex: number;
      readonly resolvedCategory: SyntaxCategory;
      readonly resolvedSpelling: string;
    }
  | { readonly fold: FoldCarrier; readonly reads: "expr" | "type" | undefined };

/** Whether `node` is a `,`. */
function spelledComma(node: Syntax): boolean {
  return node.tag === "token" && node.raw === ",";
}

/**
 * `nodes` cut at each node `separates` accepts: the runs between them, each
 * with the separator that ends it, and the last run with none.
 */
function separatedRuns(
  nodes: readonly Syntax[],
  separates: (node: Syntax) => boolean,
): {
  readonly run: readonly Syntax[];
  readonly separator: Syntax | undefined;
}[] {
  const runs: {
    readonly run: readonly Syntax[];
    readonly separator: Syntax | undefined;
  }[] = [];
  let run: Syntax[] = [];
  for (const node of nodes) {
    if (!separates(node)) {
      run.push(node);
      continue;
    }
    runs.push({ run, separator: node });
    run = [];
  }
  runs.push({ run, separator: undefined });
  return runs;
}

/** What walking a run of syntax produced, and the environment after it. */
interface WalkResult {
  readonly syntax: SyntaxSequence;
  readonly environment: BindingEnvironment;
  /** What expansions in the run declared, as `Region` keeps it. */
  readonly declared: RegionBindings;
  readonly hoisted: RegionBindings;
  readonly following: ScopeSetId;
}

/**
 * What a walk asks to have walked when it descends into nested syntax: the
 * arguments of `walk` for that syntax, after the scope they share.
 */
type WalkRequest = readonly [
  input: SyntaxSequence,
  environment: BindingEnvironment,
  category: SyntaxCategory,
  parentInvocation: InvocationId | undefined,
  lexicalModule: CompileParsedMacrosResult,
  contexts: ReadonlySet<MacroContext>,
  suppressHead?: boolean,
  recursiveBinding?: BindingId,
  objectMember?: boolean,
  groupInterior?: boolean,
  context?: () => ScopeId,
  classBody?: boolean,
];

/** A request for a nested walk, written as `walk`'s arguments are. */
function nestedWalk(...request: WalkRequest): WalkRequest {
  return request;
}

/**
 * The walk of one run of syntax. It descends into the syntax nested in the run
 * by yielding a request for the walk of that syntax, and is resumed with what
 * that walk produced, so how deep the syntax nests is held in `walkToEnd`'s
 * list rather than on the JavaScript stack.
 *
 * `walk` is the one generator function a walk runs, declared once here rather
 * than inside the expansion: V8 gives each generator function object a map of
 * its own that refers back to it, and a generator function made for one
 * expansion kept everything that expansion held reachable from that map until
 * the next full collection.
 */
type Walk = Generator<WalkRequest, WalkResult, WalkResult>;

/**
 * Walks what `request` asks for, and every walk nested in it, to the end. Each
 * walk stands above the one that asked for it, and a walk that throws throws
 * into the one that asked for it, where its caller would have caught it.
 */
function walkToEnd(scope: ExpansionScope, request: WalkRequest): WalkResult {
  const walks: Walk[] = [walk(scope, ...request)];
  // What the walk on top is resumed with: nothing when it is starting, or what
  // the walk it asked for returned, or what that walk threw.
  let returned: WalkResult | undefined;
  let threw = false;
  let error: unknown;
  for (;;) {
    const current = walks.at(-1)!;
    let step: IteratorResult<WalkRequest, WalkResult>;
    try {
      step = threw
        ? current.throw(error)
        : returned === undefined
          ? current.next()
          : current.next(returned);
    } catch (thrown) {
      walks.pop();
      if (walks.length === 0) throw thrown;
      threw = true;
      error = thrown;
      continue;
    }
    threw = false;
    error = undefined;
    if (step.done) {
      walks.pop();
      if (walks.length === 0) return step.value;
      returned = step.value;
    } else {
      walks.push(walk(scope, ...step.value));
      returned = undefined;
    }
  }
}

function* walk(
  scope: ExpansionScope,
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
  /**
   * The scope of the definition context the run is part of: the list's
   * where the run is one unit of a list -- a statement, an item -- and
   * otherwise the run's own.
   */
  context = definitionContextScope(scope.options.scopeStore),
  /** Whether the run is the inside of a class's body: its members. */
  classBody = false,
): Walk {
  const {
    options,
    activeModules,
    bindingsOf,
    braceBody,
    braceHeader,
    collecting,
    contractBindings,
    declareInRun,
    declaredBy,
    definedWithin,
    firstAfter,
    hoistedFrom,
    infixSpellings,
    noBindings,
    otherBrace,
    staticMembers,
    substatementAt,
    addScopes,
    angles,
    commaSeparatedMembers,
    assignmentPatternAt,
    shorthandProperty,
    binderFollows,
    braceOpens,
    builtAccumulators,
    capturingClosures,
    catchBinderFollows,
    classHeritageFollows,
    closureEndAt,
    computedMemberNameFollows,
    conditionFollows,
    contextsWithin,
    declaringFirst,
    decoratorArgumentsFollow,
    definitionShapeFollows,
    definitionSpelling,
    diagnostics,
    endsOperand,
    enforestOrReport,
    enforestSequence,
    expressionOf,
    expressionRegionEnds,
    keywordSpellsName,
    expressionRegionHeads,
    fillAccumulators,
    freshCopy,
    functionBodyFollows,
    generatedDefinitionTraces,
    holdsStatementOperator,
    initializerFollows,
    operandBraceFollows,
    lastTokenOf,
    liftFrames,
    methodNamePrefixes,
    moduleWrittenIn,
    namedOrigins,
    namesNamespaceAlias,
    offeredOperators,
    parameterList,
    parameterizations,
    primaryOrigin,
    regionBindings,
    regions,
    reportFold,
    requiredUseOrigin,
    runOf,
    shadowsMacro,
    specifierListFollows,
    staticBlockFollows,
    suspends,
    traces,
    typeAliasInitializerFollows,
    typeFollowsInExpression,
    typePositionFollows,
    typeReferenceStart,
    holdForTypeScript,
    usedParameterizations,
    wearingLayout,
    withAwait,
    withConciseBodyDeclaring,
    withLeadingTrivia,
    withYield,
    withinArrow,
    withoutLeadingTrivia,
    writtenGroup,
    writtenToken,
    declaredBindings,
  } = scope;
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
    return innermost === undefined ? next : withinArrow(next, innermost.async);
  };
  const enterRegionContexts = (next: ReadonlySet<MacroContext>) => {
    regionContexts = next;
    contexts = withinOpenArrow(next);
  };
  let input = initialInput;
  /** Whether a run of statements is what is being walked. */
  const statementRun =
    !groupInterior && (category === "stmt" || category === "item");
  const region: Region = {
    bindings: regionBindings(
      initialInput,
      category,
      statementRun,
      classBody || objectMember || category === "classElement",
    ),
    at: 0,
    declared: collecting(),
    hoisted: collecting(),
    following: options.scopeStore.empty(),
    given: options.scopeStore.empty(),
    context,
    entered: regions.length === 0 ? undefined : options.scopeStore.mark(),
    scope: undefined,
    statics: classBody ? staticMembers(initialInput) : undefined,
  };
  regions.push(region);
  const output: Syntax[] = [];
  /**
   * Everything walked so far, read by position. The array is held rather
   * than copied, so this reads what has been walked at the moment it is
   * asked and one run serves the whole walk.
   */
  /** Whether the run is a member list, or one member, where no statement stands. */
  const memberRun =
    classBody || objectMember || category === "classElement";
  const walkedRun: SyntaxRun = {
    ...runOf(output),
    statements: statementRun,
    members: memberRun,
  };
  /**
   * Everything walked so far and then what is yet to be walked, read from
   * `from` on. A rule that reads across the two -- a parameter list and the
   * body its header names -- is given this rather than the two joined.
   */
  const runAhead = (from: number): SyntaxRun => ({
    walked: output,
    following: input,
    from,
    statements: statementRun,
    members: memberRun,
  });
  /**
   * Gives `scopes`, which binding contracts gave the syntax following them,
   * to every node of the run from `from` on, and records them for the run
   * around this one.
   */
  const follow = (from: number, scopes: ScopeSetId): void => {
    region.following = options.scopeStore.union(region.following, scopes);
    if (options.scopeStore.subset(scopes, region.given)) return;
    region.given = options.scopeStore.union(region.given, scopes);
    input = createSyntaxSequence([
      ...input.slice(0, from),
      ...input.slice(from).map((syntax) => addScopes(syntax, scopes)),
    ]);
  };
  /**
   * A cursor over `input` from its start, which each invocation forks. Made
   * once for each `input` rather than for each invocation: making one checks
   * every node of the run, and a run of many macro uses checked the whole run
   * once for each of them.
   */
  let inputCursor:
    | { readonly over: readonly Syntax[]; readonly cursor: SyntaxCursor }
    | undefined;
  const cursorAt = (at: number): SyntaxCursor => {
    if (inputCursor?.over !== input)
      inputCursor = { over: input, cursor: createSyntaxCursor(input) };
    const cursor = inputCursor.cursor.fork();
    cursor.advance(at);
    return cursor;
  };
  let currentEnvironment = environment;
  let index = 0;
  let suppressPending = suppressHead;
  let suppressedHeadIndex: number | undefined;
  /**
   * The walk of `syntax` as the expression it is: enforested first, so that a
   * macro in it is dispatched in the expression space and the operators
   * around it bind as they would anywhere else. Every brace this walk reads
   * as a list of members -- an object literal, an enum body -- hands over
   * the part of each member that is an expression this way, so the two
   * agree about what a member's value is.
   */
  const expressionWalk = (
    syntax: readonly Syntax[],
    /** Whether `syntax` is a whole member, whose head may name it. */
    wholeMember = false,
  ): WalkRequest => {
    const enforested = options.enforestExpression?.({
      syntax: createSyntaxSequence(syntax),
      contexts,
      lexicalModule,
    });
    return nestedWalk(
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
  };
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
  /**
   * Whether the node about to be walked stands among the type arguments of
   * an expression: the `{ at: number }` of `new Map<string, { at: number
   * }>()` or of `make<{ at: number }>()`.
   *
   * Every token a type is written after is an expression's too, so a rule
   * that read only what stands in front of the position would take the
   * brace of `f(a < b, { a: 1 })` for an object type. Three questions
   * together say a type-argument list rather than a comparison: a `<`
   * behind that nothing has closed, the `>` that closes it written ahead,
   * and a `,` or that `<` directly in front, which is where a type operand
   * stands. TypeScript resolves the same ambiguity by parsing the candidate
   * list and reading what follows it; over loose tokens these are the
   * questions the walk can answer.
   */
  /**
   * The `<` tokens walked so far that nothing has closed, as how many each
   * still holds open, innermost last. No type-argument list spans a
   * statement boundary, so a `;` or a `}` closes them all.
   *
   * They are read forward as the walk goes, each token once, rather than
   * back from the end every time the question is asked: asked after every
   * `,` of a long list, reading back cost the square of its length.
   */
  const openAngles: OpenAngles[] = [];
  let anglesRead = 0;
  /** The innermost `<` still open. */
  const unclosedAngles = (): OpenAngles | undefined => {
    for (; anglesRead < output.length; anglesRead += 1) {
      const node = output[anglesRead]!;
      if (node.tag !== "token") continue;
      if (node.raw === ";" || node.raw === "}") {
        openAngles.length = 0;
        continue;
      }
      let closes = angles(node, ">");
      while (closes > 0 && openAngles.length > 0) {
        const open = openAngles.pop()!;
        if (open.held > closes)
          openAngles.push({ held: open.held - closes, answer: open.answer });
        closes -= Math.min(open.held, closes);
      }
      const opens = angles(node, "<");
      if (opens > 0) openAngles.push({ held: opens, answer: undefined });
    }
    return openAngles.at(-1);
  };
  const typeArgumentsEnclose = (at: number): boolean => {
    const previous = output.at(-1);
    if (
      previous?.tag !== "token" ||
      (previous.raw !== "," && angles(previous, "<") === 0)
    )
      return false;
    const open = unclosedAngles();
    if (open === undefined) return false;
    // Every `,` the one `<` holds is answered by where that `<` closes, so
    // the answer is read ahead once for all of them, and kept until the walk
    // passes where reading ahead stopped. Read ahead again at every `,`, a
    // `<` that never closes -- `[a < 1, {}, {}, ...]` -- read to the end of
    // the run each time.
    if (open.answer !== undefined && open.answer.until > at)
      return open.answer.encloses;
    const answer = readTypeArgumentsAhead(at, open.held);
    open.answer = answer;
    return answer.encloses;
  };
  const readTypeArgumentsAhead = (
    at: number,
    held: number,
  ): { readonly until: number; readonly encloses: boolean } => {
    let depth = held;
    for (let forward = at + 1; forward < input.length; forward += 1) {
      const node = input[forward]!;
      if (node.tag !== "token") continue;
      if (node.raw === ";") return { until: forward, encloses: false };
      depth += angles(node, "<");
      depth -= angles(node, ">");
      // The candidate has closed, and what stands after it says whether it
      // was ever a type-argument list -- the fourth question, and the one
      // TypeScript answers by parsing the list and reading on. A call or a
      // tagged template after it makes it a call's type arguments; short of
      // that, only something that cannot begin an operand leaves it an
      // instantiation expression.
      //
      // Without it `f(a < b, { x: 1 }, c > d)`, which is three comparisons,
      // had its brace read as an object type -- so a macro written in that
      // brace was never offered to the expander, and nothing was reported,
      // because as far as every other part of the walk went the reading had
      // succeeded.
      if (depth <= 0) {
        const following = input[forward + 1];
        return {
          until: forward,
          encloses:
            callFollowsTypeArguments(following) ||
            typeArgumentsFollow(following),
        };
      }
    }
    return { until: input.length, encloses: false };
  };
  /**
   * The class member being walked, read from `output` a node at a time as it
   * is asked about, and how much of `output` it has read.
   */
  const members =
    category === "classElement" ? createClassMemberWalk() : undefined;
  let memberRead = 0;
  /** The member walked so far, in a run of class elements. */
  const memberSoFar = (): ClassMemberWalk => {
    if (members === undefined)
      throw new Error("A class member was asked about outside a class body");
    while (memberRead < output.length) members.take(output[memberRead++]!);
    return members;
  };
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
    typeArgumentsEnclose(index) ||
    (category === "expr" || expressionRegion
      ? typeFollowsInExpression(output)
      : typePositionHere()) ||
    typeReferenceContinues();
  /**
   * Whether the bracket about to be walked continues a type reference that
   * stands where a type is read: `Z[K]` and `Z[]` in `let t: Z[K]`, where
   * the token in front of the bracket is the name rather than the `:`.
   */
  const typeReferenceContinues = (): boolean => {
    const node = input[index];
    if (node?.tag !== "group" || node.delimiter !== "bracket") return false;
    const start = typeReferenceStart(output);
    if (start === undefined || start === output.length) return false;
    return category === "expr" || expressionRegion
      ? typeFollowsInExpression(output, start)
      : !labelColonEnds(start) && typePositionFollows(output, start);
  };
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
  /**
   * Notes what the node at `index` stands in before it is walked: the
   * regions, arrows and contexts that what was walked before it opens or
   * closes.
   */
  const enterPosition = (node: Syntax): void => {
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
      } else if (walked.raw === ";" || walked.raw === "," || walked.raw === "=")
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
      if (memberSoFar().endsBefore(node)) {
        memberSoFar().restart();
        memberRead = output.length;
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
      // both regions the same way a `;` does. A member or a key spelled like
      // one is a name, and closes nothing: `o.type + x` and `{ enum: 1, b: x }`
      // left `x` read as a statement's head rather than an operand.
      if (
        expressionRegionEnds.has(walked.raw) &&
        !keywordSpellsName(output.at(-2), walked, node)
      ) {
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
  };
  const sourceOf = (syntax: Syntax): SourceId | undefined =>
    options.origins.selectPrimarySource(syntax.origin)?.sourceId;
  const resolveSpelling = (
    spelling: string,
    position: number,
    positionSourceId: SourceId | undefined,
    lookupCategory: SyntaxCategory,
    written: Syntax,
  ) => {
    const category = lookupCategory;
    // Template literals use the defining module, but a capture spliced
    // into that template keeps the lexical macro imports of the source in
    // which it was written. Without this, a captured function body inside
    // `#core(function ... $body)` can only see macros imported by the
    // function-shadow definition, not macros imported at its call site.
    if (shadowsMacro(spelling, category, written)) return undefined;
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
      scope.activeExpansionEnvironment !== undefined
      ? activeModules
          .map((module) =>
            resolveCompiledMacro({
              module,
              store: options.expansionStore!,
              environment: scope.activeExpansionEnvironment!,
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
  /**
   * The body of a `#core(...)` written at `index`, spelled `#core` or
   * `# core`, and how many nodes the form takes.
   */
  const coreFormAt = (
    node: Syntax,
  ): { readonly body: GroupSyntax; readonly width: 2 | 3 } | undefined => {
    const coreKeyword = input[index + 1];
    const separatedCoreBody = input[index + 2];
    const compactCoreBody = input[index + 1];
    const body =
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
    if (body === undefined) return undefined;
    return { body, width: body === compactCoreBody ? 2 : 3 };
  };
  /**
   * A `#name (...) { ... }` form written at `index` -- `#let`, `#parameterize`
   * -- spelled as one token or as `#` and the name, with what `read` makes of
   * what its parentheses hold. Nothing where no such form stands there or
   * `read` cannot read it.
   */
  const markedFormAt = <Read>(
    node: Syntax,
    name: string,
    read: (written: readonly Syntax[]) => Read | undefined,
  ): MarkedForm<Read> | undefined => {
    const compact =
      node.tag === "token" &&
      node.raw === `#${name}` &&
      input[index + 1]?.tag === "group" &&
      input[index + 2]?.tag === "group";
    const split =
      node.tag === "token" &&
      node.raw === "#" &&
      input[index + 1]?.tag === "token" &&
      (input[index + 1] as TokenSyntax).raw === name &&
      input[index + 2]?.tag === "group" &&
      input[index + 3]?.tag === "group";
    if (!compact && !split) return undefined;
    const argumentsIndex = index + (compact ? 1 : 2);
    const argumentsGroup = input[argumentsIndex] as GroupSyntax;
    const body = input[argumentsIndex + 1] as GroupSyntax;
    const value =
      argumentsGroup.delimiter === "parenthesis" && body.delimiter === "brace"
        ? read(argumentsGroup.children)
        : undefined;
    return value === undefined
      ? undefined
      : { argumentsIndex, argumentsGroup, body, read: value };
  };
  /**
   * What the node at `index` dispatches: the macro its head resolves to,
   * where that head stands and which category it is invoked as -- or the
   * operand fold standing there, and what it builds.
   */
  const dispatchAt = (node: Syntax): Dispatch => {
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
        return next.delimiter === "parenthesis" || next.delimiter === "bracket";
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
        (previous.raw === "." || previous.raw === "?." || previous.raw === "#")
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
      if (parameters?.tag !== "group" || parameters.delimiter !== "parenthesis")
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
    /**
     * Whether this position heads what a decorator applies: the name after
     * `@`, which is an expression wherever the decorator stands. Before a
     * member it has the shape of the member -- `@log(1) m() {}` -- and was
     * read as the member's name, so the macro was never dispatched.
     */
    const decorates =
      output.at(-1)?.tag === "token" &&
      (output.at(-1) as TokenSyntax).raw === "@";
    const namesClassMember =
      category === "classElement" &&
      !decorates &&
      memberSoFar().nameFollows() &&
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
    // An operand fold builds one expression or one type, whichever this
    // position reads, as a macro standing here would be looked up.
    const fold = foldCarrier(node);
    if (fold !== undefined) {
      return {
        fold,
        reads: readsType
          ? "type"
          : category === "expr" ||
              category === "stmt" ||
              category === "item" ||
              classHeritageFollows(output) ||
              (!typeAliasInitializerFollows(output) &&
                (initializerFollows(output) || expressionRegion))
            ? "expr"
            : undefined,
      };
    }
    let resolvedMacro =
      node.tag === "token" && !namesSomethingElse && readsWalkedSpace
        ? resolveSpelling(
            node.raw,
            node.span.start,
            sourceOf(node),
            category,
            node,
          )
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
        node,
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
        node,
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
      (decorates ||
        classHeritageFollows(output) ||
        (!typeAliasInitializerFollows(output) &&
          (initializerFollows(output) || expressionRegion)))
    ) {
      resolvedMacro = resolveSpelling(
        node.raw,
        node.span.start,
        sourceOf(node),
        "expr",
        node,
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
        node,
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
    const spaceReadHere =
      resolvedMacro === undefined &&
      node.tag === "token" &&
      node.kind === "identifier"
        ? spaceRead()
        : undefined;
    if (
      spaceReadHere !== undefined &&
      node.tag === "token" &&
      !shadowsMacro(node.raw, spaceReadHere, node)
    ) {
      // Asked once, not once per candidate: this scan runs for every name
      // the walk cannot resolve, and `sourceOf` walks the origin graph.
      const writtenIn = sourceOf(node);
      const spelling = node.raw;
      const position = node.span.start;
      const elsewhere = macroSpaces.find(
        (candidate) =>
          candidate !== spaceReadHere &&
          resolveSpelling(spelling, position, writtenIn, candidate, node) !==
            undefined,
      );
      if (elsewhere !== undefined) {
        const diagnostic = expansionDiagnosticRegistry.create(
          wrongCategoryMacroCode,
          {
            primaryOrigin: options.diagnosticOrigin(node.origin),
            messageArguments: [node.raw, elsewhere, spaceReadHere],
          },
        );
        // A member's key is a declaration, not a reference: TypeScript never
        // resolves it, and asks about it only under `noImplicitAny`. Held for
        // it, the sentence was said nowhere else, and `interface I { Shape }`
        // declared a member `Shape: any` in silence over a macro declared
        // for another space. So it is said here.
        if (spaceReadHere === "typeMember") diagnostics.push(diagnostic);
        // Held rather than reported anywhere else. The expander knows the
        // macros and the bindings this module writes; it does not know
        // `lib.d.ts`, an ambient declaration or a `declare global`, so a name
        // it cannot account for is not thereby a name nothing defines.
        // Reporting on its own knowledge refused `type Halved = Partial<{ a:
        // number }>` in a module holding a macro spelled `Partial`. The
        // sentence goes to the side that resolves names, to be written where
        // that side says the name is missing.
        else holdForTypeScript(node, diagnostic);
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
     *
     * Looked up in the space the position reads rather than the space around
     * it is walked as, because the two are not the same: `type T = later;`
     * is walked as an item and reads a type, and asking the item space for a
     * type macro found nothing and said nothing -- leaving `Cannot find
     * name` as the whole account of a definition three lines below.
     */
    const spaceDefinedIn = spaceReadHere ?? category;
    if (
      resolvedMacro === undefined &&
      !namesSomethingElse &&
      node.tag === "token" &&
      node.kind === "identifier" &&
      !shadowsMacro(node.raw, spaceDefinedIn, node) &&
      lexicalModule.get(node.raw, spaceDefinedIn) !== undefined &&
      !isCoreForm(
        node.raw,
        spaceDefinedIn,
        coreFormKind(lexicalModule.get(node.raw, spaceDefinedIn)!.binding),
      )
    ) {
      holdForTypeScript(
        node,
        expansionDiagnosticRegistry.create(macroNotYetVisibleCode, {
          primaryOrigin: options.diagnosticOrigin(node.origin),
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
          category,
          node,
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
          category,
          node,
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
      const infix = activeModules
        .flatMap(({ operators }) => operators)
        .filter(
          ({ category: operatorCategory, fixity }) =>
            operatorCategory === category && fixity === "infix",
        );
      const spelled = infixSpellings(input, infix);
      const segmentEnd = spelled.segmentEnds[index + 1] ?? input.length;
      for (
        let at = firstAfter(spelled.positions, index);
        at < spelled.positions.length && spelled.positions[at]! < segmentEnd;
        at += 1
      ) {
        const candidateIndex = spelled.positions[at]!;
        const candidate = input[candidateIndex] as TokenSyntax;
        const matches = infix
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
        shadowsMacro(node.raw, "expr", node) ||
        shadowsMacro(node.raw, "type", node))
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
    return { macro, resolvedHeadIndex, resolvedCategory, resolvedSpelling };
  };
  while (index < input.length) {
    region.at = index;
    const node = input[index]!;
    enterPosition(node);
    const coreForm = coreFormAt(node);
    if (coreForm !== undefined) {
      const protectedCapture =
        coreForm.body.children.length === 1 &&
        coreForm.body.children[0]?.tag === "protected"
          ? coreForm.body.children[0]
          : undefined;
      const nested = yield* walkInside(
        scope,
        coreForm.body,
        nestedWalk(
          createSyntaxSequence(
            protectedCapture?.children ?? coreForm.body.children,
          ),
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
        ),
      );
      if (nested.syntax.length === 0) {
        currentEnvironment = nested.environment;
        index += coreForm.width;
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
      const coreSubstatement = substatementAt(output, output.length);
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
      // What a `#core` form writes is written here: the region read the
      // form as a marker and a group, and never saw the declaration in it.
      if (category === "stmt" || category === "item")
        declareInRun(
          region,
          coreSubstatement ? hoistedFrom(completed) : declaredBy(completed),
          hoistedFrom(completed),
          index,
        );
      currentEnvironment = nested.environment;
      index += coreForm.width;
      continue;
    }
    if (builtAccumulators.has(node)) {
      output.push(node);
      index += 1;
      continue;
    }
    const letForm = markedFormAt(node, "let", readLetBinding);
    if (letForm !== undefined) {
      const { argumentsIndex, argumentsGroup, body, read } = letForm;
      const value = yield* walkInside(
        scope,
        argumentsGroup,
        nestedWalk(
          createSyntaxSequence(read.value),
          currentEnvironment,
          "expr",
          parentInvocation,
          lexicalModule,
          contexts,
          false,
          recursiveBinding,
        ),
      );
      const expanded = yield* walkInside(
        scope,
        body,
        nestedWalk(
          body.children,
          value.environment,
          "expr",
          parentInvocation,
          lexicalModule,
          contexts,
          false,
          recursiveBinding,
        ),
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
    const parameterizeForm = markedFormAt(
      node,
      "parameterize",
      readParameterization,
    );
    if (parameterizeForm !== undefined) {
      const { argumentsIndex, body, read } = parameterizeForm;
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
        nested = yield* walkInside(
          scope,
          body,
          nestedWalk(
            body.children,
            currentEnvironment,
            category,
            parentInvocation,
            lexicalModule,
            contexts,
            false,
            recursiveBinding,
          ),
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
            expansionDiagnosticRegistry.create(unusedRequiredParameterCode, {
              primaryOrigin: origin,
              messageArguments: [read.spelling],
            }),
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
    const dispatch = dispatchAt(node);
    if ("fold" in dispatch) {
      const { fold, reads } = dispatch;
      index += 1;
      /**
       * What the operand fold standing here builds as `reads`: its initial template,
       * then each step with the accumulator before it filled in as one node,
       * walked and read as one expression or type in turn. A step holds the
       * accumulator built before it rather than the steps that built it, so a
       * fold of any length is walked one step deep.
       *
       * One that cannot be built is reported once, and stands as what it built
       * so far, read as one operand, so nothing around it is reported again.
       */
      const failed = (problem: string, built: readonly Syntax[]): Syntax => {
        reportFold(fold.marker, problem);
        return createProtectedSyntax({
          ...(node as ProtectedSyntax),
          id: options.allocateSyntaxId(),
          children: built.length > 0 ? built : [fold.marker],
        });
      };
      if (reads === undefined) {
        output.push(
          failed(
            `builds one expression or one type, and stands where ${category} syntax is written`,
            [],
          ),
        );
        continue;
      }
      const named = reads === "type" ? "one type" : "one expression";
      const accumulators: ProtectedSyntax[] = [];
      const links: (ChainLink | undefined)[] = [undefined];
      // How deep the accumulators nest: one level for each step that holds
      // the one before it without continuing its chain.
      let depth = 0;
      let folded: Syntax | undefined;
      for (const part of [fold.initial, ...fold.steps]) {
        const previous = accumulators.at(-1);
        const filled =
          previous === undefined
            ? { syntax: part.children, filled: 0 }
            : fillAccumulators(part.children, previous);
        const walked = yield* walkInside(
          scope,
          part,
          nestedWalk(
            filled.syntax,
            currentEnvironment,
            reads,
            parentInvocation,
            lexicalModule,
            contexts,
            false,
            recursiveBinding,
          ),
        );
        currentEnvironment = walked.environment;
        if (walked.syntax.length === 0) {
          folded = failed(
            `builds ${named}, and one of its steps built nothing`,
            [],
          );
          break;
        }
        let built: ProtectedSyntax;
        try {
          built = enforestSequence(
            walked.syntax,
            reads,
            lexicalModule,
            contexts,
          );
        } catch (error) {
          if (!(error instanceof EnforestationError)) throw error;
          folded = failed(
            `builds ${named}, and one of its steps built \`${error.syntaxText}\``,
            walked.syntax,
          );
          break;
        }
        if (previous !== undefined) {
          const link =
            filled.filled === 0 ? undefined : chainLink(built, previous);
          links.push(link);
          depth =
            filled.filled === 0 ? 0 : link === undefined ? depth + 1 : depth;
          if (depth > options.tracker.budget.maxNestingDepth)
            throw new ResourceLimitError(
              "nesting-depth",
              options.tracker.budget.maxNestingDepth,
              depth,
            );
        }
        builtAccumulators.add(built);
        accumulators.push(built);
      }
      output.push(
        folded ??
          wearingLayout(
            joinedChain(accumulators, links, options),
            fold.marker.leadingTrivia,
          ),
      );
      continue;
    }
    const { macro, resolvedHeadIndex, resolvedCategory, resolvedSpelling } =
      dispatch;
    // A bound reached during expansion is a fact about this file, so it is
    // reported against the invocation that reached it rather than thrown
    // past every caller. Left to escape, a macro that does not terminate
    // ended the build with a stack trace naming no file, no line and no
    // macro -- and it escaped the compiler session too, so every host
    // integration crashed the same way.
    if (
      macro !== undefined &&
      macro.parameter &&
      scope.abortedSpelling === undefined
    ) {
      const head = input[resolvedHeadIndex] ?? node;
      const headWidth = punctuationSpelled(macro.binding.spelling)
        ? (operatorWidthAt(input, resolvedHeadIndex, macro.binding.spelling) ??
          1)
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
          nested = yield nestedWalk(
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
          !boundsItself(replaced, undefined)
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
    if (macro !== undefined && scope.abortedSpelling === undefined) {
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
      const cursor = cursorAt(index);
      let replacementEnvironment: BindingEnvironment | undefined;
      let eraseReplacement = false;
      let result;
      try {
        const invocation = invokeMacroStepwise({
          ...options,
          bindingsDeclared: (bindings) => {
            declaredBindings.push(...bindings);
          },
          macro,
          cursor,
          category: resolvedCategory,
          contexts,
          followingScope: context,
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
        });
        let step = invocation.next();
        while (!step.done) {
          const request = step.value;
          let expanded: ProtectedSyntax;
          try {
            // A replacement may declare macros and ordinary syntax together,
            // so every `#syntax { ... }` in it is processed and removed and
            // whatever surrounds them carries on as the replacement.
            const remaining: Syntax[] = [];
            let declaredMacros = false;
            for (let cursor = 0; cursor < request.syntax.length; cursor += 1) {
              const marker = request.syntax[cursor]!;
              const body = request.syntax[cursor + 1];
              if (
                options.generatedDefinitions === undefined ||
                options.expansionStore === undefined ||
                scope.activeExpansionEnvironment === undefined ||
                marker.tag !== "token" ||
                marker.raw !== "#syntax" ||
                body?.tag !== "group" ||
                body.delimiter !== "brace"
              ) {
                remaining.push(marker);
                continue;
              }
              const within = definedWithin(marker);
              const generated = processGeneratedDefinitions({
                syntax: createSyntaxSequence([
                  addScopes(marker, within),
                  addScopes(body, within),
                ]),
                sourceId: options.generatedDefinitions.sourceId,
                phase: options.phase,
                definitionScopes: options.scopeStore.union(
                  marker.scopes,
                  within,
                ),
                origins: options.origins,
                store: options.expansionStore,
                environment: scope.activeExpansionEnvironment,
                allocateSyntaxId: options.allocateSyntaxId,
                allocateBindingId: options.allocateBindingId,
                diagnosticOrigin: options.diagnosticOrigin,
              });
              generatedDefinitionTraces.push(generated.trace);
              diagnostics.push(...generated.diagnostics);
              if (generated.accepted && generated.compiled !== undefined) {
                scope.activeExpansionEnvironment = generated.environment;
                activeModules.push(generated.compiled);
              }
              declaredMacros = true;
              cursor += 1;
            }
            if (declaredMacros && remaining.length === 0) {
              const marker = request.syntax[0]!;
              eraseReplacement = true;
              expanded = createProtectedSyntax({
                id: options.allocateSyntaxId(),
                span: spanEnvelope(request.syntax.map(({ span }) => span)),
                origin: marker.origin,
                scopes: marker.scopes,
                category: request.category,
                children: createSyntaxSequence(request.syntax),
              });
            } else {
              const syntax = declaredMacros
                ? createSyntaxSequence(remaining)
                : request.syntax;
              // Give a statement or item replacement its interior categories
              // before it is walked, so that a macro spliced into an
              // expression position inside it is recognized as an expression,
              // and so that where each of its statements begins and ends is
              // the reader's answer. Walked as tokens, a `tt` replay of
              // `g()` and a `function twice` on the line under it read the
              // function as an expression, for want of a `;` between them. A
              // replacement that does not yet parse as a statement list --
              // because it still holds an unexpanded invocation the parser
              // cannot place -- is walked raw exactly as before.
              const preEnforested = holdsStatementOperator(syntax)
                ? undefined
                : request.category === "stmt"
                  ? options.enforestStatements?.({
                      syntax,
                      contexts,
                      lexicalModule: macroModule,
                    })
                  : request.category === "item"
                    ? options.enforestItems?.({
                        syntax,
                        contexts,
                        lexicalModule: macroModule,
                      })
                    : undefined;
              const nested = yield nestedWalk(
                createSyntaxSequence(preEnforested ?? syntax),
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
              expanded = enforestSequence(
                nested.syntax,
                request.category,
                macroModule,
                contexts,
                node,
              );
            }
          } catch (error) {
            step = invocation.throw(error);
            continue;
          }
          step = invocation.next(expanded);
        }
        result = step.value;
      } catch (error) {
        const cycle = error instanceof ExpansionCycleError;
        if (!cycle && !(error instanceof ResourceLimitError)) throw error;
        const source = options.origins.selectPrimarySource(node.origin);
        if (source === undefined) throw error;
        scope.abortedSpelling = resolvedSpelling;
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
        if (result.explainsUnresolvedName)
          holdForTypeScript(node, result.diagnostic);
        else diagnostics.push(result.diagnostic);
        output.push(node);
        if (resolvedHeadIndex > index) suppressedHeadIndex = resolvedHeadIndex;
        index += 1;
        continue;
      }
      // The invocation's own leading trivia positioned it on the page, and
      // it is consumed along with the invocation. Handing it to the
      // replacement keeps the expansion where the call stood.
      // A body a statement heads is a scope of its own, which nothing after
      // it is in: `if (c) letBound twice;` binds nothing the `return` under it
      // writes, and the `else` after it is no more inside it.
      const substatement = substatementAt(output, output.length);
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
          !boundsItself(result.syntax.children, result.syntax.form);
        output.push(
          ...withLeadingTrivia(
            spliceWhole ? [result.syntax] : result.syntax.children,
            trivia,
          ),
        );
        // What an expansion declares in a list of statements or items is
        // declared in the block the list is, as if it had been written
        // where the invocation stood, and binds for the rest of the run.
        // The region was read before the run was walked, so it is told now.
        // Its scopes decide whom it binds: a name the template wrote binds
        // only names the template wrote, a name copied from the call site
        // keeps a use-site scope no later name carries, and a name
        // `#capture` published binds the call site's.
        if (
          result.syntax.category === "stmt" ||
          result.syntax.category === "item"
        )
          declareInRun(
            region,
            substatement
              ? hoistedFrom(result.syntax)
              : declaredBy(result.syntax),
            hoistedFrom(result.syntax),
            index,
          );
        if (!substatement)
          declareInRun(
            region,
            contractBindings(result.followingBindings),
            noBindings,
            index,
          );
      }
      currentEnvironment = replacementEnvironment ?? result.environment;
      if (!substatement) follow(result.cursor.index, result.followingScopes);
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
        (node.delimiter === "jsx-element" || node.delimiter === "jsx-fragment")
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
        const jsxChildren: Syntax[] = [];
        for (let at = 0; at < head; at += 1) {
          if (
            tag.typeArguments !== undefined &&
            at === tag.typeArguments.from + 1
          ) {
            // A generic element's type arguments are types, and a type macro
            // written among them resolves there like one written in any other
            // type argument list.
            const types = yield* walkInside(
              scope,
              node,
              nestedWalk(
                createSyntaxSequence(
                  node.children.slice(at, tag.typeArguments.to),
                ),
                currentEnvironment,
                "type",
                parentInvocation,
                lexicalModule,
                contexts,
                false,
                recursiveBinding,
              ),
            );
            currentEnvironment = types.environment;
            jsxChildren.push(...types.syntax);
            at = tag.typeArguments.to;
            if (at >= head) break;
          }
          const child = node.children[at]!;
          if (
            child.tag !== "group" ||
            (child.delimiter !== "brace" &&
              child.delimiter !== "jsx-element" &&
              child.delimiter !== "jsx-fragment")
          ) {
            jsxChildren.push(child);
            continue;
          }
          // An attribute's braces are an expression container, not an
          // object literal, so what is walked as an expression is what they
          // hold: walked whole, `title={c ? x : 1}` was split at its `:`
          // into a key and a value, and `x` was never expanded.
          if (child.delimiter === "brace") {
            const contents = yield* walkInside(
              scope,
              child,
              nestedWalk(
                child.children,
                currentEnvironment,
                "expr",
                parentInvocation,
                lexicalModule,
                contexts,
                false,
                recursiveBinding,
              ),
            );
            currentEnvironment = contents.environment;
            jsxChildren.push(
              createGroup({
                ...child,
                id: options.allocateSyntaxId(),
                children: contents.syntax,
              }),
            );
            continue;
          }
          const nested = yield nestedWalk(
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
          jsxChildren.push(...nested.syntax);
        }
        if (head < tail) {
          // The children are walked as one sequence so a macro invocation
          // can span several of them, the way a block form does.
          const nested = yield* walkInside(
            scope,
            node,
            nestedWalk(
              createSyntaxSequence(node.children.slice(head, tail)),
              currentEnvironment,
              "jsxChild",
              parentInvocation,
              lexicalModule,
              contexts,
              false,
              recursiveBinding,
            ),
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
        // A template literal holds expressions, and a template literal *type*
        // holds types: `` `get${string & K}` `` is a type, not an expression.
        // Reading every substitution as an expression made an ordinary
        // template literal type unreadable -- and at a use site it escaped as
        // a thrown error rather than a diagnostic, so one of them anywhere in
        // a file ended the whole compilation.
        const substitutionCategory: SyntaxCategory =
          category === "type" || typeFollows() ? "type" : "expr";
        for (const { run: substitution, separator } of separatedRuns(
          node.children,
          (child) =>
            child.tag === "token" &&
            (child.kind === "template-head" ||
              child.kind === "template-middle" ||
              child.kind === "template-tail"),
        )) {
          if (substitution.length > 0) {
            const enforested = enforestOrReport(
              createSyntaxSequence(substitution),
              substitutionCategory,
              lexicalModule,
              contexts,
            );
            const nested = yield* walkInside(
              scope,
              node,
              nestedWalk(
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
              ),
            );
            currentEnvironment = nested.environment;
            children.push(...nested.syntax);
          }
          if (separator !== undefined) children.push(separator);
        }
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
        for (const { run: segment, separator } of separatedRuns(
          node.children,
          spelledComma,
        )) {
          if (segment.length > 0) {
            const enforested = enforestOrReport(
              createSyntaxSequence(segment),
              "expr",
              lexicalModule,
              contexts,
            );
            const nested = yield* walkInside(
              scope,
              node,
              nestedWalk(
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
              ),
            );
            currentEnvironment = nested.environment;
            children.push(...nested.syntax);
          }
          if (separator !== undefined) children.push(separator);
        }
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
      // An enum body holds named members, each of them a name and, where
      // one is written, the value after its `=`. Walked as the items or
      // statements around it, the name stood at the head of one and was
      // dispatched: a declaration that never mentioned the macro was
      // rewritten into syntax TypeScript cannot read, or reported against.
      if (
        node.tag === "group" &&
        node.delimiter === "brace" &&
        braceOpens(walkedRun, output.length) === "enum"
      ) {
        const children: Syntax[] = [];
        for (const { run: member, separator } of commaSeparatedMembers(
          node.children,
          false,
        )) {
          const equals = member.findIndex(
            (child) => child.tag === "token" && child.raw === "=",
          );
          // What names the member, which means itself: a word or a string
          // key. A check for invocations left in the output is told so, or
          // it blames the member for a call that was never written.
          for (const name of equals < 0 ? member : member.slice(0, equals))
            if (name.tag === "token" && name.kind === "identifier")
              namedOrigins.add(name.origin);
          children.push(...(equals < 0 ? member : member.slice(0, equals + 1)));
          if (equals >= 0 && equals < member.length - 1) {
            const value = yield* walkInside(
              scope,
              node,
              expressionWalk(member.slice(equals + 1)),
            );
            currentEnvironment = value.environment;
            children.push(...value.syntax);
          }
          if (separator !== undefined) children.push(separator);
        }
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
      // A brace holds an object literal where the walk reads it as an
      // expression: the run itself is one, or the brace stands after the `=`
      // of an initializer or a default, whatever the run around it is
      // categorized as. Asked only of the run's own category, a literal
      // written in a block walked as tokens was descended into as an
      // expression all the same -- and there the key of each member stood
      // at the head of an expression and was dispatched as a macro.
      //
      // A function's body is a block wherever the function stands, and
      // its `:` is a label's: read as a literal, `() => { done: f(); }` was
      // walked as one member named `done`.
      //
      // A literal holding only shorthand properties is one too, unless it is
      // the pattern of an assignment, where each name is a target.
      if (
        node.tag === "group" &&
        node.delimiter === "brace" &&
        (category === "expr" ||
          initializerFollows(output) ||
          operandBraceFollows(output, node)) &&
        !typeFollows() &&
        braceOpens(walkedRun, output.length) === "other" &&
        (node.children.some(
          (child) => child.tag === "token" && child.raw === ":",
        ) ||
          !assignmentPatternAt(input, index))
      ) {
        const members = commaSeparatedMembers(node.children, true);
        const pattern = assignmentPatternAt(input, index);
        const children: Syntax[] = [];
        for (const { run, separator } of members) {
          const colon = run.findIndex(
            (child) => child.tag === "token" && child.raw === ":",
          );
          const method =
            colon >= 0 &&
            run
              .slice(0, colon)
              .some(
                (child) =>
                  child.tag === "group" && child.delimiter === "parenthesis",
              );
          if (colon >= 0 && !method) {
            // A property name is not an expression, but a computed one holds
            // one inside its brackets.
            for (const child of run.slice(0, colon + 1)) {
              if (child.tag !== "group" || child.delimiter !== "bracket") {
                if (child.tag === "token" && child.kind === "identifier")
                  namedOrigins.add(child.origin);
                children.push(child);
                continue;
              }
              const key = yield* walkInside(
                scope,
                child,
                nestedWalk(
                  child.children,
                  currentEnvironment,
                  "expr",
                  parentInvocation,
                  lexicalModule,
                  contexts,
                  false,
                  recursiveBinding,
                ),
              );
              currentEnvironment = key.environment;
              children.push(
                createGroup({
                  ...child,
                  id: options.allocateSyntaxId(),
                  children: key.syntax,
                }),
              );
            }
            if (colon < run.length - 1) {
              const value = yield* walkInside(
                scope,
                node,
                expressionWalk(run.slice(colon + 1)),
              );
              currentEnvironment = value.environment;
              children.push(...value.syntax);
            }
          } else if (!pattern && shorthandProperty(run)) {
            // `{ x }` is `{ x: x }`: the name is the key, and as the value it
            // is an expression like any other. Where it is a macro its
            // expansion is the value and the name stays the key -- spliced
            // in its place, `{ x }` became `{ 99 }`, which is not an object
            // literal at all.
            const name = run[0];
            const value = yield* walkInside(scope, node, expressionWalk(run));
            currentEnvironment = value.environment;
            // An ordinary name walks to itself, perhaps wrapped as the
            // expression it was read as, and is written as it was.
            let only: Syntax | undefined =
              value.syntax.length === 1 ? value.syntax[0] : undefined;
            while (only?.tag === "protected" && only.children.length === 1)
              only = only.children[0];
            if (
              only?.tag === "token" &&
              only.raw === name.raw &&
              only.origin === name.origin
            )
              children.push(...value.syntax);
            else {
              namedOrigins.add(name.origin);
              children.push(
                name,
                createToken({
                  id: options.allocateSyntaxId(),
                  span: { start: name.span.end, end: name.span.end },
                  origin: name.origin,
                  scopes: name.scopes,
                  kind: "punctuation",
                  raw: ":",
                  leadingTrivia: [],
                }),
                ...value.syntax,
              );
            }
          } else if (run.length > 0) {
            const value = yield* walkInside(
              scope,
              node,
              expressionWalk(run, true),
            );
            currentEnvironment = value.environment;
            children.push(...value.syntax);
          }
          if (separator !== undefined) children.push(separator);
        }
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
        /** The walk of `nodes` as `as`, in the contexts of the pattern. */
        const patternWalk = (
          nodes: readonly Syntax[],
          as: SyntaxCategory,
        ): WalkRequest =>
          nestedWalk(
            createSyntaxSequence(nodes),
            currentEnvironment,
            as,
            parentInvocation,
            lexicalModule,
            patternContexts,
            false,
            recursiveBinding,
          );
        const named = (child: Syntax): Syntax => {
          if (child.tag === "token" && child.kind === "identifier")
            namedOrigins.add(child.origin);
          return child;
        };
        const spelt = (child: Syntax | undefined, raw: string): boolean =>
          child?.tag === "token" && child.raw === raw;
        const children: Syntax[] = [];
        for (const { run: entry, separator } of separatedRuns(
          node.children,
          spelledComma,
        )) {
          let at = 0;
          if (spelt(entry[at], "...")) {
            children.push(entry[at]!);
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
              if (child.tag !== "group" || child.delimiter !== "bracket") {
                children.push(named(child));
                continue;
              }
              const key =
                child.children.length === 0
                  ? undefined
                  : yield* walkInside(
                      scope,
                      child,
                      patternWalk(child.children, "expr"),
                    );
              if (key !== undefined) currentEnvironment = key.environment;
              children.push(
                createGroup({
                  ...child,
                  id: options.allocateSyntaxId(),
                  children: createSyntaxSequence(key?.syntax ?? []),
                }),
              );
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
            if (child.tag !== "group") {
              children.push(named(child));
              continue;
            }
            const pattern = yield patternWalk([child], "binding");
            currentEnvironment = pattern.environment;
            children.push(...pattern.syntax);
          }
          if (equals >= 0) {
            children.push(entry[equals]!);
            if (equals < entry.length - 1) {
              const value = yield* walkInside(
                scope,
                node,
                patternWalk(entry.slice(equals + 1), "expr"),
              );
              currentEnvironment = value.environment;
              children.push(...value.syntax);
            }
          }
          if (separator !== undefined) children.push(separator);
        }
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
      // A parenthesis group with `=>` after it, where a type is written, is
      // the parameter list of a function type or a constructor type, unless
      // what it holds can only be a type: then it is a parenthesized return
      // type, and the `=>` is the arrow function's own. A parameter list
      // holds binders, not a type: read as a type, a parameter spelled like
      // a type macro was dispatched, and `(T: number) => void` was emitted
      // as `(number: number) => void`.
      const next = input[index + 1];
      const functionTypeParameters =
        node.tag === "group" &&
        node.delimiter === "parenthesis" &&
        (category === "type" || typeGroupFollows) &&
        next?.tag === "token" &&
        next.raw === "=>" &&
        readTypeParenthesis(node) !== "type";
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
                    computedMemberNameFollows(memberSoFar(), node)
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
                        : functionTypeParameters
                          ? "binding"
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
      const enclosingExpansionEnvironment = scope.activeExpansionEnvironment;
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
        (((node.tag === "group" && node.delimiter === "brace") || soleBrace) &&
          braceOpens(walkedRun, output.length) === "function")
          ? { names: [] }
          : undefined;
      if (frame !== undefined) liftFrames.push(frame);
      // One unit of a list of statements or items is not a block, so what
      // expansions inside it declared is declared in the run it stands in,
      // and what follows it there follows them; a block keeps all but its
      // `var`s. A function's body, a class's and a namespace's keep
      // everything. A class or interface member declares nothing a later
      // member can see.
      // A body a statement heads is a scope of its own, and passes up only
      // its `var`s, as a block does.
      const bodyOfStatement =
        node.tag === "protected" &&
        (node.category === "stmt" || node.category === "item") &&
        substatementAt(output, output.length);
      const declaresAround =
        node.tag === "protected" &&
        (node.category === "stmt" || node.category === "item") &&
        (!braceBody(node) ||
          braceHeader(walkedRun, output.length) === otherBrace) &&
        !bodyOfStatement;
      const blockOfStatements =
        node.tag === "group" &&
        node.delimiter === "brace" &&
        braceHeader(walkedRun, output.length) === otherBrace;
      let nested;
      try {
        const request = nestedWalk(
          createSyntaxSequence(classMembers ?? statementBody ?? node.children),
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
            (node.delimiter === "parenthesis" || node.delimiter === "bracket"),
          declaresAround ? context : undefined,
          node.tag === "group" &&
            node.delimiter === "brace" &&
            bodyCategory === "classElement",
        );
        nested =
          node.tag === "group"
            ? yield* walkInside(scope, node, request)
            : yield request;
      } finally {
        if (frame !== undefined) liftFrames.pop();
      }
      if (opensBlock) {
        activeModules.length = enclosingModules;
        scope.activeExpansionEnvironment = enclosingExpansionEnvironment;
      }
      currentEnvironment = nested.environment;
      if (declaresAround) {
        declareInRun(region, nested.declared, nested.hoisted, index);
        follow(index + 1, nested.following);
      } else if (blockOfStatements || bodyOfStatement)
        declareInRun(region, nested.hoisted, nested.hoisted, index);
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
                          children: declaringFirst(child.children, frame.names),
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
    declared: bindingsOf(region.declared),
    hoisted: bindingsOf(region.hoisted),
    following: region.following,
  });
}

/**
 * The walk `request` asks for, of what `group` holds: one level deeper in the
 * nesting the expansion's budget bounds, for as long as it runs.
 *
 * A walk inside an invocation that reaches the limit ends that invocation,
 * which reports it against the macro. A walk outside any is reported at the
 * group, and leaves what the group holds as it was written: syntax nests that
 * deep only where expansion keeps nesting it, and nothing nested deeper is
 * expanded.
 */
function* walkInside(
  scope: ExpansionScope,
  group: Syntax,
  request: WalkRequest,
): Walk {
  const { tracker } = scope.options;
  try {
    tracker.enterNesting();
  } catch (error) {
    const [input, environment, , parentInvocation] = request;
    if (
      !(error instanceof ResourceLimitError) ||
      parentInvocation !== undefined
    )
      throw error;
    const origin = scope.primaryOrigin(group);
    if (origin === undefined) throw error;
    scope.diagnostics.push(
      expansionDiagnosticRegistry.create(expansionLimitCode, {
        primaryOrigin: origin,
        messageArguments: ["the syntax nested here", error.kind],
      }),
    );
    return {
      syntax: input,
      environment,
      declared: scope.noBindings,
      hoisted: scope.noBindings,
      following: scope.options.scopeStore.empty(),
    };
  }
  try {
    return yield request;
  } finally {
    tracker.leaveNesting();
  }
}

export function expandMacroSyntax(
  options: ExpandMacroSyntaxOptions,
): ExpandMacroSyntaxResult {
  const scope = createExpansionScope(options);
  const {
    activeModules,
    afterDirectives,
    diagnostics,
    enforestSequence,
    generatedDefinitionTraces,
    liftFrames,
    liftedDeclaration,
    namedOrigins,
    offeredOperators,
    traces,
    unresolvedNameExplanations,
    declaredBindings,
  } = scope;
  // A module is where a `#let` outside any function declares its variable.
  const moduleFrame: LiftFrame | undefined =
    options.category === "item" ? { names: [] } : undefined;
  if (moduleFrame !== undefined) liftFrames.push(moduleFrame);
  let visited;
  try {
    visited = walkToEnd(
      scope,
      nestedWalk(
        options.syntax,
        options.environment,
        options.category,
        options.parentInvocation,
        options.module,
        options.contexts ?? new Set(),
      ),
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
    declaredBindings: Object.freeze(declaredBindings),
    generatedDefinitionTraces: Object.freeze(generatedDefinitionTraces),
    generatedModules: Object.freeze(activeModules.slice(1)),
    expansionEnvironment: scope.activeExpansionEnvironment,
    offeredOperators,
    namedOrigins,
  });
}
