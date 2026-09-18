import { EnforestationError } from "./enforestation-error.js";
import {
  expansionDiagnosticRegistry,
  unexpandedOperatorCode,
  unparameterizedSyntaxParameterCode,
  unreadableItemCode,
  unreadItemCode,
} from "./diagnostics.js";
import {
  bindingMacroResolver,
  coreExpressionOperators,
  createBindingConsumer,
  createJsxChildConsumer,
  createClassElementConsumer,
  createItemConsumer,
  createPrattExpressionConsumer,
  createStatementConsumer,
  createTypeConsumers,
  StopSet,
  type ConsumerContext,
  type ConsumerFailure,
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
import { coreFormKind, isCoreForm } from "./core-shadowing.js";
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
      expand: ({ macro, operator, input }) => {
        const invocation = operatorInvocationSyntax(
          input,
          operator.fixity,
          true,
        );
        for (const token of input.operator)
          offeredOperatorTokens.add(token.origin);
        const consumeClass = classConsumerByBinding.get(macro.binding.id);
        if (consumeClass === undefined)
          throw new Error("operator syntax-class consumer is not initialized");
        const result = invokeMacro({
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
          position: 0,
          // The parser has already decided what the operands are, so a rule
          // must account for all of them. Admitting a rule that matched a
          // prefix dropped the rest: with rules for `$v |> await` and
          // `$v |> $callee:expr`, `1 |> await g` expanded to `await 1`.
          admit: ({ cursor }) => cursor.atEnd,
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
    // A type macro standing in a typed capture is measured by its own rule.
    // Without this, only one shaped like a generic type (`list<string>`) would
    // read through; `wrap { string }` would stop at its brace.
    resolveMacro: (category, cursor, context) =>
      category === "classElement"
        ? undefined
        : extentResolver(category, cursor, context),
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
    enforestStatementBlock: (block, blockContext, allowYield, allowAwait) =>
      statement.enforestBlock(block, blockContext, allowYield, allowAwait),
  });
  const typeMember = typeConsumers.typeMember;
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
        const syntax =
          (attempted.syntax.category === "expr" ||
            attempted.syntax.category === "type") &&
          raw.length > 1
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

  /** Whether syntax came from source text alone, with no expansion in it. */
  const writtenInSource = (origin: OriginId): boolean => {
    const record = options.origins.get(origin);
    if (record === undefined) return false;
    if (record.kind === "source") return true;
    return (
      record.kind === "composed" &&
      record.parts.every((part) => writtenInSource(part))
    );
  };

  const normalizeProtectedInput = (node: ProtectedSyntax): ProtectedSyntax => {
    /**
     * What `child` normalizes to, or undefined where it normalizes to itself.
     * Saying so rather than returning a one-element run of it lets a node
     * whose whole subtree is already normal be kept rather than rebuilt.
     */
    const normalizeChild = (
      child: Syntax,
      category: SyntaxCategory | undefined,
      siblings: number,
    ): readonly Syntax[] | undefined => {
      if (child.tag === "protected") {
        const normalized = normalizeProtectedInput(child);
        // An expression or type an expansion built inside another is not
        // redundant: it is the boundary its operators bind within, and
        // nothing in the text says so. An operator's expansion arrives
        // here holding its operands that way, and flattening them printed
        // `$value * $n` over `1 + 2` and `3 + 4` as `1 + 2 * 3 + 4`. What
        // the parser built over source text is redundant with that text.
        const bounds =
          (category === "expr" || category === "type") &&
          !writtenInSource(normalized.origin);
        // A statement standing beside other syntax inside a statement is
        // a substatement, not a redundant wrapping: `here: log(x);` and
        // `while (c) log(x);` each read one statement inside another, and
        // the syntax beside it is the label or the header that reads it.
        // Flattened, the head of that statement stood right after the
        // `:` or the header, where a type is written -- so a statement
        // macro written there was refused for being declared `stmt`.
        const substatement =
          category === "stmt" && normalized.category === "stmt" && siblings > 1;
        if (normalized.category === category && !bounds && !substatement)
          return normalized.children;
        return normalized === child ? undefined : [normalized];
      }
      if (child.tag === "group") {
        const children = normalizeChildren(child.children, undefined);
        if (children === child.children) return undefined;
        return [
          createGroup({
            ...child,
            id: options.allocateSyntaxId(),
            children,
          }),
        ];
      }
      return undefined;
    };

    /**
     * The children of a node, normalized. The run handed in is returned
     * itself where nothing in it changed, which is what almost every prepared
     * statement finds: rebuilding it anyway allocated a fresh id for every
     * protected node and every group beneath it, so the id space filled with
     * new nodes standing for syntax that had not moved.
     */
    const normalizeChildren = (
      children: SyntaxSequence,
      // Undefined inside a group: nesting is only redundant when the protected
      // node sits directly in a protected node of its own category. A group
      // delimits, so what it holds is a list of its own -- an interface body
      // is protected as a `typeMember` run and holds one protected member per
      // member, and carrying the category through the brace flattened every
      // member back into loose tokens.
      category: SyntaxCategory | undefined,
    ): readonly Syntax[] => {
      let normalized: Syntax[] | undefined;
      for (let at = 0; at < children.length; at += 1) {
        const child = children[at]!;
        const replacement = normalizeChild(child, category, children.length);
        if (replacement === undefined) {
          normalized?.push(child);
          continue;
        }
        normalized ??= children.slice(0, at);
        normalized.push(...replacement);
      }
      return normalized ?? children;
    };

    const children = normalizeChildren(node.children, node.category);
    if (children === node.children) return node;
    return createProtectedSyntax({
      ...node,
      id: options.allocateSyntaxId(),
      children,
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
   *    or operator in it is described once, in its own words.
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
      if (reportedAlready.some((diagnostic) => mentions(diagnostic, run)))
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
      offeredOperatorTokens.clear();
      refusedOperatorSpans.length = 0;
      operatorDiagnostics.length = 0;
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
      reportSurvivingMacros(
        result.syntax,
        [...operatorDiagnostics, ...result.diagnostics],
        result.namedOrigins,
      );
      reportUnexpandedOperators(
        result.syntax,
        new Set([...result.offeredOperators, ...offeredOperatorTokens]),
        [...operatorDiagnostics, ...recoveryDiagnostics, ...result.diagnostics],
      );
      // Last of the three, so that an item holding a macro or an operator
      // either of them speaks about is described in those words rather than as
      // an item that could not be read.
      reportUnreadItems(result.syntax, [
        ...operatorDiagnostics,
        ...recoveryDiagnostics,
        ...result.diagnostics,
      ]);
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
      });
    },
  } satisfies ExpansionFrontendSession);
}
