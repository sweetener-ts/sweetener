export interface Span {
  readonly start: number;
  readonly end: number;
}

export function createSpan(start: number, end: number): Span {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new RangeError(`Invalid span: [${String(start)}, ${String(end)})`);
  }
  return Object.freeze({ start, end });
}

export function spanLength(span: Span): number {
  return span.end - span.start;
}

export function spansEqual(left: Span, right: Span): boolean {
  return left.start === right.start && left.end === right.end;
}

export function spanContains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Smallest span containing every input, including non-monotonic generated syntax. */
export function spanEnvelope(spans: readonly Span[]): Span {
  if (spans.length === 0) throw new RangeError("Cannot envelope zero spans");
  // Read in a loop rather than spread into `Math.min`: a chain of operators
  // is one node of every operand and operator in it, and a spread of a
  // hundred thousand spans is more arguments than a call can take.
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const span of spans) {
    if (span.start < start) start = span.start;
    if (span.end > end) end = span.end;
  }
  return createSpan(start, end);
}
