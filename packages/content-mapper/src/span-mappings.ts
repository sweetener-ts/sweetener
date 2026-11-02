import type { SourceExpansionInspection } from "@sweetener/compiler";
import {
  SpanMapFeature,
  SpanMapKind,
  type PositionEncoding,
  type SpanMapping,
} from "./protocol.js";
import type { BindingAgreement } from "./binding-agreement.js";

type OriginQueryIndex = SourceExpansionInspection["index"];

/** A segment in JavaScript string indices, before any encoding. */
export interface Segment {
  readonly virtualStart: number;
  readonly virtualEnd: number;
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly kind: SpanMapKind;
  readonly features: number;
  /** Whether a macro copied this from its input, to somewhere else. */
  readonly copied?: boolean | undefined;
}

const identifier = /^#?[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/**
 * How one printed region of the expansion relates to the source it came from.
 *
 * Every region the printer wrote has an origin, and the origin graph leads
 * each one to a single source token: a token the author wrote leads to itself,
 * a token a macro copied from its input leads to where it was copied from, and
 * a token a macro template introduced leads to the head of the invocation
 * that wrote it. That last is still worth a segment, because a type error in a
 * macro's output belongs on the invocation that produced it rather than
 * nowhere. It carries no language-service features, though: hovering the head
 * should describe the head, not a parenthesis the macro wrote around it.
 *
 * Returns nothing for a region with no place in this file: layout the printer
 * inserted, or text whose source is a macro module.
 */
function segmentFor(
  region: ReturnType<OriginQueryIndex["regions"]>[number],
  generatedText: string,
  sourceText: string,
  sourceId: number,
): Segment | undefined {
  const virtual = generatedText.slice(
    region.generatedStart,
    region.generatedEnd,
  );
  if (virtual.trim().length === 0) return undefined;
  if ((region.primary.sourceId as number) !== sourceId) return undefined;
  const { start, end } = region.primary.span;
  const original = sourceText.slice(start, end);
  const written = region.kind === "source" || region.kind === "copied";
  const [kind, features] =
    written && virtual === original
      ? [SpanMapKind.Verbatim, SpanMapFeature.All]
      : written && identifier.test(virtual) && identifier.test(original)
        ? // Hygiene renamed a name the author wrote. It is still the name
          // they wrote, so rename and references follow it.
          [SpanMapKind.Alias, SpanMapFeature.All]
        : [SpanMapKind.Atom, SpanMapFeature.None];
  return {
    virtualStart: region.generatedStart,
    virtualEnd: region.generatedEnd,
    originalStart: start,
    originalEnd: end,
    kind,
    features,
    copied: region.kind === "copied",
  };
}

/** Which segment keeps its original span when two spans collide. */
function precedence(segment: Segment): number {
  if (segment.kind === SpanMapKind.Verbatim) return 0;
  if (segment.kind === SpanMapKind.Alias) return 1;
  return segment.features === SpanMapFeature.None ? 3 : 2;
}

function overlaps(
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean {
  if (left.start === right.start && left.end === right.end) return false;
  // TypeScript orders spans by start and rejects any that begins before the
  // previous one ends, which makes an empty span inside another a collision
  // and an empty span at either edge of one a neighbour.
  const [first, second] =
    left.start < right.start ||
    (left.start === right.start && left.end < right.end)
      ? [left, right]
      : [right, left];
  return second.start < first.end;
}

function spanKey(segment: Segment): string {
  return `${segment.originalStart}:${segment.originalEnd}`;
}

/** The spans that overlap some other span, by `spanKey`. */
function spansThatCollide(segments: readonly Segment[]): ReadonlySet<string> {
  const spans = [
    ...new Map(segments.map((segment) => [spanKey(segment), segment])).values(),
  ].sort(
    (left, right) =>
      left.originalStart - right.originalStart ||
      left.originalEnd - right.originalEnd,
  );
  const colliding = new Set<string>();
  let reaching: Segment | undefined;
  for (const span of spans) {
    if (
      reaching !== undefined &&
      overlaps(
        { start: reaching.originalStart, end: reaching.originalEnd },
        { start: span.originalStart, end: span.originalEnd },
      )
    ) {
      colliding.add(spanKey(reaching));
      colliding.add(spanKey(span));
    }
    if (reaching === undefined || span.originalEnd > reaching.originalEnd)
      reaching = span;
  }
  return colliding;
}

/**
 * Keep the segments whose original spans TypeScript can accept together.
 *
 * TypeScript lets any number of segments share one original span, but two
 * different spans may not overlap. Source tokens are disjoint, so the spans
 * the origin graph produces almost always are too; the exception is an origin
 * whose source is wider than one token. Where two collide, the segment that
 * says more keeps its span -- text copied as written over a renamed name, a
 * renamed name over an atom -- and the other is left unmapped, which
 * TypeScript reads as text the mapper synthesized.
 */
export function compatibleSegments(segments: readonly Segment[]): Segment[] {
  const ranked = [...segments].sort(
    (left, right) =>
      precedence(left) - precedence(right) ||
      left.originalEnd -
        left.originalStart -
        (right.originalEnd - right.originalStart) ||
      left.virtualStart - right.virtualStart,
  );
  const colliding = spansThatCollide(segments);
  // Distinct accepted spans that collide with another, ordered by start and
  // pairwise disjoint. Few spans ever do, so inserting among them costs little.
  const accepted: { start: number; end: number }[] = [];
  const kept: Segment[] = [];
  for (const segment of ranked) {
    if (!colliding.has(spanKey(segment))) {
      kept.push(segment);
      continue;
    }
    const span = { start: segment.originalStart, end: segment.originalEnd };
    let low = 0;
    let high = accepted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const candidate = accepted[middle]!;
      if (
        candidate.start < span.start ||
        (candidate.start === span.start && candidate.end < span.end)
      )
        low = middle + 1;
      else high = middle;
    }
    const same = accepted[low];
    if (
      same !== undefined &&
      same.start === span.start &&
      same.end === span.end
    ) {
      kept.push(segment);
      continue;
    }
    const before = accepted[low - 1];
    const after = accepted[low];
    if (
      (before !== undefined && overlaps(before, span)) ||
      (after !== undefined && overlaps(after, span))
    )
      continue;
    accepted.splice(low, 0, span);
    kept.push(segment);
  }
  return kept.sort((left, right) => left.virtualStart - right.virtualStart);
}

/**
 * Keep rename from a name whose copies do not agree on what it names.
 *
 * TypeScript renames by binding and writes each edit back through the segment
 * it lands in. A token the author wrote once and a macro copied once has one
 * binding, so that is sound. A token copied several times usually does too --
 * `twice(value)` refers to one `value` twice -- but need not: a macro may use
 * one captured name both to declare a parameter and to refer to the name
 * outside it. Renaming either binding would rewrite the one token both copies
 * came from, and change the other binding's meaning without a word.
 *
 * So where the copies of a name disagree, they become atoms with no rename.
 * A rename cannot start there, and one started at either declaration cannot
 * write through them: the reference stays as it was and TypeScript reports it,
 * which is a mistake the author sees rather than one they do not.
 */
function withoutAmbiguousRename(
  segments: Segment[],
  agreement: BindingAgreement,
  generatedText: string,
): Segment[] {
  const copies = new Map<string, Segment[]>();
  for (const segment of segments) {
    if (
      segment.kind === SpanMapKind.Atom ||
      !identifier.test(
        generatedText.slice(segment.virtualStart, segment.virtualEnd),
      )
    )
      continue;
    const key = spanKey(segment);
    const group = copies.get(key);
    if (group === undefined) copies.set(key, [segment]);
    else group.push(segment);
  }
  const ambiguous = new Set<Segment>();
  const place = ({ virtualStart, virtualEnd }: Segment) => ({
    start: virtualStart,
    end: virtualEnd,
  });
  for (const group of copies.values()) {
    if (group.length > 1 && !agreement.agree(group.map(place)))
      for (const segment of group) ambiguous.add(segment);
    // Where a macro copied a name to stand for two, TypeScript would spell out
    // both in its place, `foo: renamed`, and write that into the macro's
    // input: `obj(foo: renamed)`. One copy is enough for that.
    for (const segment of group)
      if (segment.copied === true && agreement.abbreviates(place(segment)))
        ambiguous.add(segment);
  }
  const writing = SpanMapFeature.Rename | SpanMapFeature.LinkedEditing;
  return segments.map((segment) =>
    ambiguous.has(segment)
      ? {
          ...segment,
          kind: SpanMapKind.Atom,
          features: segment.features & ~writing,
        }
      : segment,
  );
}

/**
 * Join neighbouring segments of text the author wrote, where what stands
 * between them is the same on both sides.
 *
 * Each token has its own segment, which leaves the whitespace between them
 * mapped to nothing and the place two tokens touch inside both. TypeScript
 * mapping an edit there made it twice, and lost any edit to the whitespace, so
 * formatting `x:number` wrote `x:  number`. Joined, the text is one segment, as
 * it is one text.
 */
function joinedAsWritten(
  segments: readonly Segment[],
  generatedText: string,
  sourceText: string,
): Segment[] {
  const joined: Segment[] = [];
  const joins = (segment: Segment) =>
    segment.kind === SpanMapKind.Verbatim &&
    segment.features === SpanMapFeature.All &&
    segment.copied !== true;
  for (const segment of segments) {
    const last = joined.at(-1);
    if (
      last !== undefined &&
      joins(last) &&
      joins(segment) &&
      last.virtualEnd <= segment.virtualStart &&
      last.originalEnd <= segment.originalStart &&
      generatedText.slice(last.virtualEnd, segment.virtualStart) ===
        sourceText.slice(last.originalEnd, segment.originalStart)
    )
      joined[joined.length - 1] = {
        ...last,
        virtualEnd: segment.virtualEnd,
        originalEnd: segment.originalEnd,
      };
    else joined.push(segment);
  }
  return joined;
}

/** The segments for one expanded file, in virtual order. */
export function segmentsForExpansion(options: {
  readonly index: OriginQueryIndex;
  readonly generatedText: string;
  readonly sourceText: string;
  readonly sourceId: number;
  /** What the names at places in the expansion mean. */
  readonly agreement: BindingAgreement;
}): Segment[] {
  const segments: Segment[] = [];
  for (const region of options.index.regions()) {
    const segment = segmentFor(
      region,
      options.generatedText,
      options.sourceText,
      options.sourceId,
    );
    if (segment !== undefined) segments.push(segment);
  }
  return compatibleSegments(
    joinedAsWritten(
      withoutAmbiguousRename(
        compatibleSegments(segments),
        options.agreement,
        options.generatedText,
      ),
      options.generatedText,
      options.sourceText,
    ),
  );
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Converts JavaScript string indices into offsets in the negotiated encoding.
 *
 * UTF-16 is what a JavaScript string counts in already. UTF-8 counts bytes, so
 * each index is converted through the byte length of the text before it; the
 * table is built once per text rather than once per offset.
 */
export function offsetEncoder(
  text: string,
  encoding: PositionEncoding,
): (index: number) => number {
  if (encoding === "utf-16") return (index) => index;
  const bytesBefore = new Uint32Array(text.length + 1);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    // A surrogate pair is four bytes; count them on the high half and nothing
    // on the low half, so an index between the halves is never produced. A
    // surrogate on its own is not a character, and reaches TypeScript as the
    // replacement character U+FFFD, three bytes.
    const high = isHighSurrogate(unit);
    const low = isLowSurrogate(unit);
    const paired = high
      ? isLowSurrogate(text.charCodeAt(index + 1))
      : low && isHighSurrogate(text.charCodeAt(index - 1));
    const width =
      unit < 0x80 ? 1 : unit < 0x800 ? 2 : !paired ? 3 : high ? 4 : 0;
    bytesBefore[index + 1] = bytesBefore[index]! + width;
  }
  return (index) => {
    const offset = bytesBefore[index];
    if (offset === undefined)
      throw new RangeError(`Offset ${index} is outside the text`);
    return offset;
  };
}

/** The compact tuples the protocol carries. */
export function encodeSegments(
  segments: readonly Segment[],
  virtualText: string,
  originalText: string,
  encoding: PositionEncoding,
): SpanMapping[] {
  const virtual = offsetEncoder(virtualText, encoding);
  const original = offsetEncoder(originalText, encoding);
  return segments.map((segment) => {
    const virtualStart = virtual(segment.virtualStart);
    const originalStart = original(segment.originalStart);
    const head = [
      virtualStart,
      virtual(segment.virtualEnd) - virtualStart,
      originalStart,
      original(segment.originalEnd) - originalStart,
      segment.kind,
    ] as const;
    return segment.features === SpanMapFeature.All
      ? head
      : [...head, segment.features];
  });
}
