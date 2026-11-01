import type { SpanMapping } from "../src/protocol.js";

/**
 * TypeScript's own check of a content mapper's span map.
 *
 * A port of `SpanMap.Validate` in typescript-go's `internal/spanmap`, which
 * rejects the whole transform when it fails. Tests run every mapping through
 * this so a mapping TypeScript would refuse fails here, with the rule it broke,
 * rather than as a file that silently stops type-checking in an editor.
 * Offsets are UTF-16, the encoding these tests negotiate.
 */
export function spanMapProblem(
  mappings: readonly SpanMapping[],
  virtual: string,
  original: string,
): string | undefined {
  let previousVirtualEnd = 0;
  const segments = mappings.map(
    ([
      virtualStart,
      virtualLength,
      originalStart,
      originalLength,
      kind,
      features,
    ]) => ({
      virtualStart,
      virtualEnd: virtualStart + virtualLength,
      originalStart,
      originalEnd: originalStart + originalLength,
      kind,
      features: features ?? (1 << 20) - 1,
    }),
  );
  for (const segment of segments) {
    if (
      segment.virtualStart < previousVirtualEnd ||
      segment.virtualEnd < segment.virtualStart ||
      segment.virtualEnd > virtual.length
    )
      return `virtual overlap or out of order at ${segment.virtualStart}`;
    previousVirtualEnd = segment.virtualEnd;
    if (
      segment.originalStart < 0 ||
      segment.originalEnd < segment.originalStart ||
      segment.originalEnd > original.length
    )
      return `original out of bounds at ${segment.originalEnd}`;
    if (segment.kind !== 0 && segment.kind !== 1 && segment.kind !== 2)
      return `invalid kind at ${segment.virtualStart}`;
    if (
      segment.kind === 0 &&
      virtual.slice(segment.virtualStart, segment.virtualEnd) !==
        original.slice(segment.originalStart, segment.originalEnd)
    )
      return `verbatim mismatch at virtual ${segment.virtualStart}, original ${segment.originalStart}`;
    if ((segment.features & ~((1 << 20) - 1)) !== 0)
      return `invalid features at ${segment.originalStart}`;
  }
  const byOriginal = [...segments].sort(
    (left, right) =>
      left.originalStart - right.originalStart ||
      left.originalEnd - right.originalEnd ||
      left.virtualStart - right.virtualStart,
  );
  for (let index = 0; index < byOriginal.length;) {
    let groupEnd = index + 1;
    while (
      groupEnd < byOriginal.length &&
      byOriginal[groupEnd]!.originalStart ===
        byOriginal[index]!.originalStart &&
      byOriginal[groupEnd]!.originalEnd === byOriginal[index]!.originalEnd
    )
      groupEnd += 1;
    if (
      index > 0 &&
      byOriginal[index]!.originalStart < byOriginal[index - 1]!.originalEnd
    )
      return `original overlap at ${byOriginal[index]!.originalStart}`;
    index = groupEnd;
  }
  return undefined;
}
