import { EnforestationError } from "./enforestation-error.js";
import {
  expansionDiagnosticRegistry,
  unreadableItemCode,
} from "./diagnostics.js";
import {
  bindingMacroResolver,
  createBindingConsumer,
  createJsxChildConsumer,
  createClassElementConsumer,
  createItemConsumer,
  createPrattExpressionConsumer,
  createStatementConsumer,
  createTypeConsumers,
  StopSet,
  type ConsumerContext,
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
import type {
  BindingId,
  EnvironmentEpoch,
  InvocationId,
  OriginId,
  ResourceTracker,
  SourceId,
  SyntaxClassId,
  SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
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
  expandMacroSyntax,
  operatorWidthAt,
  type ExpandMacroSyntaxResult,
} from "./recursive-expander.js";
import type { ExpansionGuard } from "./progress.js";
import { isCoreForm } from "./core-shadowing.js";
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
}

function diagnosticSyntaxText(syntax: readonly Syntax[]): string {
  const parts: string[] = [];
  const visit = (node: Syntax): void => {
    if (node.tag === "token") {
      parts.push(node.raw);
      return;
    }
    if (node.tag === "group") parts.push(node.open.raw);
    for (const child of node.children) visit(child);
    if (node.tag === "group" && node.close.tag === "token")
      parts.push(node.close.raw);
  };
  for (const node of syntax) visit(node);
  return parts.join(" ");
}

export interface ExpansionFrontendSession {
  readonly consumeClass: SyntaxClassConsumer;
  readonly environment: BindingEnvironment;
  expand(
    syntax: SyntaxSequence,
    category?: SyntaxCategory,
  ): ExpandMacroSyntaxResult;
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
  const operatorTraces: MacroTraceEvent[] = [];
  const operatorDiagnostics: ExpandMacroSyntaxResult["diagnostics"][number][] =
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
    if (!isCoreForm(spelling, category)) return selected;
    const local = lexicalModule.macros.some(
      ({ binding }) => binding.id === selected.binding.id,
    );
    if (local)
      return lexicalModule.definitions.some(
        ({ definition, macro }) =>
          macro.binding.id === selected.binding.id &&
          definition.shadowsCore &&
          isCoreForm(spelling, category),
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
    if (!isCoreForm(spelling, macro.category)) return undefined;
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
        isCoreForm(macro.binding.spelling, macro.category)
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
            isCoreForm(macro.binding.spelling, macro.category),
        ),
      visible: (operator, cursor) => {
        const macro = modules
          .flatMap(({ macros }) => macros)
          .find(({ binding }) => binding.id === operator.binding);
        return (
          macro !== undefined &&
          options.isMacroVisible?.({
            lexicalModule,
            spelling: operator.spelling,
            macro,
            position: cursor.peek()?.span.start ?? Number.POSITIVE_INFINITY,
          }) !== false
        );
      },
      expand: ({ macro, operator, input }) => {
        const invocation = operatorInvocationSyntax(
          input,
          operator.fixity,
          true,
        );
        const consumeClass = classConsumerByBinding.get(macro.binding.id);
        if (consumeClass === undefined)
          throw new Error("operator syntax-class consumer is not initialized");
        const result = invokeMacro({
          macro,
          cursor: createSyntaxCursor(invocation),
          category: "expr",
          phase: options.phase,
          environmentEpoch: expansionEnvironment.epoch,
          consumeClass,
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
          position: 0,
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
        operatorTraces.push(result.trace);
        if (!result.expanded) {
          operatorDiagnostics.push(result.diagnostic);
          return createProtectedSyntax({
            id: options.allocateSyntaxId(),
            span: spanEnvelope(invocation.map(({ span }) => span)),
            origin:
              invocation.length === 1
                ? invocation[0]!.origin
                : options.origins.composed(
                    invocation.map(({ origin }) => origin),
                  ),
            scopes: invocation[0]!.scopes,
            category: "expr",
            children: invocation,
          });
        }
        hygieneEnvironment = result.environment;
        return result.syntax;
      },
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
  // Built before the consumers that need it: what stands to the right of `as`
  // and `satisfies` is a type, and the statement and item consumers build
  // expression consumers of their own, so it has to reach all of them. Passing
  // it only to the expression consumer left `const value = 1 as number;`
  // unparseable inside a function body while working at the top level.
  // The member consumer is given the extent resolver so a member macro's own
  // rule decides where its invocation ends; a member list separates on `,`,
  // which would otherwise cut an invocation that contains one in half.
  const typeConsumers = createTypeConsumers({
    ...shared,
    resolveTypeMemberMacro: extentResolver,
  });
  const type = typeConsumers.type;
  const consumerShared = {
    ...shared,
    resolveMacroOperator: operatorResolver,
    consumeType: type,
  };
  const expression = createPrattExpressionConsumer({
    ...consumerShared,
    resolveMacro: extentResolver,
  });
  const binding = createBindingConsumer({
    ...shared,
    resolveMacro: bindingMacroResolver(extentResolver),
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
  const statement = createStatementConsumer({
    ...consumerShared,
    resolveMacro: extentResolver,
    holdsStatementOperator,
  });
  const item = createItemConsumer({
    ...consumerShared,
    resolveMacro: extentResolver,
    holdsStatementOperator,
  });
  const jsxChild = createJsxChildConsumer(shared);
  const classElement = createClassElementConsumer({
    ...shared,
    enforestStatementBlock: (block, blockContext) =>
      statement.enforestBlock(block, blockContext),
  });
  const typeMember = typeConsumers.typeMember;
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
        const base = context(category);
        const start = cursor.index;
        const attempted = consumer.consume(cursor, {
          ...base,
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
        // run threw away the boundary the parse had just established, so a
        // captured expression spliced into a template re-associated against
        // the template's own operators: `$v * 2` with `$v` bound to `1 + 2`
        // emitted `1 + 2 * 2` and computed 5 rather than 6.
        const syntax =
          attempted.syntax.category === "expr" && raw.length > 1
            ? [attempted.syntax]
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

  const enforest = (
    syntax: SyntaxSequence,
    category: SyntaxCategory,
    lexicalModule = options.module,
    contexts: ReadonlySet<MacroContext> = new Set(),
  ) => {
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
    if (consumer === undefined) return protect(syntax, category);
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
    return attempted.syntax;
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

  const normalizeProtectedInput = (node: ProtectedSyntax): ProtectedSyntax => {
    const normalizeChildren = (
      children: SyntaxSequence,
      // Undefined inside a group: nesting is only redundant when the protected
      // node sits directly in a protected node of its own category. A group
      // delimits, so what it holds is a list of its own -- an interface body
      // is protected as a `typeMember` run and holds one protected member per
      // member, and carrying the category through the brace flattened every
      // member back into loose tokens.
      category: SyntaxCategory | undefined,
    ): SyntaxSequence =>
      createSyntaxSequence(
        children.flatMap((child): readonly Syntax[] => {
          if (child.tag === "protected") {
            const normalized = normalizeProtectedInput(child);
            return normalized.category === category
              ? normalized.children
              : [normalized];
          }
          if (child.tag === "group")
            return [
              createGroup({
                ...child,
                id: options.allocateSyntaxId(),
                children: normalizeChildren(child.children, undefined),
              }),
            ];
          return [child];
        }),
      );
    return createProtectedSyntax({
      ...node,
      id: options.allocateSyntaxId(),
      children: normalizeChildren(node.children, node.category),
    });
  };

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
  ): void => {
    if (recoveredMacroNames.size === 0) return;
    const reported = new Set<OriginId>();
    // An invocation that failed to expand for a reason expansion already
    // described — no rule matched, say — is not a silent miscompile, and
    // saying so twice helps nobody. Only speak where nothing else did.
    const described = ({
      sourceId,
      start,
      end,
    }: ReturnType<typeof originOfSyntax>) =>
      reportedAlready.some(
        (diagnostic) =>
          diagnostic.primaryOrigin.sourceId === sourceId &&
          diagnostic.primaryOrigin.start <= end &&
          diagnostic.primaryOrigin.end >= start,
      );
    const visit = (node: Syntax): void => {
      if (node.tag === "token") {
        if (recoveredMacroNames.get(node.origin) !== node.raw) return;
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
    const cursor = createSyntaxCursor(syntax);
    const prepared: ProtectedSyntax[] = [];
    const definiteItemStarts = new Set([
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
      const attempted = item.consume(cursor.fork(), context("item"));
      if (!attempted.matched || attempted.cursor.index <= cursor.index) {
        const fallback = cursor.fork();
        const raw: Syntax[] = [];
        while (!fallback.atEnd) {
          const next = fallback.consume()!;
          raw.push(next);
          if (next.tag === "token" && next.raw === ";") break;
          // Recovery used to run to the next top-level semicolon, and a file
          // whose remaining semicolons all sat inside braces had the whole
          // rest of itself swallowed by one unreadable item. An item start on
          // a new line ends the damage where the next item begins.
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
      prepared.push(normalizeProtectedInput(attempted.syntax));
    }
    return createSyntaxSequence(prepared);
  };

  return Object.freeze({
    consumeClass,
    environment,
    expand: (
      syntax: SyntaxSequence,
      category: SyntaxCategory = "item",
    ): ExpandMacroSyntaxResult => {
      operatorTraces.length = 0;
      operatorDiagnostics.length = 0;
      recoveryDiagnostics.length = 0;
      recoveredMacroNames.clear();
      const result = expandMacroSyntax({
        module: options.module,
        sourceId: options.sourceId,
        modules,
        syntax: prepareInput(syntax, category),
        category,
        consumeClass,
        consumeClassForMacro: (macro) =>
          classConsumerByBinding.get(macro.binding.id) ?? consumeClass,
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
        enforestStatements: ({ syntax, contexts, lexicalModule }) => {
          const restore = enforestingModule;
          enforestingModule = lexicalModule ?? restore;
          try {
            let cursor = createSyntaxCursor(syntax);
            const statements: Syntax[] = [];
            while (!cursor.atEnd) {
              const before = cursor.index;
              const attempted = statement.consume(cursor, {
                ...context("stmt", contexts),
                stopSet: StopSet.empty,
              });
              if (!attempted.matched || attempted.cursor.index <= before)
                return undefined;
              statements.push(attempted.syntax);
              cursor = attempted.cursor;
            }
            return createSyntaxSequence(statements);
          } finally {
            enforestingModule = restore;
          }
        },
        enforestItems: ({ syntax, contexts, lexicalModule }) => {
          const restore = enforestingModule;
          enforestingModule = lexicalModule ?? restore;
          try {
            let cursor = createSyntaxCursor(syntax);
            const items: Syntax[] = [];
            while (!cursor.atEnd) {
              const before = cursor.index;
              const attempted = item.consume(cursor, {
                ...context("item", contexts),
                stopSet: StopSet.empty,
              });
              if (!attempted.matched || attempted.cursor.index <= before)
                return undefined;
              items.push(attempted.syntax);
              cursor = attempted.cursor;
            }
            return createSyntaxSequence(items);
          } finally {
            enforestingModule = restore;
          }
        },
        enforestJsxChildren: ({ syntax, contexts, lexicalModule }) => {
          const restore = enforestingModule;
          enforestingModule = lexicalModule ?? restore;
          try {
            let cursor = createSyntaxCursor(syntax);
            const children: Syntax[] = [];
            while (!cursor.atEnd) {
              const before = cursor.index;
              const attempted = jsxChild.consume(cursor, {
                ...context("jsxChild", contexts),
                stopSet: StopSet.empty,
              });
              if (!attempted.matched || attempted.cursor.index <= before)
                return undefined;
              children.push(attempted.syntax);
              cursor = attempted.cursor;
            }
            return createSyntaxSequence(children);
          } finally {
            enforestingModule = restore;
          }
        },
        enforestTypeMembers: ({ syntax, contexts, lexicalModule }) => {
          const restore = enforestingModule;
          enforestingModule = lexicalModule ?? restore;
          try {
            let cursor = createSyntaxCursor(syntax);
            const members: Syntax[] = [];
            while (!cursor.atEnd) {
              const before = cursor.index;
              const attempted = typeMember.consume(cursor, {
                ...context("typeMember", contexts),
                stopSet: StopSet.empty,
              });
              if (!attempted.matched || attempted.cursor.index <= before)
                return undefined;
              members.push(attempted.syntax);
              cursor = attempted.cursor;
            }
            return createSyntaxSequence(members);
          } finally {
            enforestingModule = restore;
          }
        },
        enforestClassElements: ({ syntax, contexts, lexicalModule }) => {
          const restore = enforestingModule;
          enforestingModule = lexicalModule ?? restore;
          try {
            let cursor = createSyntaxCursor(syntax);
            const members: Syntax[] = [];
            while (!cursor.atEnd) {
              const before = cursor.index;
              const attempted = classElement.consume(cursor, {
                ...context("classElement", contexts),
                stopSet: StopSet.empty,
              });
              if (!attempted.matched || attempted.cursor.index <= before)
                return undefined;
              members.push(attempted.syntax);
              cursor = attempted.cursor;
            }
            return createSyntaxSequence(members);
          } finally {
            enforestingModule = restore;
          }
        },
        enforestExpression: ({ syntax, contexts, lexicalModule }) => {
          const restore = enforestingModule;
          enforestingModule = lexicalModule ?? restore;
          try {
            const attempted = expression.consume(createSyntaxCursor(syntax), {
              ...context("expr", contexts),
              stopSet: StopSet.empty,
            });
            return attempted.matched && attempted.cursor.atEnd
              ? attempted.syntax
              : undefined;
          } finally {
            enforestingModule = restore;
          }
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
        enforest: ({
          syntax: replacement,
          category: replacementCategory,
          lexicalModule,
          contexts,
        }) =>
          enforest(replacement, replacementCategory, lexicalModule, contexts),
        allocateSyntaxId: options.allocateSyntaxId,
        allocateBindingId: options.allocateBindingId,
        allocateInvocationId: options.allocateInvocationId,
        position: 0,
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
      reportSurvivingMacros(result.syntax, [
        ...operatorDiagnostics,
        ...result.diagnostics,
      ]);
      const diagnosticKeys = new Set<string>();
      const uniqueDiagnostics = [
        ...operatorDiagnostics,
        ...recoveryDiagnostics,
        ...result.diagnostics,
      ].filter((diagnostic) => {
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
      });
    },
  } satisfies ExpansionFrontendSession);
}
