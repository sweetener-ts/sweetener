import { CaptureSlashMisreads } from "./capture-slash-misreads.js";
import { EnforestationError } from "./enforestation-error.js";
import {
  expansionCycleCode,
  expansionDiagnosticRegistry,
  expansionLimitCode,
  unexpandedOperatorCode,
  unparameterizedSyntaxParameterCode,
  unreadableItemCode,
  unreadItemCode,
} from "./diagnostics.js";
import {
  coreExpressionOperators,
  createConsumerSuite,
  foldMacroOperatorChain,
  StopSet,
  type ConsumerContext,
  type ConsumerFailure,
  type MacroOperatorApplication,
  type MacroOperatorChain,
  type SlashMisreadListener,
  type SyntaxConsumer,
} from "@sweetener/enforestation";
import type {
  BindingEnvironment,
  EnvironmentStore,
  Phase,
  ScopeStore,
} from "@sweetener/hygiene";
import {
  createSyntaxClassConsumer,
  type SyntaxClassConsumer,
} from "@sweetener/pattern";
import {
  ResourceLimitError,
  type BindingId,
  type EnvironmentEpoch,
  type InvocationId,
  type OriginId,
  type ResourceTracker,
  type SourceId,
  type SyntaxClassId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createProtectedSyntax,
  createSyntaxCursor,
  createSyntaxSequence,
  spanEnvelope,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
  type SyntaxSequence,
} from "@sweetener/syntax";
import type { CompileParsedMacrosResult } from "./compile-macros.js";
import type {
  CompiledMacroBinding,
  InvokeMacroOptions,
  MacroContext,
} from "./invocation.js";
import { ExpansionEnvironmentStore } from "./environment.js";
import { createMacroExtentResolver } from "./macro-extent.js";
import { processDefinitionContext } from "./definition-context.js";
import {
  createLexicalOperatorResolver,
  operatorInvocationSyntax,
  registerImportedOperator,
} from "./operator-dispatch.js";
import { invokeMacro, type MacroTraceEvent } from "./invocation.js";
import {
  boundsItself,
  expandMacroSyntax,
  operatorWidthAt,
  type ExpandMacroSyntaxOptions,
  type ExpandMacroSyntaxResult,
} from "./recursive-expander.js";
import { ExpansionCycleError, type ExpansionGuard } from "./progress.js";
import { joinedChain, type ChainLink } from "./chain-joining.js";
import { coreFormKind, isCoreForm } from "./core-shadowing.js";
import {
  alreadyNormal,
  handedIn,
  normalizeProtectedInput,
  type NormalizedSyntax,
} from "./normalized-syntax.js";
import type { CoreDispatchTrace } from "./core-shadowing.js";

export interface CreateExpansionFrontendSessionOptions {
  readonly module: CompileParsedMacrosResult;
  readonly modules?: readonly CompileParsedMacrosResult[] | undefined;
  readonly importedBindings?:
    ReadonlyMap<string, CompiledMacroBinding> | undefined;
  readonly importsByModule?:
    | ReadonlyMap<
        CompileParsedMacrosResult,
        ReadonlyMap<string, CompiledMacroBinding>
      >
    | undefined;
  readonly importOriginsByModule?:
    | ReadonlyMap<CompileParsedMacrosResult, ReadonlyMap<BindingId, OriginId>>
    | undefined;
  /** Imported bindings explicitly authorized to intercept pinned core forms. */
  readonly coreShadowBindingsByModule?:
    ReadonlyMap<CompileParsedMacrosResult, ReadonlySet<BindingId>> | undefined;
  readonly matchesBindingLiteral?:
    InvokeMacroOptions["matchesBindingLiteral"] | undefined;
  readonly isMacroVisible?:
    | ((request: {
        readonly lexicalModule: CompileParsedMacrosResult;
        readonly spelling: string;
        readonly macro: CompiledMacroBinding;
        readonly position: number;
        /**
         * Source `position` belongs to, when it is known. Absent means the
         * caller could not attribute the position to a source and the
         * definition-order rule should be applied as before.
         */
        readonly positionSourceId?: SourceId | undefined;
      }) => boolean)
    | undefined;
  readonly sourceId: SourceId;
  readonly phase: Phase;
  readonly scopeStore: ScopeStore;
  readonly origins: OriginStore;
  readonly environments: EnvironmentStore;
  readonly environment?: BindingEnvironment | undefined;
  readonly tracker: ResourceTracker;
  readonly guard: ExpansionGuard;
  readonly allocateSyntaxId: () => SyntaxId;
  readonly allocateBindingId: () => BindingId;
  readonly allocateInvocationId: () => InvocationId;
  /**
   * Told of a slash the reader read the other way from the grammar, which
   * only reading the source again reads as the grammar does (see
   * `SlashMisreadListener`). What a macro rule's capture finds is told once
   * its invocation settles on it (see `CaptureSlashMisreads`).
   */
  readonly slashMisread?: SlashMisreadListener | undefined;
}

/**
 * The words that begin a module item and nothing else.
 *
 * Recovery ends the damage where one of them begins a line, so that a file
 * whose remaining semicolons all sit inside braces does not have the whole
 * rest of itself swallowed by one unreadable item. The same set says which
 * recovered runs are worth reporting: a run beginning at one of these words is
 * a declaration the reader should have read, while syntax written in some
 * other shape -- a macro invoked after its first operand, say -- begins with
 * whatever that operand begins with.
 */
const definiteItemStarts: ReadonlySet<string> = new Set([
  "abstract",
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
  "type",
  "var",
]);

/**
 * The text of syntax for a diagnostic, spaced where the source spaced it. The
 * scanner splits punctuation it does not know, so joining every token with a
 * space reported an operator written `|>` as `| >`.
 */
function diagnosticSyntaxText(syntax: readonly Syntax[]): string {
  let text = "";
  const write = (token: Syntax & { readonly tag: "token" }): void => {
    if (text.length > 0 && token.leadingTrivia.length > 0) text += " ";
    text += token.raw;
  };
  const visit = (node: Syntax): void => {
    if (node.tag === "token") {
      write(node);
      return;
    }
    if (node.tag === "group") write(node.open);
    for (const child of node.children) visit(child);
    if (node.tag === "group" && node.close.tag === "token") write(node.close);
  };
  for (const node of syntax) visit(node);
  return text;
}

/**
 * The routes by which the expander asks the reader to read syntax for it.
 * Each answers with `NormalizedSyntax`, so each normalizes what it reads.
 */
export type ReadingRoutes = {
  readonly [
    Route in
      | "enforest"
      | "enforestExpression"
      | "enforestStatements"
      | "enforestItems"
      | "enforestJsxChildren"
      | "enforestTypeMembers"
      | "enforestClassElements"
  ]-?: NonNullable<ExpandMacroSyntaxOptions[Route]>;
};

export interface ExpansionFrontendSession {
  readonly consumeClass: SyntaxClassConsumer;
  readonly environment: BindingEnvironment;
  /** The routes `expand` hands the expander, the same ones it reads through. */
  readonly routes: ReadingRoutes;
  expand(
    syntax: SyntaxSequence,
    category?: SyntaxCategory,
  ): ExpandMacroSyntaxResult;
}

/** What an expansion of a chain of operators built, and what it holds. */
interface OperatorChainStep {
  /**
   * The expansion it holds as built on the side the chain's associativity
   * builds on: the one to its left in a left-associative chain, to its right
   * in a right-associative one.
   */
  readonly holds: ProtectedSyntax | undefined;
  /**
   * The level of the core operators of the chain's associativity that its
   * replacement is a chain of, with what it holds at the end the chain
   * builds on, where it is one.
   */
  readonly level: number | undefined;
  /** Whether it continues the chain the expansion it holds is. */
  readonly linked: boolean;
  /** How deep it nests, through every step before it that it holds. */
  readonly depth: number;
}

/**
 * Whether `node` is an operand on its own wherever it stands: an expression
 * read as one, a parenthesized or bracketed group, a template literal, a name
 * or a literal. Nothing beside it can bind into it or read it on.
 */
function standsWhole(node: Syntax | undefined): boolean {
  if (node === undefined) return false;
  if (node.tag === "protected") return node.category === "expr";
  if (node.tag === "group")
    return (
      (node.delimiter === "parenthesis" && node.children.length > 0) ||
      node.delimiter === "bracket" ||
      node.delimiter === "template"
    );
  return (
    node.tag === "token" &&
    (node.kind === "identifier" ||
      node.kind === "numeric-literal" ||
      node.kind === "string-literal")
  );
}

/**
 * The level of the core operators of `associativity` that `children` chains
 * its operands with, where it is one such chain with `end` at the end the
 * associativity builds on -- its head for a left-associative chain, its tail
 * for a right-associative one -- or, with no `end`, an operand that stands
 * whole there, and every other operand stands whole and every operator is
 * one token. Such a chain reads as written whatever stands around it, which
 * is what lets a chain of operator expansions be opened into one.
 */
function operatorChainLevel(
  children: readonly Syntax[],
  end: Syntax | undefined,
  associativity: "left" | "right",
): number | undefined {
  if (children.length < 3 || children.length % 2 === 0) return undefined;
  const at = associativity === "left" ? 0 : children.length - 1;
  if (end === undefined ? !standsWhole(children[at]) : children[at] !== end)
    return undefined;
  let level: number | undefined;
  for (let operator = 1; operator < children.length; operator += 2) {
    const token = children[operator]!;
    const operand =
      children[associativity === "left" ? operator + 1 : operator - 1];
    if (token.tag !== "token" || !standsWhole(operand)) return undefined;
    const core = coreInfixOperators.get(token.raw);
    if (core?.associativity !== associativity) return undefined;
    if (level !== undefined && core.precedence !== level) return undefined;
    level = core.precedence;
  }
  return level;
}

const coreInfixOperators = new Map(
  coreExpressionOperators
    .filter(({ fixity }) => fixity === "infix")
    .map((operator) => [operator.spelling, operator] as const),
);

/** The operands and operators of `chain` as they were written. */
function writtenChain(chain: MacroOperatorChain): readonly Syntax[] {
  const written: Syntax[] = [chain.left];
  for (const step of chain.steps) written.push(...step.operator, step.right);
  return written;
}

/**
 * How many groups enclose `operand` in `children`, where it stands in them.
 * What the operand holds is not looked into, so asking costs what the
 * replacement holds beside it.
 */
function groupsAround(operand: Syntax, children: readonly Syntax[]): number {
  const pending: { readonly node: Syntax; readonly groups: number }[] =
    children.map((node) => ({ node, groups: 0 }));
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, groups } = next;
    if (node === operand) return groups;
    if (node.tag !== "group" && node.tag !== "protected") continue;
    for (const child of node.children)
      pending.push({
        node: child,
        groups: node.tag === "group" ? groups + 1 : groups,
      });
  }
  return 0;
}

/**
 * Production assembly for the category consumers required by declarative
 * expansion. Acceptance tests and hosts share this path instead of rebuilding
 * a subtly different matcher/enforestation stack.
 */
export function createExpansionFrontendSession(
  options: CreateExpansionFrontendSessionOptions,
): ExpansionFrontendSession {
  const modules = options.modules ?? [options.module];
  if (modules.length === 0)
    throw new RangeError("Expansion frontend requires at least one module");
  const expansionStore = new ExpansionEnvironmentStore();
  const captureMisreads = new CaptureSlashMisreads(options.slashMisread);
  const operatorTraces: MacroTraceEvent[] = [];
  /** Operator tokens offered to their rules while an expression was read. */
  const offeredOperatorTokens = new Set<OriginId>();
  /**
   * Where operators no rule accepted were written. What stands in their
   * operands was never given a meaning by the rule that would have given it
   * one -- a pipe's `%` -- so a use reported there repeats the one error.
   */
  const refusedOperatorSpans: {
    readonly sourceId: SourceId;
    readonly start: number;
    readonly end: number;
  }[] = [];
  const operatorDiagnostics: ExpandMacroSyntaxResult["diagnostics"][number][] =
    [];
  /**
   * The operators whose expansion reached a limit in the syntax being
   * expanded. None of them is expanded again there, as a macro whose
   * invocation reached one is not.
   */
  const abortedOperators = new Set<BindingId>();
  /** What an operator's expansion built, as opposed to what it refused. */
  const operatorExpansions = new WeakSet<Syntax>();
  /**
   * What an operator invocation can say about a name it left standing, held
   * for the side that resolves names. Separate from the operator list for the
   * same reason the expander keeps its own two apart: which names a program
   * declares is TypeScript's to answer.
   */
  const operatorNameExplanations: ExpandMacroSyntaxResult["diagnostics"][number][] =
    [];
  /**
   * Reported when recovery passed syntax through that still invokes a macro.
   * Separate from the operator list only so that resetting one per expansion
   * does not depend on the other.
   */
  const recoveryDiagnostics: ExpandMacroSyntaxResult["diagnostics"][number][] =
    [];
  const expansionEnvironmentByModule = new Map(
    modules.map((module) => {
      let moduleEnvironment = processDefinitionContext({
        store: expansionStore,
        environment: expansionStore.createRoot(),
        items: module.definitions.map(({ definition, macro, operator }) => ({
          kind: "macro-definition" as const,
          definition,
          binding: macro.binding,
          operator,
        })),
        validate: () => Object.freeze({ diagnostics: Object.freeze([]) }),
      }).environment;
      const localBindings = new Set(
        module.macros.map(({ binding }) => binding.id),
      );
      for (const imported of options.importsByModule?.get(module)?.values() ??
        []) {
        if (localBindings.has(imported.binding.id)) continue;
        const operator = modules
          .flatMap(({ operators }) => operators)
          .find(({ binding }) => binding === imported.binding.id);
        if (operator !== undefined) {
          const registered = registerImportedOperator({
            store: expansionStore,
            environment: moduleEnvironment,
            operator,
            importOrigin:
              options.importOriginsByModule
                ?.get(module)
                ?.get(imported.binding.id) ?? imported.binding.declaration,
            diagnosticOrigin: (origin) => {
              const selected = options.origins.selectPrimarySource(origin);
              return {
                sourceId: selected?.sourceId ?? options.sourceId,
                start: selected?.span.start ?? 0,
                end: selected?.span.end ?? 0,
                originId: origin,
              };
            },
          });
          moduleEnvironment = registered.environment;
          operatorDiagnostics.push(...registered.diagnostics);
        }
      }
      return [module, moduleEnvironment] as const;
    }),
  );
  const expansionEnvironment = expansionEnvironmentByModule.get(
    options.module,
  )!;
  const environment = options.environment ?? options.environments.createRoot();
  const shared = {
    origins: options.origins,
    allocateSyntaxId: options.allocateSyntaxId,
  };
  const classConsumerByBinding = new Map<BindingId, SyntaxClassConsumer>();
  const classConsumerByModule = new Map<
    CompileParsedMacrosResult,
    SyntaxClassConsumer
  >();
  /**
   * Module whose macros are in scope while a nested body is enforested. The
   * syntax may have come from another module's template, where that module's
   * macros are the ones in scope rather than the consuming file's.
   */
  let enforestingModule: CompileParsedMacrosResult | undefined;
  const resolve = (
    spelling: string,
    category: SyntaxCategory,
    lexicalModule = enforestingModule ?? options.module,
    position = Number.POSITIVE_INFINITY,
    positionSourceId?: SourceId | undefined,
  ) => {
    const imports =
      options.importsByModule?.get(lexicalModule) ??
      (lexicalModule === options.module ? options.importedBindings : undefined);
    const imported = imports?.get(spelling);
    const selected =
      imported?.category === category
        ? imported
        : lexicalModule.get(spelling, category);
    if (
      selected === undefined ||
      options.isMacroVisible?.({
        lexicalModule,
        spelling,
        macro: selected,
        position,
        ...(positionSourceId === undefined ? {} : { positionSourceId }),
      }) === false
    )
      return undefined;
    if (!isCoreForm(spelling, category, coreFormKind(selected.binding)))
      return selected;
    const local = lexicalModule.macros.some(
      ({ binding }) => binding.id === selected.binding.id,
    );
    if (local)
      return lexicalModule.definitions.some(
        ({ definition, macro }) =>
          macro.binding.id === selected.binding.id &&
          definition.shadowsCore &&
          isCoreForm(spelling, category, coreFormKind(selected.binding)),
      )
        ? selected
        : undefined;
    return options.coreShadowBindingsByModule
      ?.get(lexicalModule)
      ?.has(selected.binding.id)
      ? selected
      : undefined;
  };
  const coreInterception = (
    macro: CompiledMacroBinding,
    lexicalModule: CompileParsedMacrosResult,
    spelling: string,
  ): CoreDispatchTrace | undefined => {
    if (!isCoreForm(spelling, macro.category, coreFormKind(macro.binding)))
      return undefined;
    const local = lexicalModule.macros.some(
      ({ binding }) => binding.id === macro.binding.id,
    );
    const importOrigin = options.importOriginsByModule
      ?.get(lexicalModule)
      ?.get(macro.binding.id);
    const authorized = local
      ? lexicalModule.definitions.some(
          ({ definition, macro: candidate }) =>
            candidate.binding.id === macro.binding.id && definition.shadowsCore,
        )
      : options.coreShadowBindingsByModule
          ?.get(lexicalModule)
          ?.has(macro.binding.id) === true;
    if (!authorized) return undefined;
    return Object.freeze({
      spelling,
      category: macro.category,
      phase: options.phase,
      environmentEpoch:
        expansionEnvironmentByModule.get(lexicalModule)?.epoch ??
        expansionEnvironment.epoch,
      candidates: Object.freeze([macro.binding.id]),
      authorized: Object.freeze([macro.binding.id]),
      selected: macro.binding.id,
      decision: "shadow-macro",
      definitionOrigin: macro.binding.declaration,
      importOrigin,
    });
  };
  let hygieneEnvironment = environment;
  /** An operator invocation as it was written, which nothing expanded. */
  const unexpandedOperator = (invocation: readonly Syntax[]): ProtectedSyntax =>
    createProtectedSyntax({
      id: options.allocateSyntaxId(),
      span: spanEnvelope(invocation.map(({ span }) => span)),
      origin:
        invocation.length === 1
          ? invocation[0]!.origin
          : options.origins.composed(invocation.map(({ origin }) => origin)),
      scopes: invocation[0]!.scopes,
      category: "expr",
      children: createSyntaxSequence(invocation),
    });
  /**
   * Reports an operator whose expansion reached a limit or repeated itself,
   * where it is written, as an invocation that does is reported, and leaves
   * it unexpanded in the rest of the syntax being expanded.
   */
  const reportOperatorLimit = (
    error: ResourceLimitError | ExpansionCycleError,
    binding: BindingId,
    spelling: string,
    operator: readonly Syntax[],
  ): void => {
    const source = options.origins.selectPrimarySource(operator[0]!.origin);
    abortedOperators.add(binding);
    operatorDiagnostics.push(
      expansionDiagnosticRegistry.create(
        error instanceof ExpansionCycleError
          ? expansionCycleCode
          : expansionLimitCode,
        {
          primaryOrigin: {
            sourceId: source?.sourceId ?? options.sourceId,
            start: source?.span.start ?? 0,
            end: source?.span.end ?? 0,
            originId: operator[0]!.origin,
          },
          messageArguments:
            error instanceof ExpansionCycleError
              ? [spelling]
              : [spelling, error.kind],
        },
      ),
    );
  };
  /**
   * A chain of infix operators of one level, expanded as one expression.
   *
   * Each operator is expanded with what the one before it built held as the
   * one operand it is, as it was built: it is neither read again nor copied,
   * so each step costs what it adds to the chain. A step whose replacement
   * goes on with the chain of left-associative core operators that the
   * operand it holds is joins it, as a fold's step joins its accumulator:
   * `$a + $b` over `a <+> b <+> c` builds `a + b + c` as one node, and a chain
   * of any length nests no deeper than one step's operators do. Any other
   * step holds the operand one level deeper, or as many as the groups its
   * replacement writes around it.
   *
   * A chain whose expansion reaches a limit -- nests deeper than the nesting
   * limit, or reaches one in an operator's own expansion -- is reported at
   * the operator that reached it, as a fold that cannot be built is, and
   * stands as what it built before that, or as the operand it begins with
   * where it built nothing. A chain of an operator that reached a limit
   * earlier in the syntax being expanded is not expanded, and stands as it
   * was written.
   */
  const expandOperatorChain = (
    chain: MacroOperatorChain,
    apply: (
      application: MacroOperatorApplication,
      built: ReadonlySet<Syntax>,
    ) => ProtectedSyntax,
  ): ProtectedSyntax => {
    if (chain.steps.some(({ macro }) => abortedOperators.has(macro.binding)))
      return unexpandedOperator(writtenChain(chain));
    const steps = new Map<ProtectedSyntax, OperatorChainStep>();
    const limit = options.tracker.budget.maxNestingDepth;
    let lastBuilt: ProtectedSyntax | undefined;
    const folded = foldMacroOperatorChain(chain, (application) => {
      const built = new Set<ProtectedSyntax>();
      if (application.builtLeft && steps.has(application.left))
        built.add(application.left);
      if (application.builtRight && steps.has(application.right))
        built.add(application.right);
      const binding = application.step.macro.binding;
      const result = apply(application, built);
      if (abortedOperators.has(binding)) return undefined;
      // A refused operator holds what was built before it as written, and
      // nothing holds that as built again.
      if (!operatorExpansions.has(result))
        return built.size === 0
          ? result
          : createProtectedSyntax({
              ...result,
              id: options.allocateSyntaxId(),
              children: result.children.map((child) =>
                child.tag === "protected" && steps.has(child)
                  ? joinedOperatorChain(child, steps, chain.associativity)
                  : child,
              ),
            });
      const side =
        chain.associativity === "right" ? application.right : application.left;
      const holds = built.has(side) ? side : undefined;
      const level =
        chain.associativity === "none"
          ? undefined
          : operatorChainLevel(result.children, holds, chain.associativity);
      const linked =
        level !== undefined &&
        holds !== undefined &&
        steps.get(holds)?.level === level;
      // An expansion is one level deep in itself, and as deep again as what
      // it holds nests in it.
      let depth = 1;
      for (const operand of built)
        depth = Math.max(
          depth,
          steps.get(operand)!.depth +
            (linked && operand === holds
              ? 0
              : Math.max(1, groupsAround(operand, result.children))),
        );
      if (depth > limit) {
        reportOperatorLimit(
          new ResourceLimitError("nesting-depth", limit, depth),
          binding,
          application.step.macro.spelling,
          application.step.operator,
        );
        return undefined;
      }
      steps.set(result, { holds, level, linked, depth });
      lastBuilt = result;
      return result;
    });
    if (folded === undefined)
      return lastBuilt === undefined
        ? chain.left
        : joinedOperatorChain(lastBuilt, steps, chain.associativity);
    return steps.has(folded)
      ? joinedOperatorChain(folded, steps, chain.associativity)
      : folded;
  };
  /**
   * `last` with the expansions of its chain that continue the chain before
   * them opened into it, as `joinedChain` opens a fold's.
   */
  const joinedOperatorChain = (
    last: ProtectedSyntax,
    steps: ReadonlyMap<ProtectedSyntax, OperatorChainStep>,
    associativity: MacroOperatorChain["associativity"],
  ): ProtectedSyntax => {
    const built: ProtectedSyntax[] = [];
    for (
      let step: ProtectedSyntax | undefined = last;
      step !== undefined;
      step = steps.get(step)?.holds
    )
      built.push(step);
    built.reverse();
    const links: (ChainLink | undefined)[] = built.map((step, at) =>
      at === 0 || !steps.get(step)!.linked
        ? undefined
        : associativity === "right"
          ? { before: step.children.slice(0, -1), after: [] }
          : { before: [], after: step.children.slice(1) },
    );
    return joinedChain(built, links, options);
  };
  const operatorResolverFor = (lexicalModule: CompileParsedMacrosResult) => {
    const visibleOperatorBindings = new Set([
      ...lexicalModule.macros.map(({ binding }) => binding.id),
      ...[
        ...(options.importsByModule?.get(lexicalModule)?.values() ??
          (lexicalModule === options.module
            ? (options.importedBindings?.values() ?? [])
            : [])),
      ].map(({ binding }) => binding.id),
    ]);
    for (const { definition, macro } of lexicalModule.definitions)
      if (
        definition.shadowsCore &&
        isCoreForm(
          macro.binding.spelling,
          macro.category,
          coreFormKind(macro.binding),
        )
      )
        visibleOperatorBindings.add(macro.binding.id);
    const authorizedImportedCore =
      options.coreShadowBindingsByModule?.get(lexicalModule) ?? new Set();
    return createLexicalOperatorResolver({
      module: Object.freeze({
        macros: Object.freeze(
          modules
            .flatMap(({ macros }) => macros)
            .filter(({ binding }) => visibleOperatorBindings.has(binding.id)),
        ),
        operators: Object.freeze(
          modules
            .flatMap(({ operators }) => operators)
            .filter(({ binding }) => visibleOperatorBindings.has(binding)),
        ),
      }),
      store: expansionStore,
      environment:
        expansionEnvironmentByModule.get(lexicalModule) ?? expansionEnvironment,
      phase: options.phase,
      category: "expr",
      shadowsCore: ({ binding: operatorBinding }) =>
        authorizedImportedCore.has(operatorBinding) ||
        lexicalModule.definitions.some(
          ({ definition, macro }) =>
            macro.binding.id === operatorBinding &&
            definition.shadowsCore &&
            isCoreForm(
              macro.binding.spelling,
              macro.category,
              coreFormKind(macro.binding),
            ),
        ),
      visible: (operator, cursor) => {
        const macro = modules
          .flatMap(({ macros }) => macros)
          .find(({ binding }) => binding.id === operator.binding);
        const written = cursor.peek();
        // Definition order is a comparison of offsets in one file. Without the
        // source of the operator's token, an operator a template writes would
        // be compared at its call-site offset against its definition's offset
        // in the module that defines it, and read as used above its definition
        // -- so a macro could not expand to an operator its call site has not
        // imported.
        const positionSourceId =
          written === undefined
            ? undefined
            : options.origins.selectPrimarySource(written.origin)?.sourceId;
        return (
          macro !== undefined &&
          options.isMacroVisible?.({
            lexicalModule,
            spelling: operator.spelling,
            macro,
            position: written?.span.start ?? Number.POSITIVE_INFINITY,
            ...(positionSourceId === undefined ? {} : { positionSourceId }),
          }) !== false
        );
      },
      expand: ({ macro, operator, input, built }) => {
        const invocation = operatorInvocationSyntax(
          input,
          operator.fixity,
          true,
          built,
        );
        for (const token of input.operator)
          offeredOperatorTokens.add(token.origin);
        if (abortedOperators.has(operator.binding))
          return unexpandedOperator(invocation);
        const consumeClass = classConsumerByBinding.get(macro.binding.id);
        if (consumeClass === undefined)
          throw new Error("operator syntax-class consumer is not initialized");
        let result;
        try {
          result = invokeMacro({
            macro,
            cursor: createSyntaxCursor(invocation),
            category: "expr",
            phase: options.phase,
            environmentEpoch: expansionEnvironment.epoch,
            consumeClass: inContexts(
              consumeClass,
              // The operator was read where its operands were; a `yield` or an
              // `await` among them is refused only where that reading refused
              // one.
              contextsOf(input.context),
            ),
            scopeStore: options.scopeStore,
            origins: options.origins,
            environments: options.environments,
            environment: hygieneEnvironment,
            tracker: options.tracker,
            guard: options.guard,
            coreInterception: coreInterception(
              macro,
              lexicalModule,
              operator.spelling,
            ),
            allocateSyntaxId: options.allocateSyntaxId,
            allocateBindingId: options.allocateBindingId,
            allocateInvocationId: options.allocateInvocationId,
            captureSlashMisreads: captureMisreads,
            // An operator expanded here is expanded while the expression
            // holding it is read, and the reading hands back an expression,
            // not the definition context around it: there is nothing following
            // the operator to give a binding's scope to.
            followingScope: () => {
              throw new Error(
                `Operator ${operator.spelling} binds a name in following syntax, but it was expanded while the expression holding it was read, where no syntax following it can be bound.`,
              );
            },
            // The parser has already decided what the operands are, so a rule
            // must account for all of them. Admitting a rule that matched a
            // prefix dropped the rest: with rules for `$v |> await` and
            // `$v |> $callee:expr`, `1 |> await g` expanded to `await 1`.
            admit: ({ cursor }) => cursor.atEnd,
            held: built,
            invokedAt: input.operator[0],
            diagnosticOrigin: (origin) => {
              const selected = options.origins.selectPrimarySource(origin);
              return {
                sourceId: selected?.sourceId ?? options.sourceId,
                start: selected?.span.start ?? 0,
                end: selected?.span.end ?? 0,
                originId: origin,
              };
            },
            expandReplacement: ({ syntax }) =>
              createProtectedSyntax({
                id: options.allocateSyntaxId(),
                span: spanEnvelope(syntax.map(({ span }) => span)),
                origin:
                  syntax.length === 1
                    ? syntax[0]!.origin
                    : options.origins.composed(
                        syntax.map(({ origin }) => origin),
                      ),
                scopes: syntax[0]!.scopes,
                category: "expr",
                children: createSyntaxSequence(syntax),
              }),
          });
        } catch (error) {
          if (!(
            error instanceof ResourceLimitError ||
            error instanceof ExpansionCycleError
          ))
            throw error;
          reportOperatorLimit(
            error,
            operator.binding,
            operator.spelling,
            input.operator,
          );
          return unexpandedOperator(invocation);
        }
        operatorTraces.push(result.trace);
        if (!result.expanded) {
          (result.explainsUnresolvedName
            ? operatorNameExplanations
            : operatorDiagnostics
          ).push(result.diagnostic);
          const sources = invocation
            .map(({ origin }) => options.origins.selectPrimarySource(origin))
            .filter((source) => source !== undefined);
          const first = sources[0];
          if (first !== undefined) {
            const written = sources.filter(
              ({ sourceId }) => sourceId === first.sourceId,
            );
            refusedOperatorSpans.push({
              sourceId: first.sourceId,
              start: Math.min(...written.map(({ span }) => span.start)),
              end: Math.max(...written.map(({ span }) => span.end)),
            });
          }
          return unexpandedOperator(invocation);
        }
        hygieneEnvironment = result.environment;
        operatorExpansions.add(result.syntax);
        return result.syntax;
      },
      expandChain: expandOperatorChain,
    });
  };
  const operatorResolvers = new Map(
    modules.map((module) => [module, operatorResolverFor(module)] as const),
  );
  let activeOperatorModule = options.module;
  const operatorResolver: ReturnType<typeof createLexicalOperatorResolver> = (
    cursor,
    fixity,
    consumerContext,
  ) =>
    operatorResolvers.get(activeOperatorModule)?.(
      cursor,
      fixity,
      consumerContext,
    );
  const extentResolver = createMacroExtentResolver({
    resolve: (spelling, category) => resolve(spelling, category),
    consumeClass: (macro) => {
      const consumer = classConsumerByBinding.get(macro.binding.id);
      if (consumer === undefined)
        throw new Error("macro syntax-class consumer is not initialized");
      return consumer;
    },
    matchesBindingLiteral: options.matchesBindingLiteral,
    ...shared,
  });
  /**
   * A statement operator has to be offered its statement before the ordinary
   * parse commits, because `a <- b` also reads as a comparison against a
   * negation. A run holding one is left for the expander to walk.
   */
  const holdsStatementOperator = (children: readonly Syntax[]): boolean => {
    const infix = modules
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
  // One place knows how the consumers meet, and both this session and the
  // enforestation tests come through it. Assembling them here as well let the
  // two drift: a harness without `consumeType` refused `const x = a as
  // string[];` that the pipeline reads.
  const {
    type,
    typeMember,
    classElement,
    expression,
    binding,
    statement,
    item,
    jsxChild,
  } = createConsumerSuite({
    ...shared,
    resolveMacro: extentResolver,
    resolveMacroOperator: operatorResolver,
    holdsStatementOperator,
  });
  /**
   * The contexts a capture being matched stands in. A capture is read by the
   * class consumer a module shares across every invocation, so the invocation
   * sets these around its match; without them a capture of `yield value`
   * inside a generator would be refused as a `yield` outside one.
   */
  let captureContexts: ReadonlySet<MacroContext> = new Set();
  const inContexts = (
    consumer: SyntaxClassConsumer,
    contexts: ReadonlySet<MacroContext>,
  ): SyntaxClassConsumer =>
    Object.assign(
      (...request: Parameters<SyntaxClassConsumer>) => {
        const enclosing = captureContexts;
        captureContexts = contexts;
        try {
          return consumer(...request);
        } finally {
          captureContexts = enclosing;
        }
      },
      {
        describeFailure: consumer.describeFailure,
        nameOfClass: consumer.nameOfClass,
      },
    );
  /**
   * The top level of a module, which is where its items stand: `await` is an
   * expression there and `yield` is not. Every Sweetener source is a module,
   * as the compiler tells TypeScript when it checks one.
   */
  const moduleContexts: ReadonlySet<MacroContext> = new Set(["async"]);
  /** The contexts a consumer read its input in, as a rule requires them. */
  const contextsOf = (read: ConsumerContext): ReadonlySet<MacroContext> => {
    const contexts = new Set<MacroContext>();
    if (read.allowYield) contexts.add("generator");
    if (read.allowAwait) contexts.add("async");
    return contexts;
  };
  const context = (
    category: SyntaxCategory,
    contexts: ReadonlySet<MacroContext> = new Set(),
  ): ConsumerContext =>
    Object.freeze({
      category,
      phase: options.phase,
      environmentEpoch: expansionEnvironment.epoch as EnvironmentEpoch,
      stopSet: StopSet.empty,
      tracker: options.tracker,
      cancellation: options.guard.cancellation,
      allowYield: contexts.has("generator"),
      allowAwait: contexts.has("async"),
      slashMisread: options.slashMisread,
    });
  const requiredClass = (
    module: CompileParsedMacrosResult,
    name: string,
  ): SyntaxClassId => {
    const id = module.classId(name);
    if (id === undefined) throw new Error(`missing syntax class ${name}`);
    return id;
  };
  for (const module of modules) {
    const consumers = new Map<SyntaxClassId, SyntaxConsumer>();
    const register = (name: string, consumer: SyntaxConsumer) => {
      const id = module.classId(name);
      if (id !== undefined) consumers.set(id, consumer);
    };
    register("expr", expression);
    register("binding", binding);
    register("stmt", statement);
    register("item", item);
    register("type", type);
    register("classElement", classElement);
    register("typeMember", typeMember);
    register("jsxChild", jsxChild);
    const consumeClass = createSyntaxClassConsumer(module.syntaxClasses, {
      builtins: {
        token: requiredClass(module, "token"),
        tt: requiredClass(module, "tt"),
        ident: requiredClass(module, "ident"),
      },
      tracker: options.tracker,
      environmentEpoch: expansionEnvironment.epoch,
      externalConsumer: (classId, cursor, boundary) => {
        const consumer = consumers.get(classId);
        if (consumer === undefined) return undefined;
        const category =
          classId === module.classId("expr")
            ? "expr"
            : classId === module.classId("binding")
              ? "binding"
              : classId === module.classId("stmt")
                ? "stmt"
                : classId === module.classId("type")
                  ? "type"
                  : classId === module.classId("classElement")
                    ? "classElement"
                    : classId === module.classId("typeMember")
                      ? "typeMember"
                      : classId === module.classId("jsxChild")
                        ? "jsxChild"
                        : "item";
        const base = context(category, captureContexts);
        const start = cursor.index;
        const attempted = consumer.consume(cursor, {
          ...base,
          // A rule is tried and may be abandoned for the next one, so what
          // its capture finds waits on the invocation it was tried for.
          slashMisread: captureMisreads.record,
          stopSet: base.stopSet.union(
            new StopSet(
              (boundary?.stopTokens ?? []).map((raw) => ({
                kind: "token" as const,
                raw,
              })),
            ),
          ),
        });
        if (!attempted.matched) return undefined;
        const raw = cursor
          .remainingRange()
          .sequence.slice(start, attempted.cursor.index);
        // What the consumer parsed, not the tokens it read. Keeping the raw
        // run would throw away the boundary the parse just established, so a
        // captured expression spliced into a template would re-associate
        // against the template's own operators: `$v * 2` with `$v` bound to
        // `1 + 2` would emit `1 + 2 * 2` and compute 5 rather than 6.
        //
        // A type has its own operators and its own precedence, and the same
        // thing happens there: `$t[]` with `$t` bound to `string | number`
        // emitted `string | number[]`, an array of `number` unioned with
        // `string`. That one type-checks, so nothing at all is reported.
        // Whether the boundary is then printed as parentheses is the
        // printer's question, and it asks it of an expansion's own syntax the
        // same way.
        //
        // A lone group is kept in its node too, as a macro's result is: the
        // braces of a captured `{ value: 1 }` spliced loose after `=>` read
        // as a block, and the function returned nothing.
        //
        // The node is normalized as every reading the walk is handed is. A
        // capture is spliced into its template whole and counts there as
        // syntax the reading of the replacement was handed, so it is never
        // normalized later: kept as the reader built it, the walk met inside
        // it the nesting no other route gives it.
        const syntax =
          (attempted.syntax.category === "expr" ||
            attempted.syntax.category === "type") &&
          !boundsItself(raw, attempted.syntax.form)
            ? [
                normalizeProtectedInput(
                  attempted.syntax,
                  handedIn(createSyntaxSequence(raw)),
                  options,
                ),
              ]
            : raw;
        return Object.freeze({
          cursor: attempted.cursor,
          syntax: createSyntaxSequence(syntax),
          origin: syntax[0]!.origin,
        });
      },
    });
    classConsumerByModule.set(module, consumeClass);
    for (const macro of module.macros)
      classConsumerByBinding.set(macro.binding.id, consumeClass);
  }
  const consumeClass = classConsumerByModule.get(options.module)!;

  /**
   * `syntax` read as one node of `category`, normalized as every other route
   * is. The walk reads what this hands back where it reads a substitution of
   * a template literal, and while the infix `=>` protected an arrow's
   * parameters as an expression, `${x => { return x; }}` reached it that way
   * and `x` was dispatched as a macro wherever one was in scope.
   */
  const enforest = (
    syntax: SyntaxSequence,
    category: SyntaxCategory,
    lexicalModule = options.module,
    contexts: ReadonlySet<MacroContext> = new Set(),
  ): NormalizedSyntax => {
    const consumer =
      category === "expr"
        ? expression
        : category === "binding"
          ? binding
          : category === "stmt"
            ? statement
            : category === "item"
              ? item
              : category === "type"
                ? type
                : category === "classElement"
                  ? classElement
                  : category === "typeMember"
                    ? typeMember
                    : category === "jsxChild"
                      ? jsxChild
                      : undefined;
    if (consumer === undefined)
      return normalizeProtectedInput(
        protect(syntax, category),
        handedIn(syntax),
        options,
      );
    const previousOperatorModule = activeOperatorModule;
    activeOperatorModule = lexicalModule;
    let attempted;
    try {
      attempted = consumer.consume(
        createSyntaxCursor(syntax),
        context(category, contexts),
      );
    } finally {
      activeOperatorModule = previousOperatorModule;
    }
    if (!attempted.matched || !attempted.cursor.atEnd)
      throw new EnforestationError(category, diagnosticSyntaxText(syntax));
    return normalizeProtectedInput(attempted.syntax, handedIn(syntax), options);
  };
  const protect = (
    syntax: SyntaxSequence,
    category: SyntaxCategory,
  ): ProtectedSyntax =>
    createProtectedSyntax({
      id: options.allocateSyntaxId(),
      span: spanEnvelope(syntax.map(({ span }) => span)),
      origin:
        new Set(syntax.map(({ origin }) => origin)).size === 1
          ? syntax[0]!.origin
          : options.origins.composed(syntax.map(({ origin }) => origin)),
      scopes: syntax[0]!.scopes,
      category,
      children: syntax,
    });

  /** The macro names a file's own text can invoke: its own and its imports. */
  const macroSpellingsInScope = (): ReadonlySet<string> =>
    new Set([
      ...options.module.macros.map(({ binding }) => binding.spelling),
      ...(options.importedBindings?.keys() ?? []),
    ]);

  const rawText = (syntax: Syntax | undefined): string | undefined =>
    syntax?.tag === "token" ? syntax.raw : undefined;

  const leadingItemBoundary = (syntax: Syntax): boolean => {
    const first = syntax.tag === "group" ? syntax.open : syntax;
    return (
      first.tag === "token" &&
      first.leadingTrivia.some((trivia) => trivia.hasLineBreak)
    );
  };

  /**
   * Macro invocations that recovery passed through, by the origin of the token
   * naming them. Recovering an item does not by itself mean the macro in it
   * goes unexpanded — a binder macro in a `const` initializer, for instance, is
   * recovered and then still dispatched — so nothing is reported here. These
   * are the candidates the check after expansion looks for in the output.
   */
  const recoveredMacroNames = new Map<OriginId, string>();

  /**
   * The runs recovery passed through, each with what the reader wanted where
   * it stopped. Whether a run is worth reporting is not known until expansion
   * has finished with it, so the failure is kept rather than discarded.
   */
  const recoveredItems: {
    readonly nodes: readonly Syntax[];
    readonly failure: ConsumerFailure;
  }[] = [];

  const noteRecoveredMacros = (raw: readonly Syntax[]): void => {
    const spellings = macroSpellingsInScope();
    if (spellings.size === 0) return;
    const visit = (node: Syntax): void => {
      if (node.tag === "token") {
        if (node.kind === "identifier" && spellings.has(node.raw))
          recoveredMacroNames.set(node.origin, node.raw);
        return;
      }
      if (node.tag === "group") for (const child of node.children) visit(child);
    };
    for (const node of raw) visit(node);
  };

  /**
   * Passing syntax through untouched is only safe while it invokes no macro.
   * A compile-time import never reaches the output, so an invocation still
   * standing in the expanded syntax emits a call to a name nothing defines —
   * and doing that in silence is how a build reported success and shipped a
   * runtime error. Checked against what expansion actually produced, so a
   * recovered invocation that some other consumer went on to expand is not
   * reported.
   */
  const reportSurvivingMacros = (
    syntax: SyntaxSequence,
    reportedAlready: readonly ExpandMacroSyntaxResult["diagnostics"][number][],
    /**
     * The identifiers expansion read as names rather than as macro heads. A
     * spelling in scope is not an invocation wherever it appears: it names a
     * property, a member, a label, or whatever a nearer binding bound. Matching
     * the spelling alone reported every one of those as an invocation left
     * behind, and refused files that were correct.
     */
    named: ReadonlySet<OriginId>,
  ): void => {
    if (recoveredMacroNames.size === 0) return;
    const reported = new Set<OriginId>();
    // An invocation that failed to expand for a reason expansion already
    // described — no rule matched, say — is not a silent miscompile, and
    // saying so twice helps nobody. Only speak where nothing else did.
    const described = (origin: ReturnType<typeof originOfSyntax>) =>
      reportedAlready.some((diagnostic) => mentions(diagnostic, origin));
    const visit = (node: Syntax): void => {
      if (node.tag === "token") {
        if (recoveredMacroNames.get(node.origin) !== node.raw) return;
        if (named.has(node.origin)) return;
        if (reported.has(node.origin)) return;
        if (described(originOfSyntax(node))) return;
        reported.add(node.origin);
        recoveryDiagnostics.push(
          expansionDiagnosticRegistry.create(unreadableItemCode, {
            primaryOrigin: originOfSyntax(node),
            messageArguments: [node.raw],
          }),
        );
        return;
      }
      if ("children" in node)
        for (const child of node.children) visit(child as Syntax);
    };
    for (const node of syntax) visit(node);
  };

  /**
   * What recovery could not read, said where nothing else says anything.
   *
   * Recovery is how syntax the reader is not meant to read reaches the
   * expander -- a macro written after its first operand, an operator standing
   * in an initializer -- so a word on every recovery would be a word on most
   * files that use macros at all. It is also how a declaration the reader
   * disagrees with TypeScript about reaches the output, and that has been
   * silent: the item's structure is lost, whatever is written in it is passed
   * through as written, and the only sign was `SWR4012` when a macro spelling
   * happened to survive into the output.
   *
   * Reported where all three hold:
   *
   *  - the run begins at a word that begins a declaration and nothing else, so
   *    it is a declaration rather than syntax written in some other shape;
   *  - every node of the run still stands in the expanded syntax, so nothing
   *    in it was macro syntax that expansion went on to rewrite -- recovery
   *    bought nothing here;
   *  - nothing already reported speaks about the run, so an unexpanded macro
   *    or operator in it is described once, in its own words -- counting what
   *    this has itself said, not only what was reported before it began.
   */
  const reportUnreadItems = (
    syntax: SyntaxSequence,
    reportedAlready: readonly ExpandMacroSyntaxResult["diagnostics"][number][],
  ): void => {
    if (recoveredItems.length === 0) return;
    // The tokens the expansion is written with, each by where it was written
    // and what it says. An origin alone is not enough: a macro's expansion
    // carries the origin of the invocation it replaced, so `logit` and the
    // `console.log(1);` it expanded to answer to the same one.
    const written = (node: Syntax): string =>
      JSON.stringify([node.origin, node.tag === "token" ? node.raw : ""]);
    const survived = new Set<string>();
    const collect = (node: Syntax): void => {
      if (node.tag === "token") survived.add(written(node));
      if ("children" in node)
        for (const child of node.children) collect(child as Syntax);
    };
    for (const node of syntax) collect(node);
    for (const { nodes, failure } of recoveredItems) {
      const head = nodes[0];
      if (head === undefined) continue;
      if (!definiteItemStarts.has(rawText(head) ?? "")) continue;
      const tokens: Syntax[] = [];
      const flatten = (node: Syntax): void => {
        if (node.tag === "token") tokens.push(node);
        if ("children" in node)
          for (const child of node.children) flatten(child as Syntax);
      };
      for (const node of nodes) flatten(node);
      if (!tokens.every((node) => survived.has(written(node)))) continue;
      const first = originOfSyntax(head);
      const spans = tokens
        .map((node) => originOfSyntax(node))
        .filter(({ sourceId }) => sourceId === first.sourceId);
      const run = {
        sourceId: first.sourceId,
        start: Math.min(...spans.map(({ start }) => start)),
        end: Math.max(...spans.map(({ end }) => end)),
        originId: first.originId,
      };
      // What this loop has already said counts as said. Measured against the
      // snapshot alone, two recovered runs that overlap -- a recovery nested
      // inside another -- would each find nothing spoken about them and both
      // report, which is the one thing the rule above forbids.
      if (
        reportedAlready.some((diagnostic) => mentions(diagnostic, run)) ||
        recoveryDiagnostics.some((diagnostic) => mentions(diagnostic, run))
      )
        continue;
      // Where the reader stopped, which is what its failure counted nodes to.
      // A run recovery ended before that point is named at its last node
      // rather than past its end.
      const stopped =
        nodes[Math.min(failure.progress, nodes.length - 1)] ?? head;
      const expected = failure.expectations.join(" or ");
      recoveryDiagnostics.push(
        expansionDiagnosticRegistry.create(unreadItemCode, {
          primaryOrigin: run,
          messageArguments: [expected],
          relatedOrigins: [
            {
              message: `The reader expected ${expected} here.`,
              origin: originOfSyntax(stopped),
            },
          ],
        }),
      );
    }
  };

  /**
   * A custom operator is expanded while the expression around it is read, so
   * an expression that cannot be read never offers it its operands, and the
   * statement holding it is passed through as written. Its spelling is not
   * TypeScript's, and nothing said so: `1 |> ;` reached the host compiler as
   * `1 | > ;`, which reported an expression expected rather than anything about
   * the operator. Any operator of this file's still standing in the output is
   * reported where it was written, unless expansion already said why.
   */
  const reportUnexpandedOperators = (
    syntax: SyntaxSequence,
    offered: ReadonlySet<Syntax["origin"]>,
    reportedAlready: readonly ExpandMacroSyntaxResult["diagnostics"][number][],
  ): void => {
    const visible = new Set([
      ...options.module.macros.map(({ binding }) => binding.id),
      ...[...(options.importedBindings?.values() ?? [])].map(
        ({ binding }) => binding.id,
      ),
    ]);
    const coreSpellings = new Set(
      coreExpressionOperators.map(({ spelling }) => spelling),
    );
    const spellings = [
      ...new Set(
        modules
          .flatMap(({ operators }) => operators)
          .filter(
            ({ binding, spelling }) =>
              visible.has(binding) && !coreSpellings.has(spelling),
          )
          .map(({ spelling }) => spelling),
      ),
    ].sort((left, right) => right.length - left.length);
    if (spellings.length === 0) return;
    const described = (origin: ReturnType<typeof originOfSyntax>) =>
      reportedAlready.some((diagnostic) => mentions(diagnostic, origin));
    const visitRun = (children: readonly Syntax[]): void => {
      for (let at = 0; at < children.length; at += 1) {
        const node = children[at]!;
        if (node.tag !== "token") {
          if ("children" in node) visitRun(node.children as readonly Syntax[]);
          continue;
        }
        const spelling = spellings.find(
          (candidate) => operatorWidthAt(children, at, candidate) !== undefined,
        );
        if (spelling === undefined) continue;
        const width = operatorWidthAt(children, at, spelling)!;
        const origin = originOfSyntax(node);
        // An operator that was offered its input and taken by no rule has a
        // diagnostic saying so already, reported from wherever its invocation
        // began -- a statement operator's is the head of its statement.
        if (!offered.has(node.origin) && !described(origin))
          recoveryDiagnostics.push(
            expansionDiagnosticRegistry.create(unexpandedOperatorCode, {
              primaryOrigin: origin,
              messageArguments: [spelling],
            }),
          );
        at += width - 1;
      }
    };
    visitRun(syntax);
  };

  /**
   * Whether a diagnostic already speaks about a position. A macro no rule
   * accepted is reported where its closest rule stopped, which may be well
   * past the name, and names the invocation itself as a related location.
   */
  const mentions = (
    diagnostic: ExpandMacroSyntaxResult["diagnostics"][number],
    { sourceId, start, end }: ReturnType<typeof originOfSyntax>,
  ): boolean =>
    [
      diagnostic.primaryOrigin,
      ...(diagnostic.relatedOrigins ?? []).map(({ origin }) => origin),
    ].some(
      (origin) =>
        origin.sourceId === sourceId &&
        origin.start <= end &&
        origin.end >= start,
    );

  const originOfSyntax = (node: Syntax) => {
    const selected = options.origins.selectPrimarySource(node.origin);
    return {
      sourceId: selected?.sourceId ?? options.sourceId,
      start: selected?.span.start ?? node.span.start,
      end: selected?.span.end ?? node.span.end,
      originId: node.origin,
    };
  };

  const prepareInput = (
    syntax: SyntaxSequence,
    category: SyntaxCategory,
  ): SyntaxSequence => {
    if (category !== "item") return syntax;
    const handed = handedIn(syntax);
    const cursor = createSyntaxCursor(syntax);
    const prepared: ProtectedSyntax[] = [];
    const fallbackItem = (raw: readonly Syntax[]): ProtectedSyntax => {
      const variableKeyword = raw.findIndex(
        (node) =>
          node.tag === "token" && ["const", "let", "var"].includes(node.raw),
      );
      const equals = raw.findIndex(
        (node, index) =>
          index > variableKeyword && node.tag === "token" && node.raw === "=",
      );
      const terminator = raw.at(-1);
      if (
        variableKeyword >= 0 &&
        equals >= 0 &&
        equals + 1 < raw.length &&
        terminator?.tag === "token" &&
        terminator.raw === ";"
      ) {
        const expressionSyntax = createSyntaxSequence(
          raw.slice(equals + 1, -1),
        );
        if (expressionSyntax.length > 0)
          return protect(
            createSyntaxSequence([
              ...raw.slice(0, equals + 1),
              protect(expressionSyntax, "expr"),
              terminator,
            ]),
            "item",
          );
      }
      return protect(createSyntaxSequence(raw), "item");
    };
    while (!cursor.atEnd) {
      const attempted = item.consume(
        cursor.fork(),
        context("item", moduleContexts),
      );
      if (!attempted.matched || attempted.cursor.index <= cursor.index) {
        const fallback = cursor.fork();
        const raw: Syntax[] = [];
        while (!fallback.atEnd) {
          const next = fallback.consume()!;
          raw.push(next);
          if (next.tag === "token" && next.raw === ";") break;
          // An item start on a new line ends the damage where the next item
          // begins. Recovering only to the next top-level semicolon, a file
          // whose remaining semicolons all sit inside braces would have the
          // whole rest of itself swallowed by one unreadable item.
          const following = fallback.peek();
          if (
            following !== undefined &&
            leadingItemBoundary(following) &&
            definiteItemStarts.has(rawText(following) ?? "")
          )
            break;
        }
        if (raw.length === 0)
          throw new TypeError("source file contains an unenforestable item");
        noteRecoveredMacros(raw);
        if (!attempted.matched)
          recoveredItems.push(
            Object.freeze({
              nodes: Object.freeze([...raw]),
              failure: attempted.failure,
            }),
          );
        cursor.advance(fallback.index - cursor.index);
        prepared.push(fallbackItem(raw));
        continue;
      }
      const consumed = cursor
        .remainingRange()
        .sequence.slice(cursor.index, attempted.cursor.index);
      const next = attempted.cursor.peek();
      const incompleteVariable =
        consumed.some(
          (node) =>
            node.tag === "token" && ["const", "let", "var"].includes(node.raw),
        ) &&
        consumed.some((node) => node.tag === "token" && node.raw === "=") &&
        !consumed.some((node) => node.tag === "token" && node.raw === ";") &&
        next?.tag === "token" &&
        !definiteItemStarts.has(next.raw);
      if (incompleteVariable) {
        const fallback = cursor.fork();
        const raw: Syntax[] = [];
        while (!fallback.atEnd) {
          const candidate = fallback.consume()!;
          raw.push(candidate);
          if (candidate.tag === "token" && candidate.raw === ";") break;
        }
        cursor.advance(fallback.index - cursor.index);
        prepared.push(fallbackItem(raw));
        continue;
      }
      cursor.advance(attempted.cursor.index - cursor.index);
      prepared.push(normalizeProtectedInput(attempted.syntax, handed, options));
    }
    return createSyntaxSequence(prepared);
  };

  /**
   * Every node of a run, read one after another by `consumer`, or nothing
   * where the run does not read as a list of them.
   *
   * The five list-shaped routes into the expander come through here so that
   * none of them can answer differently from the others. They were five copies
   * of this loop, which is how they came to differ from `prepareInput` and
   * from the expression route in the first place.
   *
   * Each brands what it reads `NormalizedSyntax`, as those two routes do, so
   * the walk is handed one shape whichever route read it. A statement list, an
   * item list and a class body are read by readers that build an expression
   * inside an expression -- an operator's operands, or a statement in a
   * method's body -- and normalize what they read. The type member and JSX
   * child readers build no protected node inside one of its own category, so
   * `brand` says so for them, loudly, rather than normalizing what never
   * changes. Normalizing `item` here once emitted TypeScript that does not
   * parse -- the React memoization fixture -- because what is read here is
   * often a replacement, and normalizing took apart what the expansion had
   * built; that is why `normalizeProtectedInput` keeps what the reader was
   * handed.
   */
  const enforestList = (
    consumer: SyntaxConsumer,
    category: SyntaxCategory,
    request: {
      readonly syntax: SyntaxSequence;
      readonly contexts: ReadonlySet<MacroContext>;
      readonly lexicalModule?: CompileParsedMacrosResult | undefined;
    },
    brand: typeof normalizeProtectedInput,
  ): readonly NormalizedSyntax[] | undefined => {
    const restore = enforestingModule;
    enforestingModule = request.lexicalModule ?? restore;
    try {
      const handed = handedIn(request.syntax);
      let cursor = createSyntaxCursor(request.syntax);
      const read: NormalizedSyntax[] = [];
      while (!cursor.atEnd) {
        const before = cursor.index;
        const attempted = consumer.consume(cursor, {
          ...context(category, request.contexts),
          stopSet: StopSet.empty,
        });
        if (!attempted.matched || attempted.cursor.index <= before)
          return undefined;
        read.push(brand(attempted.syntax, handed, options));
        cursor = attempted.cursor;
      }
      return createSyntaxSequence(read);
    } finally {
      enforestingModule = restore;
    }
  };

  const routes: ReadingRoutes = Object.freeze({
    enforest: ({
      syntax: replacement,
      category: replacementCategory,
      lexicalModule,
      contexts,
    }) => enforest(replacement, replacementCategory, lexicalModule, contexts),
    enforestStatements: (request) =>
      enforestList(statement, "stmt", request, normalizeProtectedInput),
    enforestItems: (request) =>
      enforestList(item, "item", request, normalizeProtectedInput),
    enforestJsxChildren: (request) =>
      enforestList(jsxChild, "jsxChild", request, alreadyNormal),
    enforestTypeMembers: (request) =>
      enforestList(typeMember, "typeMember", request, alreadyNormal),
    enforestClassElements: (request) =>
      enforestList(
        classElement,
        "classElement",
        request,
        normalizeProtectedInput,
      ),
    enforestExpression: ({ syntax, contexts, lexicalModule }) => {
      const restore = enforestingModule;
      enforestingModule = lexicalModule ?? restore;
      try {
        const attempted = expression.consume(createSyntaxCursor(syntax), {
          ...context("expr", contexts),
          stopSet: StopSet.empty,
        });
        // Normalized, as the items handed over by `prepareInput` are. Both
        // routes into the expander hand it the same shape, or the two
        // disagree about what a reading means: while the infix `=>`
        // protected an arrow's parameter list as an expression, the walk
        // found no parameter list in front of the `=>` of a reading left
        // that way, and walked the binders in it as an expression.
        return attempted.matched && attempted.cursor.atEnd
          ? normalizeProtectedInput(attempted.syntax, handedIn(syntax), options)
          : undefined;
      } finally {
        enforestingModule = restore;
      }
    },
  });

  return Object.freeze({
    consumeClass,
    environment,
    routes,
    expand: (
      syntax: SyntaxSequence,
      category: SyntaxCategory = "item",
    ): ExpandMacroSyntaxResult => {
      operatorTraces.length = 0;
      offeredOperatorTokens.clear();
      refusedOperatorSpans.length = 0;
      operatorDiagnostics.length = 0;
      abortedOperators.clear();
      operatorNameExplanations.length = 0;
      recoveryDiagnostics.length = 0;
      recoveredMacroNames.clear();
      recoveredItems.length = 0;
      const result = expandMacroSyntax({
        module: options.module,
        sourceId: options.sourceId,
        modules,
        syntax: prepareInput(syntax, category),
        category,
        // A module's items are what is expanded under the item category, and
        // they stand at its top level.
        contexts: category === "item" ? moduleContexts : new Set(),
        ...routes,
        consumeClass,
        consumeClassForMacro: (macro, contexts) =>
          inContexts(
            classConsumerByBinding.get(macro.binding.id) ?? consumeClass,
            contexts,
          ),
        resolveMacro: ({
          spelling,
          category,
          lexicalModule,
          modules: activeModules,
          position,
          positionSourceId,
        }) => {
          const generated = [...activeModules]
            .slice(modules.length)
            .reverse()
            .map((module) => module.get(spelling, category))
            .find((macro) => macro !== undefined);
          return (
            generated ??
            resolve(
              spelling,
              category,
              lexicalModule,
              position,
              positionSourceId,
            )
          );
        },
        phase: options.phase,
        environmentEpoch: expansionEnvironment.epoch,
        expansionStore,
        expansionEnvironment,
        generatedDefinitions: { sourceId: options.sourceId },
        coreInterceptionForMacro: ({ macro, lexicalModule, spelling }) =>
          coreInterception(macro, lexicalModule, spelling),
        scopeStore: options.scopeStore,
        origins: options.origins,
        environments: options.environments,
        environment,
        tracker: options.tracker,
        guard: options.guard,
        extractBindings: (candidate) => {
          const attempted = binding.consumeBinding(
            createSyntaxCursor(candidate),
            context("binding"),
          );
          return attempted.matched
            ? attempted.skeleton.names.map((name) => ({
                spelling: name.spelling,
                origin: name.origin,
                scopes: name.scopes,
              }))
            : [];
        },
        matchesBindingLiteral: options.matchesBindingLiteral,
        allocateSyntaxId: options.allocateSyntaxId,
        allocateBindingId: options.allocateBindingId,
        allocateInvocationId: options.allocateInvocationId,
        captureSlashMisreads: captureMisreads,
        admit: () => true,
        diagnosticOrigin: (origin) => {
          const selected = options.origins.selectPrimarySource(origin);
          return {
            sourceId: selected?.sourceId ?? options.sourceId,
            start: selected?.span.start ?? 0,
            end: selected?.span.end ?? 0,
            originId: origin,
          };
        },
      });
      // Everything held for TypeScript to resolve, from the expander's walk
      // and from the operators read alongside it.
      const explanations = [
        ...operatorNameExplanations,
        ...result.unresolvedNameExplanations,
      ];
      // A name held for TypeScript to resolve counts as spoken about here.
      // The three reports below say what nothing else said, and a position an
      // explanation covers is a position expansion has an answer for; blaming
      // it for a macro left standing would say the wrong thing about it, and
      // would say it whether or not the name resolves.
      const spokenFor = [
        ...operatorDiagnostics,
        ...result.diagnostics,
        ...explanations,
      ];
      reportSurvivingMacros(result.syntax, spokenFor, result.namedOrigins);
      reportUnexpandedOperators(
        result.syntax,
        new Set([...result.offeredOperators, ...offeredOperatorTokens]),
        [...spokenFor, ...recoveryDiagnostics],
      );
      // Last of the three, so that an item holding a macro or an operator
      // either of them speaks about is described in those words rather than as
      // an item that could not be read.
      reportUnreadItems(result.syntax, [...spokenFor, ...recoveryDiagnostics]);
      const diagnosticKeys = new Set<string>();
      const uniqueDiagnostics = [
        ...operatorDiagnostics,
        ...recoveryDiagnostics,
        ...result.diagnostics,
      ].filter((diagnostic) => {
        if (
          diagnostic.code === unparameterizedSyntaxParameterCode &&
          refusedOperatorSpans.some(
            (span) =>
              span.sourceId === diagnostic.primaryOrigin.sourceId &&
              span.start <= diagnostic.primaryOrigin.start &&
              diagnostic.primaryOrigin.end <= span.end,
          )
        )
          return false;
        const key = JSON.stringify([
          diagnostic.code,
          diagnostic.primaryOrigin.sourceId,
          diagnostic.primaryOrigin.start,
          diagnostic.primaryOrigin.end,
          diagnostic.messageArguments,
        ]);
        if (diagnosticKeys.has(key)) return false;
        diagnosticKeys.add(key);
        return true;
      });
      return Object.freeze({
        ...result,
        traces: Object.freeze([...operatorTraces, ...result.traces]),
        diagnostics: Object.freeze(uniqueDiagnostics),
        unresolvedNameExplanations: Object.freeze(explanations),
      });
    },
  } satisfies ExpansionFrontendSession);
}
