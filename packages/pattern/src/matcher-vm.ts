import {
  defaultResourceBudget,
  neverCancelled,
  ResourceTracker,
  ResourceLimitError,
  type CancellationToken,
  type CaptureSlotId,
  type CardinalityGroupId,
  type OriginId,
  type ProgramCounter,
  type RepetitionId,
  type ResourceBudget,
  type SyntaxClassId,
} from "@sweetener/shared";
import {
  createSyntaxCursor,
  type CursorIdentity,
  type Syntax,
  type SyntaxCursor,
  type SyntaxSequence,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  CaptureRecord,
  createCaptureLeaf,
  createCaptureSequence,
  type CaptureValue,
} from "./capture-record.js";
import type { BindingLiteralKey, TokenLiteralKey } from "./ast.js";
import {
  expectationKey,
  expectationSpecificity,
  type MatchFailure,
  type MatcherExpectation,
} from "./matcher-failure.js";
import type {
  CaptureSlot,
  MatcherInstruction,
  MatcherProgram,
} from "./matcher-program.js";

export interface SyntaxClassMatch {
  readonly cursor: SyntaxCursor;
  readonly syntax: SyntaxSequence;
  readonly fields?: CaptureRecord | undefined;
  readonly origin: OriginId;
}

export interface SyntaxClassBoundary {
  readonly stopTokens: readonly string[];
}

export interface SyntaxClassConsumer {
  (
    classId: SyntaxClassId,
    cursor: SyntaxCursor,
    boundary?: SyntaxClassBoundary,
    /**
     * Told how far a class that did not match got before it failed. Without
     * it a class that read most of its input and then failed is recorded only
     * as not matching where it began, and the mistake inside it is never
     * reported.
     */
    onFailure?: (failure: MatchFailure) => void,
  ): SyntaxClassMatch | undefined;
  readonly describeFailure?:
    ((classId: SyntaxClassId) => string | undefined) | undefined;
  /**
   * What a class is called, for reporting what a rule was waiting for.
   * Separate from `describeFailure`, which answers with the wording a macro
   * author supplied and is absent when they supplied none.
   */
  readonly nameOfClass?:
    ((classId: SyntaxClassId) => string | undefined) | undefined;
}

function classBoundary(
  program: MatcherProgram,
  next: ProgramCounter,
): SyntaxClassBoundary | undefined {
  const instruction = program.instructions[next];
  return instruction?.op === "literal" && instruction.literal.kind === "token"
    ? Object.freeze({ stopTokens: Object.freeze([instruction.literal.raw]) })
    : undefined;
}

export interface ExecuteMatcherOptions {
  readonly consumeClass: SyntaxClassConsumer;
  readonly matchesTokenLiteral?:
    ((token: TokenSyntax, literal: TokenLiteralKey) => boolean) | undefined;
  readonly matchesBindingLiteral?:
    ((token: TokenSyntax, literal: BindingLiteralKey) => boolean) | undefined;
  readonly cancellation?: CancellationToken | undefined;
  readonly budget?: ResourceBudget | undefined;
  readonly tracker?: ResourceTracker | undefined;
  readonly environmentEpoch?: number | undefined;
}

export type MatcherResult = MatcherSuccess | MatcherFailure;

export interface MatcherSuccess {
  readonly matched: true;
  readonly cursor: SyntaxCursor;
  readonly captures: CaptureRecord;
  readonly matcherSteps: number;
  readonly memoizedFailureCount: number;
}

export interface MatcherFailure {
  readonly matched: false;
  readonly matcherSteps: number;
  readonly memoizedFailureCount: number;
  readonly failure: MatchFailure | undefined;
}

interface GroupFrame {
  readonly next: ProgramCounter;
}

interface RepeatFrame {
  readonly repetition: RepetitionId;
  readonly cardinalityGroup: CardinalityGroupId;
  readonly captures: readonly CaptureSlotId[];
  readonly depthBySlot: ReadonlyMap<CaptureSlotId, number>;
  readonly baseline: ReadonlyMap<CaptureSlotId, CaptureValue>;
  readonly accumulated: ReadonlyMap<CaptureSlotId, readonly CaptureValue[]>;
  readonly count: number;
  readonly minimum: number;
  readonly maximum: number | undefined;
  readonly loop: ProgramCounter;
  readonly exit: ProgramCounter;
}

interface ExecutionState {
  pc: ProgramCounter;
  cursor: SyntaxCursor;
  captures: Map<CaptureSlotId, CaptureValue>;
  groups: GroupFrame[];
  repeats: RepeatFrame[];
}

function cloneRepeat(frame: RepeatFrame): RepeatFrame {
  return {
    ...frame,
    baseline: new Map(frame.baseline),
    accumulated: new Map(
      [...frame.accumulated].map(([slot, values]) => [slot, [...values]]),
    ),
    depthBySlot: new Map(frame.depthBySlot),
  };
}

function cloneState(state: ExecutionState): ExecutionState {
  return {
    pc: state.pc,
    cursor: state.cursor.fork(),
    captures: new Map(state.captures),
    groups: [...state.groups],
    repeats: state.repeats.map(cloneRepeat),
  };
}

function tokenMatches(
  syntax: Syntax | undefined,
  instruction: Extract<MatcherInstruction, { op: "literal" }>,
  options: ExecuteMatcherOptions,
): boolean {
  if (syntax?.tag !== "token") return false;
  const literal = instruction.literal;
  if (literal.kind === "token") {
    return (
      (syntax.kind === literal.tokenKind && syntax.raw === literal.raw) ||
      (options.matchesTokenLiteral?.(syntax, literal) ?? false)
    );
  }
  return options.matchesBindingLiteral?.(syntax, literal) ?? false;
}

function lookaheadMatches(
  cursor: SyntaxCursor,
  instruction: Extract<MatcherInstruction, { op: "lookahead" }>,
): boolean {
  const predicate = instruction.predicate;
  if (predicate.kind === "boundary") {
    return predicate.boundary === "start-of-group"
      ? cursor.index === 0
      : cursor.atEnd;
  }
  const syntax = cursor.peek();
  if (predicate.kind === "delimiter") {
    return syntax?.tag === "group" && syntax.delimiter === predicate.delimiter;
  }
  return (
    syntax?.tag === "token" &&
    (predicate.tokenKind === undefined ||
      syntax.kind === predicate.tokenKind) &&
    (predicate.raw === undefined || syntax.raw === predicate.raw)
  );
}

function captureRecord(
  slots: readonly CaptureSlot[],
  values: ReadonlyMap<CaptureSlotId, CaptureValue>,
): CaptureRecord {
  return new CaptureRecord(
    slots.flatMap((slot) => {
      const value = values.get(slot.slot);
      return value === undefined ? [] : [[slot.capture, value] as const];
    }),
  );
}

function materializeRepeat(
  frame: RepeatFrame,
  captures: ReadonlyMap<CaptureSlotId, CaptureValue>,
): Map<CaptureSlotId, CaptureValue> {
  const result = new Map(frame.baseline);
  for (const slot of frame.captures) {
    result.set(
      slot,
      createCaptureSequence({
        depth: frame.depthBySlot.get(slot)!,
        cardinalityGroup: frame.cardinalityGroup,
        elements: frame.accumulated.get(slot) ?? [],
      }),
    );
  }
  for (const [slot, value] of captures) {
    if (!frame.captures.includes(slot)) result.set(slot, value);
  }
  return result;
}

function cursorOffset(cursor: SyntaxCursor): number {
  const syntax = cursor.peek();
  if (syntax !== undefined) return syntax.span.start;
  const parent = cursor.parentLocation;
  if (parent !== undefined) {
    return parent.group.close.span.start;
  }
  const sequence = cursor.remainingRange().sequence;
  return sequence.at(-1)?.span.end ?? 0;
}

/** The syntax a cursor stands at, for reporting a failure there. */
function cursorOrigin(cursor: SyntaxCursor): OriginId | undefined {
  const syntax = cursor.peek();
  if (syntax !== undefined) return syntax.origin;
  const parent = cursor.parentLocation;
  if (parent !== undefined) return parent.group.close.origin;
  return cursor.remainingRange().sequence.at(-1)?.origin;
}

function repetitionShape(frames: readonly RepeatFrame[]): string {
  return frames
    .map((frame) => {
      const lengths = frame.captures
        .map(
          (slot) =>
            `${String(slot)}=${String(frame.accumulated.get(slot)?.length ?? 0)}`,
        )
        .join(",");
      return `${String(frame.repetition)}@${String(frame.count)}[${lengths}]`;
    })
    .join("/");
}

export function executeMatcher(
  program: MatcherProgram,
  input: readonly Syntax[] | SyntaxCursor,
  options: ExecuteMatcherOptions,
): MatcherResult {
  const environmentEpoch = options.environmentEpoch ?? 0;
  if (!Number.isSafeInteger(environmentEpoch) || environmentEpoch < 0) {
    throw new RangeError(
      "Environment epoch must be a non-negative safe integer",
    );
  }
  const cancellation = options.cancellation ?? neverCancelled;
  const tracker =
    options.tracker ??
    new ResourceTracker(options.budget ?? defaultResourceBudget);
  const startingMatcherSteps = tracker.usage.matcherSteps;
  const slotById = new Map(
    program.captureSlots.map((slot) => [slot.slot, slot]),
  );
  const initialCursor = Array.isArray(input)
    ? createSyntaxCursor(input)
    : (input as SyntaxCursor).fork();
  const pending: ExecutionState[] = [
    {
      pc: program.entry,
      cursor: initialCursor,
      captures: new Map(),
      groups: [],
      repeats: [],
    },
  ];
  const failedMemo = new Set<string>();
  let memoizedFailureCount = 0;
  let bestFailure:
    | {
        offset: number;
        cursor: CursorIdentity;
        at: OriginId | undefined;
        specificity: number;
        expectations: Map<string, MatcherExpectation>;
        origins: Set<OriginId>;
      }
    | undefined;

  const record = (failure: MatchFailure): void => {
    if (bestFailure === undefined || failure.offset > bestFailure.offset) {
      bestFailure = {
        offset: failure.offset,
        cursor: failure.cursor,
        at: failure.at,
        specificity: failure.specificity,
        expectations: new Map(
          failure.expectations.map((expectation) => [
            expectationKey(expectation),
            expectation,
          ]),
        ),
        origins: new Set(failure.origins),
      };
      return;
    }
    if (failure.offset < bestFailure.offset) return;
    bestFailure.specificity = Math.max(
      bestFailure.specificity,
      failure.specificity,
    );
    for (const expectation of failure.expectations)
      bestFailure.expectations.set(expectationKey(expectation), expectation);
    for (const origin of failure.origins) bestFailure.origins.add(origin);
    if (failure.cursor < bestFailure.cursor) {
      bestFailure.cursor = failure.cursor;
      bestFailure.at = failure.at ?? bestFailure.at;
    }
  };

  const recordFailure = (
    cursor: SyntaxCursor,
    expectation: MatcherExpectation,
    origin: OriginId,
  ): void =>
    record({
      offset: cursorOffset(cursor),
      cursor: cursor.identity,
      at: cursorOrigin(cursor),
      specificity: expectationSpecificity(expectation),
      expectations: [expectation],
      origins: [origin],
    });

  while (pending.length > 0) {
    const state = pending.pop();
    if (state === undefined) break;
    let running = true;
    while (running) {
      cancellation.throwIfCancellationRequested();
      tracker.chargeMatcherSteps();
      const memoKey = `${String(state.pc)}|${state.cursor.identity}|${String(environmentEpoch)}|${repetitionShape(state.repeats)}`;
      if (failedMemo.has(memoKey)) {
        memoizedFailureCount += 1;
        running = false;
        continue;
      }
      const instruction = program.instructions[state.pc];
      if (instruction === undefined) {
        throw new RangeError(`Invalid matcher PC ${String(state.pc)}`);
      }
      switch (instruction.op) {
        case "literal":
          if (!tokenMatches(state.cursor.peek(), instruction, options)) {
            failedMemo.add(memoKey);
            recordFailure(
              state.cursor,
              Object.freeze({ kind: "literal", literal: instruction.literal }),
              instruction.origin,
            );
            running = false;
            break;
          }
          state.cursor.advance();
          state.pc = instruction.next;
          break;
        case "class": {
          let inner: MatchFailure | undefined;
          const matched = options.consumeClass(
            instruction.classId,
            state.cursor.fork(),
            classBoundary(program, instruction.next),
            (failure) => {
              inner = failure;
            },
          );
          if (matched === undefined) {
            failedMemo.add(memoKey);
            const description = options.consumeClass.describeFailure?.(
              instruction.classId,
            );
            // A class that got past where it began failed at a mistake inside
            // it, and that is the failure to report. One that failed where it
            // began is described as the class.
            const reached = inner as MatchFailure | undefined;
            if (
              reached !== undefined &&
              reached.offset > cursorOffset(state.cursor)
            )
              record(reached);
            recordFailure(
              state.cursor,
              description === undefined
                ? Object.freeze({
                    kind: "class" as const,
                    classId: instruction.classId,
                  })
                : Object.freeze({
                    kind: "description" as const,
                    description,
                  }),
              instruction.origin,
            );
            running = false;
            break;
          }
          state.cursor = matched.cursor;
          if (instruction.capture !== undefined) {
            const slot = slotById.get(instruction.capture);
            if (slot === undefined)
              throw new RangeError(
                `Unknown capture slot ${String(instruction.capture)}`,
              );
            state.captures.set(
              instruction.capture,
              createCaptureLeaf({
                id: slot.capture,
                classId: instruction.classId,
                syntax: matched.syntax,
                fields: matched.fields,
                origin: matched.origin,
              }),
            );
          }
          state.pc = instruction.next;
          break;
        }
        case "lookahead":
          if (!lookaheadMatches(state.cursor, instruction)) {
            failedMemo.add(memoKey);
            recordFailure(
              state.cursor,
              Object.freeze({
                kind: "lookahead",
                predicate: instruction.predicate,
              }),
              instruction.origin,
            );
            running = false;
            break;
          }
          state.pc = instruction.next;
          break;
        case "split": {
          const second = cloneState(state);
          second.pc = instruction.second;
          pending.push(second);
          state.pc = instruction.first;
          break;
        }
        case "group": {
          const syntax = state.cursor.peek();
          if (
            syntax?.tag !== "group" ||
            syntax.delimiter !== instruction.delimiter
          ) {
            failedMemo.add(memoKey);
            recordFailure(
              state.cursor,
              Object.freeze({
                kind: "group",
                delimiter: instruction.delimiter,
              }),
              instruction.origin,
            );
            running = false;
            break;
          }
          const observedDepth = state.cursor.depth + 1;
          if (observedDepth > tracker.budget.maxNestingDepth) {
            throw new ResourceLimitError(
              "nesting-depth",
              tracker.budget.maxNestingDepth,
              observedDepth,
            );
          }
          state.cursor = state.cursor.enterGroup();
          state.groups.push({ next: instruction.next });
          state.pc = instruction.body;
          break;
        }
        case "group-accept": {
          const frame = state.groups.at(-1);
          const outer = state.cursor.atEnd
            ? state.cursor.exitGroup()
            : undefined;
          if (frame === undefined || outer === undefined) {
            failedMemo.add(memoKey);
            recordFailure(
              state.cursor,
              Object.freeze({ kind: "end-of-group" }),
              instruction.origin,
            );
            running = false;
            break;
          }
          state.groups.pop();
          state.cursor = outer;
          state.pc = frame.next;
          break;
        }
        case "repeat-enter": {
          const maximum = instruction.maximum;
          const outerDepth = (slot: CaptureSlotId): number =>
            state.repeats.filter((frame) => frame.captures.includes(slot))
              .length;
          const depthBySlot = new Map<CaptureSlotId, number>();
          for (const slotId of instruction.captures) {
            const slot = slotById.get(slotId);
            if (slot === undefined)
              throw new RangeError(`Unknown capture slot ${String(slotId)}`);
            depthBySlot.set(slotId, slot.depth - outerDepth(slotId));
          }
          const frame: RepeatFrame = {
            repetition: instruction.repetition,
            cardinalityGroup: instruction.cardinalityGroup,
            captures: instruction.captures,
            depthBySlot,
            baseline: new Map(state.captures),
            accumulated: new Map(
              instruction.captures.map((slot) => [slot, []]),
            ),
            count: 0,
            minimum: instruction.minimum,
            maximum,
            loop: instruction.separator ?? instruction.body,
            exit: instruction.exit,
          };
          if (maximum === 0) {
            state.captures = materializeRepeat(frame, state.captures);
            state.pc = instruction.exit;
            break;
          }
          if (instruction.minimum === 0) {
            const exitState = cloneState(state);
            exitState.captures = materializeRepeat(frame, exitState.captures);
            exitState.pc = instruction.exit;
            pending.push(exitState);
          }
          state.repeats.push(frame);
          state.pc = instruction.body;
          break;
        }
        case "repeat-commit": {
          const frame = state.repeats.at(-1);
          if (
            frame === undefined ||
            frame.repetition !== instruction.repetition
          ) {
            throw new Error("Repeat stack does not match commit instruction");
          }
          const accumulated = new Map(frame.accumulated);
          let complete = true;
          for (const slot of frame.captures) {
            const value = state.captures.get(slot);
            if (value === undefined) {
              complete = false;
              break;
            }
            accumulated.set(slot, [...(accumulated.get(slot) ?? []), value]);
          }
          if (!complete) {
            failedMemo.add(memoKey);
            running = false;
            break;
          }
          const count = frame.count + 1;
          const updated: RepeatFrame = { ...frame, accumulated, count };
          const finalized = materializeRepeat(updated, state.captures);
          const canExit = count >= frame.minimum;
          const canLoop = frame.maximum === undefined || count < frame.maximum;
          if (canExit && canLoop) {
            const exitState = cloneState(state);
            exitState.repeats.pop();
            exitState.captures = finalized;
            exitState.pc = frame.exit;
            pending.push(exitState);
          }
          if (!canLoop) {
            state.repeats.pop();
            state.captures = finalized;
            state.pc = frame.exit;
            break;
          }
          state.repeats[state.repeats.length - 1] = updated;
          state.captures = new Map(frame.baseline);
          state.pc = frame.loop;
          break;
        }
        case "accept":
          return Object.freeze({
            matched: true,
            cursor: state.cursor,
            captures: captureRecord(program.captureSlots, state.captures),
            matcherSteps: tracker.usage.matcherSteps - startingMatcherSteps,
            memoizedFailureCount,
          });
      }
    }
  }

  const failure =
    bestFailure === undefined
      ? undefined
      : Object.freeze({
          offset: bestFailure.offset,
          cursor: bestFailure.cursor,
          at: bestFailure.at,
          specificity: bestFailure.specificity,
          expectations: Object.freeze(
            [...bestFailure.expectations.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([, expectation]) => expectation),
          ),
          origins: Object.freeze(
            [...bestFailure.origins].sort((a, b) => a - b),
          ),
        });
  return Object.freeze({
    matched: false,
    matcherSteps: tracker.usage.matcherSteps - startingMatcherSteps,
    memoizedFailureCount,
    failure,
  });
}

export function createSingleSyntaxConsumer(
  classIds: ReadonlySet<SyntaxClassId>,
): SyntaxClassConsumer {
  return (classId, cursor) => {
    if (!classIds.has(classId)) return undefined;
    const syntax = cursor.consume();
    if (syntax === undefined) return undefined;
    return Object.freeze({
      cursor,
      syntax: Object.freeze([syntax]),
      origin: syntax.origin,
    });
  };
}
