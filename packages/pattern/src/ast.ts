import type {
  BindingId,
  CaptureId,
  CardinalityGroupId,
  OriginId,
  RepetitionId,
  SyntaxClassId,
} from "@sweetener/shared";
import type { DelimiterKind, TokenKind } from "@sweetener/syntax";

export interface PatternBase {
  readonly origin: OriginId;
}

export interface TokenLiteralKey {
  readonly kind: "token";
  readonly tokenKind: TokenKind;
  readonly raw: string;
}

export interface BindingLiteralKey {
  readonly kind: "binding";
  readonly binding: BindingId;
  readonly spelling: string;
}

export type LiteralKey = TokenLiteralKey | BindingLiteralKey;

export interface LiteralPattern extends PatternBase {
  readonly kind: "literal";
  readonly literal: LiteralKey;
  /**
   * Whether the literal is written directly after the syntax before it,
   * with nothing between them: the `+` and the `>` of `<+>`, which with the
   * `<` spell one operator a capture before them stops at.
   */
  readonly joined: boolean;
}

export interface ClassCallPattern extends PatternBase {
  readonly kind: "class-call";
  readonly classId: SyntaxClassId;
}

export interface CapturePattern extends PatternBase {
  readonly kind: "capture";
  readonly capture: CaptureId;
  readonly name: string;
  readonly classId: SyntaxClassId;
}

export interface GroupPattern extends PatternBase {
  readonly kind: "group";
  readonly delimiter: DelimiterKind;
  readonly body: SequencePattern;
}

export interface SequencePattern extends PatternBase {
  readonly kind: "sequence";
  readonly elements: readonly PatternNode[];
}

export interface ChoicePattern extends PatternBase {
  readonly kind: "choice";
  readonly alternatives: readonly PatternNode[];
}

export interface RepeatPattern extends PatternBase {
  readonly kind: "repeat";
  readonly repetition: RepetitionId;
  readonly body: PatternNode;
  readonly separator: PatternNode | undefined;
  readonly minimum: number;
  readonly maximum: number | undefined;
  readonly depth: number;
  readonly cardinalityGroup: CardinalityGroupId;
}

export interface OptionalPattern extends PatternBase {
  readonly kind: "optional";
  /**
   * An optional is a repetition bounded at one. It carries a repetition of its
   * own so a body that matches nothing still records an empty sequence for the
   * captures inside it.
   */
  readonly repetition: RepetitionId;
  readonly body: PatternNode;
  readonly depth: number;
  readonly cardinalityGroup: CardinalityGroupId;
}

export type BoundaryKind = "start-of-group" | "end-of-group";

export type LookaheadPredicate =
  | {
      readonly kind: "token";
      readonly tokenKind: TokenKind | undefined;
      readonly raw: string | undefined;
    }
  | { readonly kind: "boundary"; readonly boundary: BoundaryKind }
  | { readonly kind: "delimiter"; readonly delimiter: DelimiterKind };

export interface LookaheadPattern extends PatternBase {
  readonly kind: "lookahead";
  readonly predicate: LookaheadPredicate;
}

export type PatternNode =
  | LiteralPattern
  | CapturePattern
  | GroupPattern
  | SequencePattern
  | ChoicePattern
  | RepeatPattern
  | OptionalPattern
  | ClassCallPattern
  | LookaheadPattern;

const captureNamePattern =
  /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u;

function requireFrozenPattern(pattern: PatternNode, field: string): void {
  if (!Object.isFrozen(pattern)) {
    throw new TypeError(`${field} must be an immutable pattern node`);
  }
}

function requireDepth(depth: number): void {
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new RangeError("Repetition depth must be a positive safe integer");
  }
}

function requireBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function createTokenLiteralKey(
  tokenKind: TokenKind,
  raw: string,
): TokenLiteralKey {
  if (tokenKind !== "end-of-file" && raw.length === 0) {
    throw new RangeError("Token literal spelling must not be empty");
  }
  if (tokenKind === "end-of-file" && raw.length !== 0) {
    throw new RangeError("EOF literal spelling must be empty");
  }
  return Object.freeze({ kind: "token", tokenKind, raw });
}

export function createBindingLiteralKey(
  binding: BindingId,
  spelling: string,
): BindingLiteralKey {
  if (spelling.length === 0) {
    throw new RangeError("Binding literal spelling must not be empty");
  }
  return Object.freeze({ kind: "binding", binding, spelling });
}

export function createLiteralPattern(
  origin: OriginId,
  literal: LiteralKey,
  joined = false,
): LiteralPattern {
  if (!Object.isFrozen(literal)) {
    throw new TypeError("Literal key must be immutable");
  }
  return Object.freeze({ kind: "literal", origin, literal, joined });
}

export function createClassCallPattern(
  origin: OriginId,
  classId: SyntaxClassId,
): ClassCallPattern {
  return Object.freeze({ kind: "class-call", origin, classId });
}

export function createCapturePattern(options: {
  readonly origin: OriginId;
  readonly capture: CaptureId;
  readonly name: string;
  readonly classId: SyntaxClassId;
}): CapturePattern {
  if (!captureNamePattern.test(options.name)) {
    throw new RangeError(`Invalid capture name: ${options.name}`);
  }
  return Object.freeze({ kind: "capture", ...options });
}

export function createSequencePattern(
  origin: OriginId,
  elements: readonly PatternNode[],
): SequencePattern {
  for (const element of elements)
    requireFrozenPattern(element, "Sequence child");
  return Object.freeze({
    kind: "sequence",
    origin,
    elements: Object.freeze([...elements]),
  });
}

export function createGroupPattern(
  origin: OriginId,
  delimiter: DelimiterKind,
  body: SequencePattern,
): GroupPattern {
  requireFrozenPattern(body, "Group body");
  if (body.kind !== "sequence") {
    throw new TypeError("Group body must be a sequence pattern");
  }
  return Object.freeze({ kind: "group", origin, delimiter, body });
}

export function createChoicePattern(
  origin: OriginId,
  alternatives: readonly PatternNode[],
): ChoicePattern {
  if (alternatives.length < 2) {
    throw new RangeError("Choice pattern requires at least two alternatives");
  }
  for (const alternative of alternatives) {
    requireFrozenPattern(alternative, "Choice alternative");
  }
  return Object.freeze({
    kind: "choice",
    origin,
    alternatives: Object.freeze([...alternatives]),
  });
}

export function createRepeatPattern(options: {
  readonly origin: OriginId;
  readonly repetition: RepetitionId;
  readonly body: PatternNode;
  readonly separator?: PatternNode | undefined;
  readonly minimum: number;
  readonly maximum?: number | undefined;
  readonly depth: number;
  readonly cardinalityGroup: CardinalityGroupId;
}): RepeatPattern {
  requireFrozenPattern(options.body, "Repeat body");
  if (options.separator !== undefined) {
    requireFrozenPattern(options.separator, "Repeat separator");
  }
  requireBound(options.minimum, "Repeat minimum");
  if (options.maximum !== undefined) {
    requireBound(options.maximum, "Repeat maximum");
    if (options.maximum < options.minimum) {
      throw new RangeError("Repeat maximum must be at least its minimum");
    }
  }
  requireDepth(options.depth);
  return Object.freeze({
    kind: "repeat",
    origin: options.origin,
    repetition: options.repetition,
    body: options.body,
    separator: options.separator,
    minimum: options.minimum,
    maximum: options.maximum,
    depth: options.depth,
    cardinalityGroup: options.cardinalityGroup,
  });
}

export function createOptionalPattern(options: {
  readonly origin: OriginId;
  readonly repetition: RepetitionId;
  readonly body: PatternNode;
  readonly depth: number;
  readonly cardinalityGroup: CardinalityGroupId;
}): OptionalPattern {
  requireFrozenPattern(options.body, "Optional body");
  requireDepth(options.depth);
  return Object.freeze({ kind: "optional", ...options });
}

export function createTokenLookahead(
  origin: OriginId,
  options: {
    readonly tokenKind?: TokenKind | undefined;
    readonly raw?: string | undefined;
  },
): LookaheadPattern {
  if (options.tokenKind === undefined && options.raw === undefined) {
    throw new RangeError("Token lookahead requires a kind or raw spelling");
  }
  if (options.raw !== undefined && options.raw.length === 0) {
    throw new RangeError("Lookahead raw spelling must not be empty");
  }
  return Object.freeze({
    kind: "lookahead",
    origin,
    predicate: Object.freeze({
      kind: "token",
      tokenKind: options.tokenKind,
      raw: options.raw,
    }),
  });
}

export function createBoundaryLookahead(
  origin: OriginId,
  boundary: BoundaryKind,
): LookaheadPattern {
  return Object.freeze({
    kind: "lookahead",
    origin,
    predicate: Object.freeze({ kind: "boundary", boundary }),
  });
}

export function createDelimiterLookahead(
  origin: OriginId,
  delimiter: DelimiterKind,
): LookaheadPattern {
  return Object.freeze({
    kind: "lookahead",
    origin,
    predicate: Object.freeze({ kind: "delimiter", delimiter }),
  });
}
