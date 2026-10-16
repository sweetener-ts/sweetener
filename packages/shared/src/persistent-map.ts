/**
 * An immutable map from strings: a hash array mapped trie. `set` returns a new
 * map that shares every node the change does not reach, so it costs
 * O(log₃₂ n) where copying a `Map` costs O(n), and every earlier version stays
 * as it was.
 */

const bitsPerLevel = 5;
const levelMask = (1 << bitsPerLevel) - 1;

interface Leaf<Value> {
  readonly kind: "leaf";
  readonly hash: number;
  readonly key: string;
  readonly value: Value;
}

/** Keys whose 32-bit hashes are all equal. */
interface Collision<Value> {
  readonly kind: "collision";
  readonly hash: number;
  readonly leaves: readonly Leaf<Value>[];
}

/** One child for each 5-bit hash fragment set in `bitmap`, in fragment order. */
interface Branch<Value> {
  readonly kind: "branch";
  readonly bitmap: number;
  readonly children: readonly TrieNode<Value>[];
}

type TrieNode<Value> = Leaf<Value> | Collision<Value> | Branch<Value>;

/** FNV-1a over the key's UTF-16 code units. */
function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function fragment(hash: number, shift: number): number {
  return (hash >>> shift) & levelMask;
}

function bitCount(bits: number): number {
  let count = bits - ((bits >>> 1) & 0x55555555);
  count = (count & 0x33333333) + ((count >>> 2) & 0x33333333);
  return Math.imul((count + (count >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function leaf<Value>(hash: number, key: string, value: Value): Leaf<Value> {
  return Object.freeze({ kind: "leaf", hash, key, value });
}

function branch<Value>(
  bitmap: number,
  children: readonly TrieNode<Value>[],
): Branch<Value> {
  return Object.freeze({
    kind: "branch",
    bitmap,
    children: Object.freeze(children),
  });
}

function lookup<Value>(
  node: TrieNode<Value> | undefined,
  hash: number,
  key: string,
): Value | undefined {
  let shift = 0;
  while (node !== undefined) {
    switch (node.kind) {
      case "leaf":
        return node.key === key ? node.value : undefined;
      case "collision":
        if (node.hash !== hash) return undefined;
        return node.leaves.find((candidate) => candidate.key === key)?.value;
      case "branch": {
        const bit = 1 << fragment(hash, shift);
        if ((node.bitmap & bit) === 0) return undefined;
        node = node.children[bitCount(node.bitmap & (bit - 1))];
        shift += bitsPerLevel;
      }
    }
  }
  return undefined;
}

/**
 * A node holding both `existing` and `added`, whose hashes agree on every
 * fragment below `shift`. Two different 32-bit hashes differ in some fragment
 * at or below shift 30, so this recursion ends there at the latest.
 */
function join<Value>(
  existing: Leaf<Value> | Collision<Value>,
  added: Leaf<Value>,
  shift: number,
): TrieNode<Value> {
  if (existing.hash === added.hash) {
    const leaves = existing.kind === "leaf" ? [existing] : existing.leaves;
    return Object.freeze({
      kind: "collision",
      hash: added.hash,
      leaves: Object.freeze([...leaves, added]),
    });
  }
  const existingFragment = fragment(existing.hash, shift);
  const addedFragment = fragment(added.hash, shift);
  if (existingFragment === addedFragment) {
    return branch(1 << existingFragment, [
      join(existing, added, shift + bitsPerLevel),
    ]);
  }
  return branch(
    (1 << existingFragment) | (1 << addedFragment),
    existingFragment < addedFragment ? [existing, added] : [added, existing],
  );
}

function insert<Value>(
  node: TrieNode<Value> | undefined,
  added: Leaf<Value>,
  shift: number,
): TrieNode<Value> {
  if (node === undefined) return added;
  switch (node.kind) {
    case "leaf":
      return node.key === added.key ? added : join(node, added, shift);
    case "collision": {
      if (node.hash !== added.hash) return join(node, added, shift);
      const index = node.leaves.findIndex(
        (candidate) => candidate.key === added.key,
      );
      if (index < 0) return join(node, added, shift);
      const leaves = [...node.leaves];
      leaves[index] = added;
      return Object.freeze({
        kind: "collision",
        hash: node.hash,
        leaves: Object.freeze(leaves),
      });
    }
    case "branch": {
      const bit = 1 << fragment(added.hash, shift);
      const index = bitCount(node.bitmap & (bit - 1));
      const children = [...node.children];
      if ((node.bitmap & bit) === 0) {
        children.splice(index, 0, added);
        return branch(node.bitmap | bit, children);
      }
      children[index] = insert(children[index], added, shift + bitsPerLevel);
      return branch(node.bitmap, children);
    }
  }
}

export class PersistentStringMap<Value> {
  readonly #root: TrieNode<Value> | undefined;

  private constructor(root: TrieNode<Value> | undefined) {
    this.#root = root;
    Object.freeze(this);
  }

  static empty<Value>(): PersistentStringMap<Value> {
    return new PersistentStringMap<Value>(undefined);
  }

  get(key: string): Value | undefined {
    return lookup(this.#root, hashKey(key), key);
  }

  /** This map with `key` bound to `value`. This map does not change. */
  set(key: string, value: Value): PersistentStringMap<Value> {
    return new PersistentStringMap(
      insert(this.#root, leaf(hashKey(key), key, value), 0),
    );
  }
}
