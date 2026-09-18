import {
  applyBindingContracts,
  createInvocationScopes,
  type Binding,
  type BindingEnvironment,
  type BindingContract,
  type ApplyBindingContractsOptions,
  type EnvironmentStore,
  type Phase,
  type ScopeStore,
} from "@sweetener/hygiene";
import {
  describeFailureAs,
  describeRefinement,
  evaluateRefinement,
  evaluateRefinements,
  executeMatcher,
  farthestFailure,
  type BindingLiteralKey,
  type CaptureRecord,
  type CaptureRefinement,
  type CaptureValue,
  type MatchFailure,
  type MatcherProgram,
  type SyntaxClassConsumer,
  describeExpectations,
} from "@sweetener/pattern";
import {
  neverCancelled,
  type BindingId,
  type CancellationToken,
  type Diagnostic,
  type EnvironmentEpoch,
  type InvocationId,
  type OriginId,
  type ResourceTracker,
  type RuleId,
  type ScopeId,
  type ScopeSetId,
  type SourceSpan,
  type SyntaxId,
} from "@sweetener/shared";
import {
  SyntaxRange,
  type OriginStore,
  type ProtectedSyntax,
  type Syntax,
  type SyntaxCategory,
  type SyntaxCursor,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  evaluateTemplate,
  instantiateTemplate,
  type FreshBinding,
  type SequenceTemplate,
  type TemplateOperationTrace,
} from "@sweetener/template";
import { EnforestationError } from "./enforestation-error.js";
import {
  bareMacroNameCode,
  expansionDiagnosticRegistry,
  noMatchingMacroRuleCode,
  uncategorizedExpansionCode,
} from "./diagnostics.js";
import type { CoreDispatchTrace } from "./core-shadowing.js";
import { createExpansionFingerprint, type ExpansionGuard } from "./progress.js";

export interface CompiledMacroRule {
  readonly rule: RuleId;
  readonly origin: OriginId;
  readonly fallback: boolean;
  readonly matcher: MatcherProgram;
  readonly template: SequenceTemplate;
  readonly contracts: readonly BindingContract[];
  readonly refinements: readonly CaptureRefinement[];
  readonly requiredContexts: readonly MacroContext[];
  readonly failureDescription?: string | undefined;
}

export type MacroContext = "generator";

export interface CompiledMacroBinding {
  readonly binding: Binding;
  readonly category: SyntaxCategory;
  readonly definitionScopes: ScopeSetId;
  readonly rules: readonly CompiledMacroRule[];
  /**
   * Whether the binding is a syntax parameter. A `#parameterize` naming it
   * gives it another meaning for the syntax it wraps; elsewhere it expands by
   * its rules, and a parameter declared without rules has no meaning there.
   */
  readonly parameter: boolean;
}

export interface RuleAttemptTrace {
  readonly rule: RuleId;
  readonly status: "no-match" | "boundary-rejected" | "selected";
  readonly matcherSteps: number;
  readonly failure: MatchFailure | undefined;
}

export interface CaptureSummary {
  readonly capture: number;
  readonly name: string;
  readonly values: number;
}

export interface IntroducedBindingSummary {
  readonly binding: BindingId;
  readonly spelling: string;
  readonly space: Binding["space"];
  readonly declaration: OriginId;
}

export interface MacroTraceEvent {
  readonly invocationId: InvocationId;
  readonly parent: InvocationId | undefined;
  readonly binding: BindingId;
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly invocationOrigin: OriginId;
  readonly attemptedRules: readonly RuleAttemptTrace[];
  readonly selectedRule: RuleId | undefined;
  readonly captures: readonly CaptureSummary[];
  readonly scopesIntroduced: readonly ScopeId[];
  readonly bindingsIntroduced: readonly IntroducedBindingSummary[];
  readonly operations: readonly TemplateOperationTrace[];
  readonly outputOrigins: readonly OriginId[];
  readonly cache: "miss" | "hit";
  readonly coreInterception: CoreDispatchTrace | undefined;
}

export interface BoundaryAdmissionRequest {
  readonly category: SyntaxCategory;
  readonly consumed: SyntaxRange;
  readonly cursor: SyntaxCursor;
  readonly rule: CompiledMacroRule;
}

export interface ExpandReplacementRequest {
  readonly syntax: readonly Syntax[];
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly environmentEpoch: EnvironmentEpoch;
  readonly invocationId: InvocationId;
  readonly followingScopes: ScopeSetId;
  readonly environment: BindingEnvironment;
}

export interface InvokeMacroOptions {
  readonly macro: CompiledMacroBinding;
  readonly cursor: SyntaxCursor;
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly environmentEpoch: EnvironmentEpoch;
  readonly consumeClass: SyntaxClassConsumer;
  readonly matchesBindingLiteral?:
    ((token: TokenSyntax, literal: BindingLiteralKey) => boolean) | undefined;
  readonly scopeStore: ScopeStore;
  readonly origins: OriginStore;
  readonly environments: EnvironmentStore;
  readonly environment: BindingEnvironment;
  readonly tracker: ResourceTracker;
  readonly guard: ExpansionGuard;
  readonly cancellation?: CancellationToken | undefined;
  readonly allocateSyntaxId: () => SyntaxId;
  readonly allocateBindingId: () => BindingId;
  readonly allocateInvocationId: () => InvocationId;
  readonly parentInvocation?: InvocationId | undefined;
  readonly contexts?: ReadonlySet<MacroContext> | undefined;
  readonly coreInterception?: CoreDispatchTrace | undefined;
  readonly position: number;
  readonly extractBindings?: ApplyBindingContractsOptions["extractBindings"];
  readonly admit: (request: BoundaryAdmissionRequest) => boolean;
  readonly expandReplacement: (
    request: ExpandReplacementRequest,
  ) => ProtectedSyntax;
  readonly diagnosticOrigin: (origin: OriginId) => SourceSpan;
}

export interface MacroInvocationSuccess {
  readonly expanded: true;
  readonly syntax: ProtectedSyntax;
  readonly cursor: SyntaxCursor;
  readonly environment: BindingEnvironment;
  readonly followingScopes: ScopeSetId;
  readonly freshBindings: readonly FreshBinding[];
  readonly trace: MacroTraceEvent;
}

export interface MacroInvocationFailure {
  readonly expanded: false;
  readonly cursor: SyntaxCursor;
  readonly diagnostic: Diagnostic;
  readonly trace: MacroTraceEvent;
}

export type MacroInvocationResult =
  MacroInvocationSuccess | MacroInvocationFailure;

function countValues(value: CaptureValue): number {
  if (value.kind === "leaf") return 1;
  return value.elements.reduce(
    (total, element) => total + countValues(element),
    0,
  );
}

function captureSummaries(
  program: MatcherProgram,
  captures: CaptureRecord,
): readonly CaptureSummary[] {
  return Object.freeze(
    program.captureSlots.map((slot) => {
      const value = captures.get(slot.capture);
      return Object.freeze({
        capture: slot.capture,
        name: slot.name,
        values: value === undefined ? 0 : countValues(value),
      });
    }),
  );
}

function orderedRules(rules: readonly CompiledMacroRule[]) {
  return [
    ...rules.filter((rule) => !rule.fallback),
    ...rules.filter((rule) => rule.fallback),
  ];
}

function validateMacro(
  macro: CompiledMacroBinding,
  category: SyntaxCategory,
): void {
  if (macro.binding.kind !== "macro" && macro.binding.kind !== "operator") {
    throw new TypeError("Invocation requires a macro or operator binding");
  }
  if (macro.category !== category) {
    throw new TypeError(`Cannot invoke ${macro.category} macro as ${category}`);
  }
  if (macro.rules.length === 0)
    throw new RangeError("Macro has no compiled rules");
  for (const rule of macro.rules) {
    if (rule.matcher.rule !== rule.rule) {
      throw new TypeError("Matcher and compiled macro rule identities differ");
    }
  }
}

function validateCoreInterception(
  trace: CoreDispatchTrace | undefined,
  macro: CompiledMacroBinding,
  category: SyntaxCategory,
  phase: Phase,
): void {
  if (trace === undefined) return;
  if (
    trace.decision !== "shadow-macro" ||
    trace.selected !== macro.binding.id ||
    trace.spelling !== macro.binding.spelling ||
    trace.category !== category ||
    trace.phase !== phase
  ) {
    throw new TypeError(
      "Core-interception trace does not select this macro invocation",
    );
  }
}

/**
 * The tokens by which the syntax a name stands in goes on past the name: the
 * `;` that terminates a statement, the `,` that separates it from the next
 * entry of a list, the `.` or `?.` that reads a member of what it denotes.
 *
 * None of them can be the beginning of an invocation. A rule written with one
 * reads it -- `rule { q.all }` matches the `.` and stops beyond it -- so a
 * rule that stopped in front of one was offered nothing of the macro's. Every
 * other token may be a macro's: an operator, a word, a literal or a group
 * written after a name is as readily a rule's syntax as the enclosing code's,
 * and a rule that stopped in front of one was offered something and refused it.
 */
const continuesEnclosingSyntax: ReadonlySet<string> = new Set([
  ";",
  ",",
  ".",
  "?.",
]);

export function invokeMacro(
  options: InvokeMacroOptions,
): MacroInvocationResult {
  validateMacro(options.macro, options.category);
  validateCoreInterception(
    options.coreInterception,
    options.macro,
    options.category,
    options.phase,
  );
  if (options.guard.tracker !== options.tracker) {
    throw new TypeError("Expansion guard and invocation must share a tracker");
  }
  if (
    options.cancellation !== undefined &&
    options.guard.cancellation !== neverCancelled &&
    options.guard.cancellation !== options.cancellation
  ) {
    throw new TypeError(
      "Expansion guard and invocation must share a cancellation token",
    );
  }
  const cancellation = options.cancellation ?? options.guard.cancellation;
  cancellation.throwIfCancellationRequested();
  const invocationHead = options.cursor.peek();
  if (invocationHead === undefined) {
    throw new RangeError("Cannot invoke a macro at end of input");
  }
  const invocationId = options.allocateInvocationId();
  const attempts: RuleAttemptTrace[] = [];
  const failures: MatchFailure[] = [];
  const startRange = options.cursor.remainingRange();
  /**
   * Whether any rule's pattern matched, whatever refused it afterwards. A
   * name no rule could even begin to read is a name, not an invocation some
   * rule wanted written differently.
   */
  let anyRuleMatched = false;
  /**
   * Where a rule that read the macro's name and nothing more comes to a stop:
   * the syntax written straight after the head, in the sequence the head
   * stands in.
   *
   * A rule that stopped anywhere else read syntax of the macro's own -- it
   * went into the group written after the name, or past the first thing it
   * accepted -- and what it was still waiting for is what to report. A rule
   * that stopped here read nothing but the name.
   */
  const headIdentity = options.cursor.identity;
  const afterHeadSyntax = options.cursor.peek(1);
  const afterHead = options.cursor.fork();
  afterHead.advance();
  const afterHeadIdentity = afterHead.identity;
  /**
   * Whether any rule read past the macro's name. Set for a rule that offered
   * no failure at all, since nothing then says where it stopped.
   */
  let anyRuleReadPastHead = false;
  const readPastHead = (failure: MatchFailure | undefined): boolean =>
    failure === undefined ||
    (failure.cursor !== headIdentity && failure.cursor !== afterHeadIdentity);

  for (const rule of orderedRules(options.macro.rules)) {
    cancellation.throwIfCancellationRequested();
    const matched = executeMatcher(rule.matcher, options.cursor, {
      consumeClass: options.consumeClass,
      matchesTokenLiteral: (token, literal) =>
        token === invocationHead &&
        literal.raw === options.macro.binding.spelling &&
        token.kind === literal.tokenKind,
      matchesBindingLiteral: options.matchesBindingLiteral,
      cancellation,
      tracker: options.tracker,
      environmentEpoch: options.environmentEpoch,
    });
    if (!matched.matched) {
      const failure =
        matched.failure === undefined || rule.failureDescription === undefined
          ? matched.failure
          : describeFailureAs(matched.failure, rule.failureDescription);
      if (failure !== undefined) failures.push(failure);
      if (readPastHead(failure)) anyRuleReadPastHead = true;
      attempts.push(
        Object.freeze({
          rule: rule.rule,
          status: "no-match",
          matcherSteps: matched.matcherSteps,
          failure,
        }),
      );
      continue;
    }
    anyRuleMatched = true;
    // A rule's `refine` clauses narrow what it accepts beyond what its pattern
    // can say -- how a captured name is spelled, which delimiter surrounded a
    // capture, how many times a repetition ran. A rule whose refinements fail
    // did not match, and the next rule is offered the same input.
    if (!evaluateRefinements(rule.refinements, matched.captures)) {
      const refused = rule.refinements.find(
        (refinement) => !evaluateRefinement(refinement, matched.captures),
      );
      const failure = Object.freeze({
        offset:
          matched.cursor.peek()?.span.start ??
          options.cursor.peek()?.span.start ??
          0,
        cursor: matched.cursor.identity,
        at: matched.cursor.peek()?.origin ?? invocationHead.origin,
        specificity: 7,
        expectations: Object.freeze([
          Object.freeze({
            kind: "description" as const,
            description:
              rule.failureDescription ??
              (refused === undefined
                ? "input this rule was refined to accept"
                : describeRefinement(refused.predicate)),
          }),
        ]),
        origins: Object.freeze([rule.origin]),
      });
      failures.push(failure);
      attempts.push(
        Object.freeze({
          rule: rule.rule,
          status: "no-match" as const,
          matcherSteps: matched.matcherSteps,
          failure,
        }),
      );
      continue;
    }
    const consumed = new SyntaxRange(
      startRange.sequence,
      options.cursor.index,
      matched.cursor.index,
    );
    const missingContext = rule.requiredContexts.find(
      (required) => !options.contexts?.has(required),
    );
    if (missingContext !== undefined) {
      const failure = Object.freeze({
        offset:
          matched.cursor.peek()?.span.start ??
          consumed.at(consumed.length - 1)?.span.end ??
          0,
        cursor: matched.cursor.identity,
        at: matched.cursor.peek()?.origin ?? invocationHead.origin,
        specificity: 8,
        expectations: Object.freeze([
          Object.freeze({
            kind: "description" as const,
            description: `${missingContext} context`,
          }),
        ]),
        origins: Object.freeze([rule.origin]),
      });
      failures.push(failure);
      attempts.push(
        Object.freeze({
          rule: rule.rule,
          status: "boundary-rejected" as const,
          matcherSteps: matched.matcherSteps,
          failure,
        }),
      );
      continue;
    }
    if (
      !options.admit({
        category: options.category,
        consumed,
        cursor: matched.cursor,
        rule,
      })
    ) {
      attempts.push(
        Object.freeze({
          rule: rule.rule,
          status: "boundary-rejected",
          matcherSteps: matched.matcherSteps,
          failure: undefined,
        }),
      );
      continue;
    }

    const fingerprint = createExpansionFingerprint({
      binding: options.macro.binding.id,
      category: options.category,
      phase: options.phase,
      input: consumed.toArray(),
      environmentEpoch: options.environmentEpoch,
    });
    return options.guard.run(fingerprint, () => {
      attempts.push(
        Object.freeze({
          rule: rule.rule,
          status: "selected",
          matcherSteps: matched.matcherSteps,
          failure: undefined,
        }),
      );
      const invocationScopes = createInvocationScopes(options.scopeStore);
      const contracts = applyBindingContracts({
        contracts: rule.contracts,
        captures: matched.captures,
        scopeStore: options.scopeStore,
        environments: options.environments,
        environment: options.environment,
        phase: options.phase,
        position: options.position,
        extractBindings: options.extractBindings,
      });
      const evaluated = evaluateTemplate(rule.template, {
        captures: contracts.captures,
        tracker: options.tracker,
        cancellation,
      });
      const instantiated = instantiateTemplate(evaluated.output, {
        scopeStore: options.scopeStore,
        origins: options.origins,
        invocationScopes,
        invocationOrigin: invocationHead.origin,
        definitionScopes: options.macro.definitionScopes,
        callsiteScopes: invocationHead.scopes,
        anchor: {
          start: invocationHead.span.start,
          end: invocationHead.span.start,
        },
        allocateSyntaxId: options.allocateSyntaxId,
        allocateBindingId: options.allocateBindingId,
        generatedBindings: contracts.generatedBindings,
        tracker: options.tracker,
        cancellation,
      });
      let expanded;
      try {
        expanded = options.expandReplacement({
          syntax: instantiated.syntax,
          category: options.category,
          phase: options.phase,
          environmentEpoch: options.environmentEpoch,
          invocationId,
          followingScopes: contracts.followingScopes,
          environment: contracts.environment,
        });
      } catch (error) {
        // The rule's template did not produce one node of the category this
        // macro declares -- two statements where an expression was wanted, or
        // JSX in a file whose extension cannot hold it. That is something its
        // author wrote, so it is reported against the invocation rather than
        // thrown, which would abandon the expansion of every file in the
        // project and name neither the macro nor where it was written.
        if (!(error instanceof EnforestationError)) throw error;
        return Object.freeze({
          expanded: false as const,
          cursor: options.cursor.fork(),
          diagnostic: expansionDiagnosticRegistry.create(
            uncategorizedExpansionCode,
            {
              primaryOrigin: options.diagnosticOrigin(invocationHead.origin),
              messageArguments: [
                options.macro.binding.spelling,
                error.category,
                error.syntaxText,
              ],
              relatedOrigins: [
                {
                  message: "This rule produced it",
                  origin: options.diagnosticOrigin(rule.origin),
                },
              ],
            },
          ),
          trace: Object.freeze({
            invocationId,
            parent: options.parentInvocation,
            binding: options.macro.binding.id,
            category: options.category,
            phase: options.phase,
            invocationOrigin: invocationHead.origin,
            attemptedRules: Object.freeze(attempts),
            selectedRule: rule.rule,
            captures: Object.freeze([]),
            scopesIntroduced: Object.freeze([]),
            bindingsIntroduced: Object.freeze([]),
            operations: Object.freeze([]),
            outputOrigins: Object.freeze([]),
            cache: "miss" as const,
            coreInterception: options.coreInterception,
          }),
        });
      }
      if (expanded.category !== options.category) {
        throw new TypeError(
          `Recursive expansion returned ${expanded.category} for ${options.category}`,
        );
      }
      const trace: MacroTraceEvent = Object.freeze({
        invocationId,
        parent: options.parentInvocation,
        binding: options.macro.binding.id,
        category: options.category,
        phase: options.phase,
        invocationOrigin: invocationHead.origin,
        attemptedRules: Object.freeze(attempts),
        selectedRule: rule.rule,
        captures: captureSummaries(rule.matcher, contracts.captures),
        scopesIntroduced: Object.freeze([
          invocationScopes.introduction,
          invocationScopes.useSite,
          ...contracts.introducedScopes,
        ]),
        bindingsIntroduced: Object.freeze(
          contracts.bindings.map((binding) =>
            Object.freeze({
              binding: binding.id,
              spelling: binding.spelling,
              space: binding.space,
              declaration: binding.declaration,
            }),
          ),
        ),
        operations: evaluated.trace,
        outputOrigins: instantiated.outputOrigins,
        cache: "miss",
        coreInterception: options.coreInterception,
      });
      return Object.freeze({
        expanded: true,
        syntax: expanded,
        cursor: matched.cursor,
        environment: contracts.environment,
        followingScopes: contracts.followingScopes,
        freshBindings: instantiated.freshBindings,
        trace,
      });
    });
  }

  const failure = farthestFailure(failures);
  // What the closest rule was still waiting for, rather than how many rules
  // were tried. A count says only that something is wrong; this says what
  // could have been written there.
  //
  // Wording a macro author wrote for this rule is used as they wrote it: they
  // know what the rule is for, and phrasing it again around their sentence
  // would only garble it.
  const described = failure?.expectations.find(
    (expectation) => expectation.kind === "description",
  );
  const expected =
    described?.kind === "description"
      ? described.description
      : failure === undefined
        ? undefined
        : describeExpectations(
            failure.expectations,
            options.consumeClass.nameOfClass,
          );
  const trace: MacroTraceEvent = Object.freeze({
    invocationId,
    parent: options.parentInvocation,
    binding: options.macro.binding.id,
    category: options.category,
    phase: options.phase,
    invocationOrigin: invocationHead.origin,
    attemptedRules: Object.freeze(attempts),
    selectedRule: undefined,
    captures: Object.freeze([]),
    scopesIntroduced: Object.freeze([]),
    bindingsIntroduced: Object.freeze([]),
    operations: Object.freeze([]),
    outputOrigins: Object.freeze([]),
    cache: "miss",
    coreInterception: options.coreInterception,
  });
  // A macro name no rule read past was offered no syntax of the macro's own,
  // whatever stands beside it. That is not a malformed invocation: the name
  // stands on its own, as a reference to something the emitted code does not
  // define, and reporting it as a failed match blamed the macro for wanting
  // syntax the author never meant to write.
  //
  // What may stand beside it is what the syntax around the name goes on with.
  // `export default query;` ends the statement, `query.length` reads a member
  // of the name, `pair(query, 1)` writes it as one argument of someone else's
  // list -- each is a use of the name as a name, and a rule stopped in front
  // of that token having read nothing but the name. A rule that went into the
  // group of `query(db, 1)`, or that stopped in front of the `neither` of
  // `choose neither` or the `=` of `state = 1;`, was offered syntax that could
  // have been its own, and what it was still waiting for is the better answer.
  if (
    !anyRuleMatched &&
    !anyRuleReadPastHead &&
    invocationHead.tag === "token" &&
    (invocationHead.kind === "identifier" ||
      invocationHead.kind === "jsx-identifier" ||
      invocationHead.kind === "keyword") &&
    (afterHeadSyntax === undefined ||
      (afterHeadSyntax.tag === "token" &&
        continuesEnclosingSyntax.has(afterHeadSyntax.raw)))
  ) {
    return Object.freeze({
      expanded: false,
      cursor: options.cursor.fork(),
      diagnostic: expansionDiagnosticRegistry.create(bareMacroNameCode, {
        primaryOrigin: options.diagnosticOrigin(invocationHead.origin),
        messageArguments: [options.macro.binding.spelling, options.category],
      }),
      trace,
    });
  }
  return Object.freeze({
    expanded: false,
    cursor: options.cursor.fork(),
    // Reported where the closest rule stopped, which is where the mistake is:
    // a `=` written for `==` deep in a clause, reported at the macro's name,
    // would say only that something in the whole invocation is wrong.
    diagnostic: expansionDiagnosticRegistry.create(noMatchingMacroRuleCode, {
      primaryOrigin: options.diagnosticOrigin(
        failure?.at ?? invocationHead.origin,
      ),
      messageArguments: [
        options.macro.binding.spelling,
        expected ?? `${String(attempts.length)} rule attempt(s)`,
      ],
      relatedOrigins: [
        ...(failure?.at === undefined || failure.at === invocationHead.origin
          ? []
          : [
              {
                message: `In this use of ${options.macro.binding.spelling}`,
                origin: options.diagnosticOrigin(invocationHead.origin),
              },
            ]),
        ...(failure === undefined
          ? []
          : failure.origins.map((origin) => ({
              message: "The closest rule was still expecting syntax here",
              origin: options.diagnosticOrigin(origin),
            }))),
      ],
    }),
    trace,
  });
}
