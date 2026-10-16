import type { Phase } from "@sweetener/hygiene";
import {
  neverCancelled,
  type CancellationToken,
  type EnvironmentEpoch,
  type ResourceTracker,
} from "@sweetener/shared";
import {
  SyntaxRange,
  type CursorIdentity,
  type ProtectedSyntax,
  type SyntaxCategory,
  type SyntaxCursor,
  type TokenReading,
  type TokenSyntax,
} from "@sweetener/syntax";
import { StopSet } from "./stop-set.js";

export interface ConsumerFailure {
  readonly category: SyntaxCategory;
  readonly cursor: CursorIdentity;
  readonly progress: number;
  readonly specificity: number;
  readonly expectations: readonly string[];
}

export interface ConsumerAttemptSuccess {
  readonly matched: true;
  readonly syntax: ProtectedSyntax;
  readonly cursor: SyntaxCursor;
}

export interface ConsumerAttemptFailure {
  readonly matched: false;
  readonly failure: ConsumerFailure;
}

export type ConsumerAttempt = ConsumerAttemptSuccess | ConsumerAttemptFailure;

/**
 * Told of a token the reader read the other way from the grammar, where the
 * consumers cannot read it as the grammar does in place: a `/` read as a
 * division where an operand begins, a regular expression read where an
 * operator stands, or a bare `<T>` read as type parameters where an operand
 * begins, which in a JSX file opens an element. `reading` is how the grammar
 * reads it.
 *
 * The reader judges these from what stands around them, and only the parser
 * knows which each is (see `TokenReadings`). Where reading a slash the other
 * way changes only the tokens of the one expression, the expression reader
 * reads them so where they stand and tells no one. Where it changes more --
 * a bracket or a quote between the slashes, or an element's text read as
 * code -- what a consumer reads after the token was read from groups that are
 * not there, so whoever reads the source reads it again with the token read
 * as the grammar says. A consumer reading speculatively -- a macro rule's
 * capture, tried and perhaps abandoned for the next rule -- is given a
 * listener that holds what it finds until the reading is settled, because
 * where it stands an operand may begin only in a reading that is never taken.
 *
 * A consumer is not told whether the file it reads is a JSX file, so it says
 * how a `<` reads where JSX is read; whoever reads the source knows, and
 * there is no element to read anywhere else.
 */
export type MisreadListener = (
  token: TokenSyntax,
  reading: TokenReading,
) => void;

export interface ConsumerContext {
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly environmentEpoch: EnvironmentEpoch;
  readonly stopSet: StopSet;
  readonly tracker: ResourceTracker;
  readonly cancellation: CancellationToken;
  /** Whether `yield` is an expression here, as it is only inside a generator. */
  readonly allowYield: boolean;
  /**
   * Whether `await` is an expression here, as it is only inside an async
   * function and at the top level of a module.
   */
  readonly allowAwait: boolean;
  /** Told of a token read the other way from the grammar, where one is. */
  readonly misread?: MisreadListener | undefined;
}

export interface ConsumeRequest {
  readonly cursor: SyntaxCursor;
  readonly phase: Phase;
  readonly environmentEpoch: EnvironmentEpoch;
  readonly tracker: ResourceTracker;
  readonly stopSet?: StopSet | undefined;
  readonly cancellation?: CancellationToken | undefined;
  readonly allowYield: boolean;
  readonly allowAwait: boolean;
  readonly misread?: MisreadListener | undefined;
}

export interface ConsumeSuccess extends ConsumerAttemptSuccess {
  readonly consumed: SyntaxRange;
}

export type ConsumeResult = ConsumeSuccess | ConsumerAttemptFailure;

export interface SyntaxConsumer {
  consume(cursor: SyntaxCursor, context: ConsumerContext): ConsumerAttempt;
}

export interface ConsumerRegistryEntry {
  readonly category: SyntaxCategory;
  readonly consumer: SyntaxConsumer;
}

function requireNonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

export function createConsumerFailure(
  options: ConsumerFailure,
): ConsumerFailure {
  requireNonNegative(options.progress, "Consumer failure progress");
  requireNonNegative(options.specificity, "Consumer failure specificity");
  if (options.expectations.length === 0) {
    throw new RangeError("Consumer failure requires an expectation");
  }
  const expectations = [...new Set(options.expectations)];
  if (expectations.some((expectation) => expectation.length === 0)) {
    throw new RangeError("Consumer expectations must not be empty");
  }
  expectations.sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    ...options,
    expectations: Object.freeze(expectations),
  });
}

export function mergeConsumerFailures(
  failures: readonly ConsumerFailure[],
): ConsumerFailure | undefined {
  if (failures.length === 0) return undefined;
  let bestProgress = -1;
  let bestSpecificity = -1;
  for (const failure of failures) {
    if (
      failure.progress > bestProgress ||
      (failure.progress === bestProgress &&
        failure.specificity > bestSpecificity)
    ) {
      bestProgress = failure.progress;
      bestSpecificity = failure.specificity;
    }
  }
  const best = failures.filter(
    (failure) =>
      failure.progress === bestProgress &&
      failure.specificity === bestSpecificity,
  );
  return createConsumerFailure({
    category: [...best].sort((left, right) =>
      left.category.localeCompare(right.category),
    )[0]!.category,
    cursor: [...best].sort((left, right) =>
      left.cursor.localeCompare(right.cursor),
    )[0]!.cursor,
    progress: bestProgress,
    specificity: bestSpecificity,
    expectations: best.flatMap((failure) => failure.expectations),
  });
}

export class ConsumerNotRegisteredError extends Error {
  override readonly name = "ConsumerNotRegisteredError";

  constructor(readonly category: SyntaxCategory) {
    super(`No syntax consumer is registered for ${category}`);
  }
}

export class ConsumerProgressError extends Error {
  override readonly name = "ConsumerProgressError";
}

export class ConsumerRegistry {
  readonly #consumers: ReadonlyMap<SyntaxCategory, SyntaxConsumer>;

  constructor(entries: readonly ConsumerRegistryEntry[] = []) {
    const consumers = new Map<SyntaxCategory, SyntaxConsumer>();
    for (const entry of entries) {
      if (consumers.has(entry.category)) {
        throw new RangeError(`Duplicate ${entry.category} syntax consumer`);
      }
      if (!Object.isFrozen(entry.consumer)) {
        throw new TypeError("Syntax consumer must be immutable");
      }
      consumers.set(entry.category, entry.consumer);
    }
    this.#consumers = consumers;
    Object.freeze(this);
  }

  withConsumer(
    category: SyntaxCategory,
    consumer: SyntaxConsumer,
  ): ConsumerRegistry {
    if (this.#consumers.has(category)) {
      throw new RangeError(`Duplicate ${category} syntax consumer`);
    }
    return new ConsumerRegistry([
      ...[...this.#consumers].map(([existingCategory, existingConsumer]) =>
        Object.freeze({
          category: existingCategory,
          consumer: existingConsumer,
        }),
      ),
      Object.freeze({ category, consumer }),
    ]);
  }

  consume(category: SyntaxCategory, request: ConsumeRequest): ConsumeResult {
    const consumer = this.#consumers.get(category);
    if (consumer === undefined) throw new ConsumerNotRegisteredError(category);
    const cancellation = request.cancellation ?? neverCancelled;
    cancellation.throwIfCancellationRequested();
    request.tracker.checkDeadline();
    request.tracker.chargeExpansionSteps();
    const stopSet = request.stopSet ?? StopSet.empty;
    if (stopSet.matches(request.cursor)) {
      return Object.freeze({
        matched: false,
        failure: createConsumerFailure({
          category,
          cursor: request.cursor.identity,
          progress: 0,
          specificity: 1,
          expectations: [`${category} before stop boundary`],
        }),
      });
    }
    const start = request.cursor.index;
    const remaining = request.cursor.remainingRange();
    const working = request.cursor.fork();
    const attempt = consumer.consume(
      working,
      Object.freeze({
        category,
        phase: request.phase,
        environmentEpoch: request.environmentEpoch,
        stopSet,
        tracker: request.tracker,
        cancellation,
        allowYield: request.allowYield,
        allowAwait: request.allowAwait,
        misread: request.misread,
      }),
    );
    cancellation.throwIfCancellationRequested();
    request.tracker.checkDeadline();
    if (!attempt.matched) {
      if (attempt.failure.category !== category) {
        throw new TypeError(
          `${category} consumer returned a failure for ${attempt.failure.category}`,
        );
      }
      return Object.freeze({
        matched: false,
        failure: createConsumerFailure(attempt.failure),
      });
    }
    if (attempt.syntax.category !== category) {
      throw new TypeError(
        `${category} consumer returned protected ${attempt.syntax.category} syntax`,
      );
    }
    const startLocation = request.cursor.identity
      .split(":")
      .slice(0, 2)
      .join(":");
    const endLocation = attempt.cursor.identity
      .split(":")
      .slice(0, 2)
      .join(":");
    if (
      endLocation !== startLocation ||
      attempt.cursor.depth !== request.cursor.depth ||
      attempt.cursor.index <= start
    ) {
      throw new ConsumerProgressError(
        `${category} consumer must advance in the original syntax sequence`,
      );
    }
    if (attempt.cursor.index > remaining.end) {
      throw new ConsumerProgressError(
        `${category} consumer exceeded its input sequence`,
      );
    }
    return Object.freeze({
      ...attempt,
      consumed: new SyntaxRange(
        remaining.sequence,
        start,
        attempt.cursor.index,
      ),
    });
  }
}

/**
 * Claims a macro invocation during enforestation and returns its full extent.
 * The extent can reach past what the category would otherwise consume — a
 * trailing block after an expression, for instance — so the parse has to ask
 * before committing.
 */
export type MacroExtentResolver = (
  category: "expr" | "binding" | "stmt" | "item" | "type" | "typeMember",
  cursor: SyntaxCursor,
  context: ConsumerContext,
) => ConsumerAttempt | undefined;
