import {
  createIdAllocator,
  type ScopeId,
  type ScopeSetId,
} from "@sweetener/shared";
import { createScope, type Scope, type ScopeKind } from "./scope.js";
import { scopeSetSubset, type ScopeSetDebugRecord } from "./scope-set.js";

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

/**
 * One interned scope set: its parent's scopes with `last` added, where `last`
 * is greater than every scope the parent holds. The sets form a trie over
 * their sorted scopes, so each set has exactly one node, and adding a scope
 * greater than all of a set's scopes, as a freshly allocated scope is, is one
 * lookup.
 */
interface ScopeSetNode {
  readonly id: ScopeSetId;
  readonly parent: ScopeSetNode | undefined;
  readonly last: ScopeId | undefined;
  readonly size: number;
  /** The sorted scopes, built the first time something reads them. */
  scopes: readonly ScopeId[] | undefined;
  /** What adding each scope to this set gave. */
  added: Map<ScopeId, ScopeSetNode> | undefined;
  /** What removing each scope from this set gave. */
  removed: Map<ScopeId, ScopeSetNode> | undefined;
  /** What the union of this set and each smaller set gave. */
  unioned: Map<ScopeSetId, ScopeSetNode> | undefined;
}

export class ScopeStore {
  readonly #scopeIds = createIdAllocator<ScopeId>(1);
  readonly #setIds = createIdAllocator<ScopeSetId>(1);
  readonly #scopes = new Map<ScopeId, Scope>();
  readonly #sets = new Map<ScopeSetId, ScopeSetNode>();
  readonly #invocationPartners = new Map<ScopeId, ScopeId>();
  readonly #publishedTo = new Map<ScopeSetId, ScopeSetId>();
  readonly #empty: ScopeSetNode = {
    id: 0 as ScopeSetId,
    parent: undefined,
    last: undefined,
    size: 0,
    scopes: Object.freeze([]),
    added: undefined,
    removed: undefined,
    unioned: undefined,
  };
  #internHits = 0;

  constructor() {
    this.#sets.set(this.#empty.id, this.#empty);
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
    return this.#empty.id;
  }

  singleton(scope: ScopeId): ScopeSetId {
    return this.add(this.#empty.id, scope);
  }

  add(set: ScopeSetId, scope: ScopeId): ScopeSetId {
    const node = this.#requireSet(set);
    this.#requireScope(scope);
    return this.#add(node, scope).id;
  }

  remove(set: ScopeSetId, scope: ScopeId): ScopeSetId {
    const node = this.#requireSet(set);
    this.#requireScope(scope);
    return this.#remove(node, scope).id;
  }

  flip(set: ScopeSetId, scope: ScopeId): ScopeSetId {
    return this.has(set, scope)
      ? this.remove(set, scope)
      : this.add(set, scope);
  }

  union(left: ScopeSetId, right: ScopeSetId): ScopeSetId {
    const leftNode = this.#requireSet(left);
    const rightNode = this.#requireSet(right);
    if (leftNode === rightNode) return left;
    const [smaller, larger] =
      leftNode.size <= rightNode.size
        ? [leftNode, rightNode]
        : [rightNode, leftNode];
    if (smaller.size === 0) return larger.id;
    if (smaller.size === 1) return this.#add(larger, smaller.last!).id;
    const known = larger.unioned?.get(smaller.id);
    if (known !== undefined) {
      this.#internHits += 1;
      return known.id;
    }
    // The union holds the larger set's scopes below the smaller set's least
    // as they stand, so it steps back only over the larger set's scopes above
    // that one and adds them and the smaller set's in order, each the greatest
    // so far. Adding to a set what it was once extended by finds the set that
    // gave, so the only sets this interns are those the union starts with
    // that the store did not hold.
    const added = descendingScopes(smaller).reverse();
    const least = added[0]!;
    const passed: ScopeId[] = [];
    let union = larger;
    while (union.last !== undefined && union.last > least) {
      passed.push(union.last);
      union = union.parent!;
    }
    let addedIndex = union.last === least ? 1 : 0;
    let passedIndex = passed.length - 1;
    while (addedIndex < added.length || passedIndex >= 0) {
      const fromAdded =
        addedIndex < added.length ? added[addedIndex] : undefined;
      const fromPassed = passedIndex >= 0 ? passed[passedIndex] : undefined;
      const next =
        fromPassed === undefined ||
        (fromAdded !== undefined && fromAdded <= fromPassed)
          ? fromAdded!
          : fromPassed;
      if (fromAdded === next) addedIndex += 1;
      if (fromPassed === next) passedIndex -= 1;
      union = this.#add(union, next);
    }
    (larger.unioned ??= new Map()).set(smaller.id, union);
    return union.id;
  }

  subset(left: ScopeSetId, right: ScopeSetId): boolean {
    const leftNode = this.#requireSet(left);
    const rightNode = this.#requireSet(right);
    if (leftNode === rightNode || leftNode.size === 0) return true;
    if (leftNode.size > rightNode.size) return false;
    return scopeSetSubset(this.#scopesOf(leftNode), this.#scopesOf(rightNode));
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
    const node = this.#requireSet(set);
    return this.#scopesOf(node).some((scope) => {
      const partner = this.#invocationPartners.get(scope);
      return partner !== undefined && !this.#contains(node, partner);
    });
  }

  /**
   * Whether the set carries the introduction scope of an invocation made
   * since `mark` without that invocation's use-site scope: whether a
   * template wrote it, at an invocation made after the mark was taken.
   */
  introducedSince(set: ScopeSetId, mark: ScopeMark): boolean {
    const node = this.#requireSet(set);
    for (
      let since = node;
      since.last !== undefined && since.last >= mark;
      since = since.parent!
    ) {
      const partner = this.#invocationPartners.get(since.last);
      if (partner !== undefined && !this.#contains(node, partner)) return true;
    }
    return false;
  }

  /**
   * Whether the set carries the introduction scope of an invocation, without
   * that invocation's use-site scope, that `other` does not carry: whether a
   * template wrote it at an invocation `other` is no part of.
   */
  introducedApartFrom(set: ScopeSetId, other: ScopeSetId): boolean {
    const node = this.#requireSet(set);
    const otherNode = this.#requireSet(other);
    return this.#scopesOf(node).some((scope) => {
      const partner = this.#invocationPartners.get(scope);
      return (
        partner !== undefined &&
        !this.#contains(node, partner) &&
        !this.#contains(otherNode, scope)
      );
    });
  }

  /**
   * The set with each invocation's introduction and use-site scopes removed
   * where it carries both: the scopes of the call site that `#capture`
   * published an identifier to. A set that carries no such pair is answered
   * as itself.
   */
  publishedTo(set: ScopeSetId): ScopeSetId {
    const known = this.#publishedTo.get(set);
    if (known !== undefined) return known;
    const node = this.#requireSet(set);
    const scopes = this.#scopesOf(node);
    const withdrawn = new Set<ScopeId>();
    for (const scope of scopes) {
      const partner = this.#invocationPartners.get(scope);
      if (partner !== undefined && this.#contains(node, partner)) {
        withdrawn.add(scope);
        withdrawn.add(partner);
      }
    }
    const kept = scopes.filter((scope) => !withdrawn.has(scope));
    const published = this.#rebuild(
      node,
      sharedPrefixLength(kept, scopes),
      kept,
    );
    this.#publishedTo.set(set, published.id);
    return published.id;
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
    return this.#requireSet(set).size;
  }

  /** The set's scopes in ascending order. */
  scopesOf(set: ScopeSetId): readonly ScopeId[] {
    return this.#scopesOf(this.#requireSet(set));
  }

  debugRecord(set: ScopeSetId): ScopeSetDebugRecord {
    return Object.freeze({
      id: set,
      scopes: Object.freeze([...this.#scopesOf(this.#requireSet(set))]),
    });
  }

  serialize(set: ScopeSetId): string {
    const value: SerializedScopeSet = Object.freeze({
      id: set,
      scopes: Object.freeze(
        this.#scopesOf(this.#requireSet(set)).map((scope) => {
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

  /** The node for `node`'s scopes with `scope` added. */
  #add(node: ScopeSetNode, scope: ScopeId): ScopeSetNode {
    const known = node.added?.get(scope);
    if (known !== undefined) {
      this.#internHits += 1;
      return known;
    }
    let result: ScopeSetNode;
    if (node.last === undefined || node.last < scope) {
      result = {
        id: this.#setIds.allocate(),
        parent: node,
        last: scope,
        size: node.size + 1,
        scopes: undefined,
        added: undefined,
        removed: undefined,
        unioned: undefined,
      };
      this.#sets.set(result.id, result);
    } else {
      const greater: ScopeId[] = [];
      let below = node;
      while (below.last !== undefined && below.last > scope) {
        greater.push(below.last);
        below = below.parent!;
      }
      if (below.last === scope) {
        result = node;
      } else {
        result = this.#add(below, scope);
        for (let index = greater.length - 1; index >= 0; index -= 1) {
          result = this.#add(result, greater[index]!);
        }
      }
    }
    (node.added ??= new Map()).set(scope, result);
    return result;
  }

  /** The node for `node`'s scopes with `scope` removed. */
  #remove(node: ScopeSetNode, scope: ScopeId): ScopeSetNode {
    const known = node.removed?.get(scope);
    if (known !== undefined) {
      this.#internHits += 1;
      return known;
    }
    const greater: ScopeId[] = [];
    let below = node;
    while (below.last !== undefined && below.last > scope) {
      greater.push(below.last);
      below = below.parent!;
    }
    let result = node;
    if (below.last === scope) {
      result = below.parent!;
      for (let index = greater.length - 1; index >= 0; index -= 1) {
        result = this.#add(result, greater[index]!);
      }
    }
    (node.removed ??= new Map()).set(scope, result);
    return result;
  }

  /**
   * The node for the sorted `scopes`, whose first `shared` scopes are the
   * first `shared` of `node`'s. It steps back from `node` to the set those
   * scopes form and adds each later scope as the greatest, so the only sets
   * it interns are those the answer's own scopes start with.
   */
  #rebuild(
    node: ScopeSetNode,
    shared: number,
    scopes: readonly ScopeId[],
  ): ScopeSetNode {
    let result = node;
    while (result.size > shared) result = result.parent!;
    for (let index = shared; index < scopes.length; index += 1) {
      result = this.#add(result, scopes[index]!);
    }
    return result;
  }

  /** The node's scopes in ascending order. */
  #scopesOf(node: ScopeSetNode): readonly ScopeId[] {
    if (node.scopes !== undefined) return node.scopes;
    const newer: ScopeId[] = [];
    let built = node;
    while (built.scopes === undefined) {
      newer.push(built.last!);
      built = built.parent!;
    }
    node.scopes = Object.freeze([...built.scopes, ...newer.reverse()]);
    return node.scopes;
  }

  #contains(node: ScopeSetNode, scope: ScopeId): boolean {
    if (node.last === undefined || node.last < scope) return false;
    if (node.last === scope) return true;
    const scopes = this.#scopesOf(node);
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

  #requireSet(set: ScopeSetId): ScopeSetNode {
    const node = this.#sets.get(set);
    if (node === undefined) {
      throw new RangeError(`Unknown scope set ${String(set)}`);
    }
    return node;
  }
}

/** The node's scopes, greatest first, read without building its array. */
function descendingScopes(node: ScopeSetNode): ScopeId[] {
  const scopes: ScopeId[] = [];
  for (let step = node; step.last !== undefined; step = step.parent!)
    scopes.push(step.last);
  return scopes;
}

/** How many scopes the two sorted arrays start with in common. */
function sharedPrefixLength(
  left: readonly ScopeId[],
  right: readonly ScopeId[],
): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}
