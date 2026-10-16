import {
  createIdAllocator,
  type ScopeId,
  type ScopeSetId,
} from "@sweetener/shared";
import { createScope, type Scope, type ScopeKind } from "./scope.js";
import {
  scopeSetKey,
  scopeSetSubset,
  unionScopeArrays,
  type ScopeSetDebugRecord,
} from "./scope-set.js";

export interface ScopeStoreStats {
  readonly allocatedScopes: number;
  readonly internedSets: number;
  readonly internHits: number;
}

declare const scopeMarkBrand: unique symbol;

/**
 * A point in the order scopes are allocated in. Every scope allocated after
 * the mark was taken is later than it.
 */
export type ScopeMark = number & { readonly [scopeMarkBrand]: "ScopeMark" };

export interface SerializedScope {
  readonly id: ScopeId;
  readonly kind: ScopeKind;
  readonly label: string | undefined;
}

export interface SerializedScopeSet {
  readonly id: ScopeSetId;
  readonly scopes: readonly SerializedScope[];
}

export class ScopeStore {
  readonly #scopeIds = createIdAllocator<ScopeId>(1);
  readonly #setIds = createIdAllocator<ScopeSetId>(1);
  readonly #scopes = new Map<ScopeId, Scope>();
  readonly #sets = new Map<ScopeSetId, readonly ScopeId[]>();
  readonly #setByKey = new Map<string, ScopeSetId>();
  readonly #keyBySet = new Map<ScopeSetId, string>();
  readonly #invocationPartners = new Map<ScopeId, ScopeId>();
  readonly #empty = 0 as ScopeSetId;
  #internHits = 0;

  constructor() {
    const scopes = Object.freeze([]) as readonly ScopeId[];
    this.#sets.set(this.#empty, scopes);
    this.#setByKey.set("", this.#empty);
    this.#keyBySet.set(this.#empty, "");
  }

  get stats(): ScopeStoreStats {
    return Object.freeze({
      allocatedScopes: this.#scopes.size,
      internedSets: this.#sets.size,
      internHits: this.#internHits,
    });
  }

  freshScope(kind: ScopeKind = "lexical", label?: string | undefined): ScopeId {
    const id = this.#scopeIds.allocate();
    this.#scopes.set(id, createScope(id, kind, label));
    return id;
  }

  empty(): ScopeSetId {
    return this.#empty;
  }

  singleton(scope: ScopeId): ScopeSetId {
    this.#requireScope(scope);
    return this.#intern([scope]);
  }

  add(set: ScopeSetId, scope: ScopeId): ScopeSetId {
    const scopes = this.#requireSet(set);
    this.#requireScope(scope);
    if (this.#contains(scopes, scope)) return set;
    if (scopes.length === 0 || scopes[scopes.length - 1]! < scope) {
      const previousKey = this.#keyBySet.get(set)!;
      return this.#intern(
        [...scopes, scope],
        previousKey.length === 0
          ? String(scope)
          : `${previousKey},${String(scope)}`,
      );
    }
    let insertion = 0;
    while (insertion < scopes.length && scopes[insertion]! < scope)
      insertion += 1;
    return this.#intern([
      ...scopes.slice(0, insertion),
      scope,
      ...scopes.slice(insertion),
    ]);
  }

  remove(set: ScopeSetId, scope: ScopeId): ScopeSetId {
    const scopes = this.#requireSet(set);
    this.#requireScope(scope);
    if (!this.#contains(scopes, scope)) return set;
    return this.#intern(scopes.filter((candidate) => candidate !== scope));
  }

  flip(set: ScopeSetId, scope: ScopeId): ScopeSetId {
    return this.has(set, scope)
      ? this.remove(set, scope)
      : this.add(set, scope);
  }

  union(left: ScopeSetId, right: ScopeSetId): ScopeSetId {
    if (left === right) return this.#requireSetId(left);
    const leftScopes = this.#requireSet(left);
    const rightScopes = this.#requireSet(right);
    if (leftScopes.length === 0) return right;
    if (rightScopes.length === 0) return left;
    return this.#intern(unionScopeArrays(leftScopes, rightScopes));
  }

  subset(left: ScopeSetId, right: ScopeSetId): boolean {
    return scopeSetSubset(this.#requireSet(left), this.#requireSet(right));
  }

  /**
   * Records the two scopes one macro invocation works with. Template syntax
   * carries the introduction scope; syntax that reached the expansion from the
   * call site carries the use-site scope instead.
   */
  pairInvocationScopes(introduction: ScopeId, useSite: ScopeId): void {
    if (this.#requireScope(introduction).kind !== "introduction")
      throw new TypeError("Invocation pairing needs an introduction scope");
    if (this.#requireScope(useSite).kind !== "use-site")
      throw new TypeError("Invocation pairing needs a use-site scope");
    this.#invocationPartners.set(introduction, useSite);
  }

  /**
   * Whether the set belongs to some template without also belonging to that
   * invocation's call site. Syntax a macro wrote itself answers true; captured
   * syntax, and identifiers a binding contract or `#capture` deliberately
   * publishes to the call site, answer false.
   */
  hasUnmatchedIntroduction(set: ScopeSetId): boolean {
    const scopes = this.#requireSet(set);
    return scopes.some((scope) => {
      const partner = this.#invocationPartners.get(scope);
      return partner !== undefined && !this.#contains(scopes, partner);
    });
  }

  /**
   * Whether the set carries the introduction scope of an invocation made
   * since `mark` without that invocation's use-site scope: whether a
   * template wrote it, at an invocation made after the mark was taken.
   */
  introducedSince(set: ScopeSetId, mark: ScopeMark): boolean {
    const scopes = this.#requireSet(set);
    return scopes.some((scope) => {
      if (scope < mark) return false;
      const partner = this.#invocationPartners.get(scope);
      return partner !== undefined && !this.#contains(scopes, partner);
    });
  }

  /** The point in allocation order the next scope will be allocated at. */
  mark(): ScopeMark {
    return this.#scopeIds.nextValue as ScopeMark;
  }

  has(set: ScopeSetId, scope: ScopeId): boolean {
    this.#requireScope(scope);
    return this.#contains(this.#requireSet(set), scope);
  }

  size(set: ScopeSetId): number {
    return this.#requireSet(set).length;
  }

  debugRecord(set: ScopeSetId): ScopeSetDebugRecord {
    return Object.freeze({
      id: set,
      scopes: Object.freeze([...this.#requireSet(set)]),
    });
  }

  serialize(set: ScopeSetId): string {
    const value: SerializedScopeSet = Object.freeze({
      id: set,
      scopes: Object.freeze(
        this.#requireSet(set).map((scope) => {
          const metadata = this.#scopes.get(scope)!;
          return Object.freeze({
            id: metadata.id,
            kind: metadata.kind,
            label: metadata.label,
          });
        }),
      ),
    });
    return JSON.stringify(value);
  }

  #intern(scopes: readonly ScopeId[], knownKey?: string): ScopeSetId {
    const frozen = Object.isFrozen(scopes) ? scopes : Object.freeze(scopes);
    const key = knownKey ?? scopeSetKey(frozen);
    const existing = this.#setByKey.get(key);
    if (existing !== undefined) {
      this.#internHits += 1;
      return existing;
    }
    const id = this.#setIds.allocate();
    this.#sets.set(id, frozen);
    this.#setByKey.set(key, id);
    this.#keyBySet.set(id, key);
    return id;
  }

  #contains(scopes: readonly ScopeId[], scope: ScopeId): boolean {
    let low = 0;
    let high = scopes.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const candidate = scopes[middle]!;
      if (candidate === scope) return true;
      if (candidate < scope) low = middle + 1;
      else high = middle - 1;
    }
    return false;
  }

  #requireScope(scope: ScopeId): Scope {
    const value = this.#scopes.get(scope);
    if (value === undefined) {
      throw new RangeError(`Unknown scope ${String(scope)}`);
    }
    return value;
  }

  #requireSet(set: ScopeSetId): readonly ScopeId[] {
    const scopes = this.#sets.get(set);
    if (scopes === undefined) {
      throw new RangeError(`Unknown scope set ${String(set)}`);
    }
    return scopes;
  }

  #requireSetId(set: ScopeSetId): ScopeSetId {
    this.#requireSet(set);
    return set;
  }
}
