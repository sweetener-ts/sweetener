export interface ResourceBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxExpansionSteps: number;
  readonly maxTemplateSteps: number;
  readonly maxMatcherSteps: number;
  readonly maxNestingDepth: number;
  readonly deadlineMs: number | undefined;
}

export type ResourceKind =
  | "input-tokens"
  | "output-tokens"
  | "expansion-steps"
  | "template-steps"
  | "matcher-steps"
  | "nesting-depth"
  | "deadline";

export const defaultResourceBudget: ResourceBudget = Object.freeze({
  maxInputTokens: 1_000_000,
  maxOutputTokens: 4_000_000,
  maxExpansionSteps: 1_000_000,
  maxTemplateSteps: 1_000_000,
  maxMatcherSteps: 10_000_000,
  maxNestingDepth: 1_024,
  deadlineMs: undefined,
});

export class ResourceLimitError extends Error {
  override readonly name = "ResourceLimitError";

  constructor(
    readonly kind: ResourceKind,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`Resource limit exceeded for ${kind}: ${observed} > ${limit}`);
  }
}

function validateLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function createResourceBudget(
  overrides: Partial<ResourceBudget> = {},
): ResourceBudget {
  const budget: ResourceBudget = {
    ...defaultResourceBudget,
    ...overrides,
  };
  validateLimit("maxInputTokens", budget.maxInputTokens);
  validateLimit("maxOutputTokens", budget.maxOutputTokens);
  validateLimit("maxExpansionSteps", budget.maxExpansionSteps);
  validateLimit("maxTemplateSteps", budget.maxTemplateSteps);
  validateLimit("maxMatcherSteps", budget.maxMatcherSteps);
  validateLimit("maxNestingDepth", budget.maxNestingDepth);
  if (
    budget.deadlineMs !== undefined &&
    (!Number.isFinite(budget.deadlineMs) || budget.deadlineMs < 0)
  ) {
    throw new RangeError("deadlineMs must be a non-negative finite number");
  }
  return Object.freeze(budget);
}

export interface ResourceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly expansionSteps: number;
  readonly templateSteps: number;
  readonly matcherSteps: number;
  readonly nestingDepth: number;
}

export class ResourceTracker {
  #inputTokens = 0;
  #outputTokens = 0;
  #expansionSteps = 0;
  #templateSteps = 0;
  #matcherSteps = 0;
  #nestingDepth = 0;

  /**
   * When this tracker started, so `deadlineMs` can mean how long expansion may
   * take rather than a moment in history. Read as an absolute time, any
   * plausible setting — `deadlineMs: 30000` for thirty seconds — would be
   * decades past and fail on the first check.
   */
  readonly #startedAt: number;

  constructor(
    readonly budget: ResourceBudget,
    private readonly now: () => number = Date.now,
  ) {
    this.#startedAt = now();
  }

  get usage(): ResourceUsage {
    return {
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      expansionSteps: this.#expansionSteps,
      templateSteps: this.#templateSteps,
      matcherSteps: this.#matcherSteps,
      nestingDepth: this.#nestingDepth,
    };
  }

  chargeInputTokens(count = 1): void {
    this.#inputTokens = this.#charge(
      "input-tokens",
      this.#inputTokens,
      count,
      this.budget.maxInputTokens,
    );
  }

  chargeOutputTokens(count = 1): void {
    this.#outputTokens = this.#charge(
      "output-tokens",
      this.#outputTokens,
      count,
      this.budget.maxOutputTokens,
    );
  }

  chargeExpansionSteps(count = 1): void {
    this.#expansionSteps = this.#charge(
      "expansion-steps",
      this.#expansionSteps,
      count,
      this.budget.maxExpansionSteps,
    );
  }

  chargeTemplateSteps(count = 1): void {
    this.#templateSteps = this.#charge(
      "template-steps",
      this.#templateSteps,
      count,
      this.budget.maxTemplateSteps,
    );
  }

  chargeMatcherSteps(count = 1): void {
    this.#matcherSteps = this.#charge(
      "matcher-steps",
      this.#matcherSteps,
      count,
      this.budget.maxMatcherSteps,
    );
  }

  enterNesting(): void {
    this.#nestingDepth = this.#charge(
      "nesting-depth",
      this.#nestingDepth,
      1,
      this.budget.maxNestingDepth,
    );
  }

  leaveNesting(): void {
    if (this.#nestingDepth === 0) {
      throw new RangeError("Cannot leave nesting depth zero");
    }
    this.#nestingDepth -= 1;
  }

  checkDeadline(): void {
    if (this.budget.deadlineMs === undefined) return;
    // At or past the budget, so a deadline of zero permits no work at all
    // rather than quietly allowing anything that finishes within the same
    // millisecond.
    const elapsed = this.now() - this.#startedAt;
    if (elapsed >= this.budget.deadlineMs) {
      throw new ResourceLimitError("deadline", this.budget.deadlineMs, elapsed);
    }
  }

  #charge(
    kind: ResourceKind,
    current: number,
    count: number,
    limit: number,
  ): number {
    validateLimit("charge count", count);
    const observed = current + count;
    if (!Number.isSafeInteger(observed) || observed > limit) {
      throw new ResourceLimitError(kind, limit, observed);
    }
    this.checkDeadline();
    return observed;
  }
}
