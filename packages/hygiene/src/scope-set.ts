import type { ScopeId, ScopeSetId } from "@sweetener/shared";

export interface ScopeSetDebugRecord {
  readonly id: ScopeSetId;
  readonly scopes: readonly ScopeId[];
}

export function normalizeScopes(
  scopes: readonly ScopeId[],
): readonly ScopeId[] {
  return Object.freeze(
    [...new Set(scopes)].sort((left, right) => left - right),
  );
}

export function scopeSetSubset(
  left: readonly ScopeId[],
  right: readonly ScopeId[],
): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftScope = left[leftIndex]!;
    const rightScope = right[rightIndex]!;
    if (leftScope === rightScope) {
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftScope > rightScope) {
      rightIndex += 1;
    } else {
      return false;
    }
  }
  return leftIndex === left.length;
}
