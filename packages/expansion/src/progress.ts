import type { Phase } from "@sweetener/hygiene";
import {
  neverCancelled,
  type BindingId,
  type CancellationToken,
  type EnvironmentEpoch,
  type ResourceTracker,
} from "@sweetener/shared";
import type { Syntax, SyntaxCategory, TokenSyntax } from "@sweetener/syntax";

declare const expansionInputHashBrand: unique symbol;

export type ExpansionInputHash = string & {
  readonly [expansionInputHashBrand]: "ExpansionInputHash";
};

interface HasherState {
  readonly left: number;
  readonly right: number;
}

class InputHasher {
  #left = 0x811c9dc5;
  #right = 0x9e3779b9;

  // Every expansion step hashes its whole input to recognise a macro that is
  // not making progress, so this runs over every token and every piece of
  // trivia in a file. Building a string per field to hash it would allocate
  // several strings per token; the tag, the length and the characters are
  // mixed directly instead.
  add(value: string | number | undefined): void {
    if (value === undefined) {
      this.#mixCode(0x75);
      return;
    }
    if (typeof value === "number") {
      this.#mixCode(0x6e);
      this.#mixCode(value | 0);
      this.#mixCode(Math.floor(value / 0x1_0000_0000) | 0);
      return;
    }
    this.#mixCode(0x73);
    this.#mixCode(value.length);
    this.#mix(value);
  }

  /**
   * Mixes in what another hasher has mixed, as `state` gave it, a byte at a
   * time as characters are mixed. Mixed a word at a time, a multiply carries
   * a word's high bits no lower, and the hash of syntax nested one level
   * deeper each time settled on one value within twenty levels.
   */
  addState(state: HasherState): void {
    this.#mixCode(0x64);
    for (const word of [state.left, state.right])
      for (let shift = 0; shift < 32; shift += 8)
        this.#mixCode((word >>> shift) & 0xff);
  }

  state(): HasherState {
    return { left: this.#left, right: this.#right };
  }

  digest(): ExpansionInputHash {
    return `${this.#left.toString(16).padStart(8, "0")}${this.#right
      .toString(16)
      .padStart(8, "0")}` as ExpansionInputHash;
  }

  #mixCode(code: number): void {
    this.#left = Math.imul(this.#left ^ code, 0x01000193) >>> 0;
    this.#right =
      (Math.imul(this.#right ^ code, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
  }

  #mix(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      this.#left = Math.imul(this.#left ^ code, 0x01000193) >>> 0;
      this.#right =
        (Math.imul(this.#right ^ code, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
    }
  }
}

function addToken(hasher: InputHasher, token: TokenSyntax): void {
  hasher.add(token.kind);
  hasher.add(token.raw);
  hasher.add(token.value);
  hasher.add(token.lexicalMode);
  hasher.add(token.leadingTrivia.length);
  for (const trivia of token.leadingTrivia) {
    hasher.add(trivia.kind);
    hasher.add(trivia.raw);
    hasher.add(trivia.hasLineBreak ? 1 : 0);
  }
  hasher.add(token.trailingTrivia.length);
  for (const trivia of token.trailingTrivia) {
    hasher.add(trivia.kind);
    hasher.add(trivia.raw);
    hasher.add(trivia.hasLineBreak ? 1 : 0);
  }
}

/**
 * What each node that holds others hashed to. Syntax is immutable, so a
 * node's hash never changes, and a node hashed again costs one lookup rather
 * than a walk of everything under it: the operand an expansion in a chain of
 * operators holds is the chain built so far, and each step's input holds it.
 */
const nodeStates = new WeakMap<Syntax, HasherState>();

function addSyntax(hasher: InputHasher, syntax: Syntax): void {
  if (syntax.tag === "token") {
    hasher.add(syntax.tag);
    addToken(hasher, syntax);
    return;
  }
  let state = nodeStates.get(syntax);
  if (state === undefined) {
    const node = new InputHasher();
    node.add(syntax.tag);
    if (syntax.tag === "protected") {
      node.add(syntax.category);
      node.add(syntax.precedence);
    } else if (syntax.tag === "group") {
      node.add(syntax.delimiter);
      addToken(node, syntax.open);
      node.add(syntax.close.tag);
      if (syntax.close.tag === "token") addToken(node, syntax.close);
      else node.add(syntax.close.expectedRaw);
    }
    node.add(syntax.children.length);
    for (const child of syntax.children) addSyntax(node, child);
    state = node.state();
    nodeStates.set(syntax, state);
  }
  hasher.addState(state);
}

/** Hashes expansion input while intentionally excluding allocation identities. */
export function expansionInputStructuralHash(
  syntax: readonly Syntax[],
): ExpansionInputHash {
  const hasher = new InputHasher();
  hasher.add(syntax.length);
  for (const item of syntax) addSyntax(hasher, item);
  return hasher.digest();
}

export interface ExpansionFingerprint {
  readonly binding: BindingId;
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly input: ExpansionInputHash;
  readonly environmentEpoch: EnvironmentEpoch;
}

export function createExpansionFingerprint(options: {
  readonly binding: BindingId;
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly input: readonly Syntax[];
  readonly environmentEpoch: EnvironmentEpoch;
}): ExpansionFingerprint {
  return Object.freeze({
    binding: options.binding,
    category: options.category,
    phase: options.phase,
    input: expansionInputStructuralHash(options.input),
    environmentEpoch: options.environmentEpoch,
  });
}

export function expansionFingerprintKey(
  fingerprint: ExpansionFingerprint,
): string {
  return [
    fingerprint.binding,
    fingerprint.category,
    fingerprint.phase,
    fingerprint.input,
    fingerprint.environmentEpoch,
  ]
    .map((part) => `${String(part).length}:${String(part)}`)
    .join("|");
}

export class ExpansionCycleError extends Error {
  override readonly name = "ExpansionCycleError";

  constructor(
    readonly fingerprint: ExpansionFingerprint,
    readonly firstSeenDepth: number,
  ) {
    super(
      `Expansion repeated an active fingerprint first seen at depth ${String(firstSeenDepth)}`,
    );
  }
}

export interface ExpansionGuardOptions {
  readonly tracker: ResourceTracker;
  readonly cancellation?: CancellationToken | undefined;
}

/** Owns the dynamic invocation stack and balances nesting on every exit path. */
export class ExpansionGuard {
  readonly #active = new Map<string, number>();
  readonly #stack: ExpansionFingerprint[] = [];
  /** The key of each fingerprint in `#stack`, in the same order. */
  readonly #keys: string[] = [];
  readonly #tracker: ResourceTracker;
  readonly #cancellation: CancellationToken;

  constructor(options: ExpansionGuardOptions) {
    this.#tracker = options.tracker;
    this.#cancellation = options.cancellation ?? neverCancelled;
  }

  get depth(): number {
    return this.#stack.length;
  }

  get tracker(): ResourceTracker {
    return this.#tracker;
  }

  get cancellation(): CancellationToken {
    return this.#cancellation;
  }

  get stack(): readonly ExpansionFingerprint[] {
    return Object.freeze([...this.#stack]);
  }

  run<T>(fingerprint: ExpansionFingerprint, operation: () => T): T {
    this.enter(fingerprint);
    try {
      const result = operation();
      this.#cancellation.throwIfCancellationRequested();
      return result;
    } finally {
      this.leave(fingerprint);
    }
  }

  /**
   * Makes `fingerprint` the innermost active expansion, as `run` does around
   * its operation, for an expansion that cannot be one call: one that hands
   * its replacement out to be walked and is resumed with the walk. Every
   * `enter` is matched by a `leave` of the same fingerprint, innermost first.
   */
  enter(fingerprint: ExpansionFingerprint): void {
    this.#cancellation.throwIfCancellationRequested();
    const key = expansionFingerprintKey(fingerprint);
    const firstSeenDepth = this.#active.get(key);
    if (firstSeenDepth !== undefined) {
      throw new ExpansionCycleError(fingerprint, firstSeenDepth);
    }
    this.#tracker.chargeExpansionSteps();
    this.#tracker.enterNesting();
    this.#active.set(key, this.#stack.length);
    this.#stack.push(fingerprint);
    this.#keys.push(key);
  }

  /** Ends the innermost active expansion, which `enter` began. */
  leave(fingerprint: ExpansionFingerprint): void {
    if (this.#stack.at(-1) !== fingerprint)
      throw new RangeError("An expansion left out of order");
    this.#stack.pop();
    this.#active.delete(this.#keys.pop()!);
    this.#tracker.leaveNesting();
  }
}

export interface ExpansionCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly entries: number;
}

/** Publishes a value only after its producer returns a complete result. */
export class CompleteExpansionCache<Value> {
  readonly #values = new Map<string, Value>();
  #hits = 0;
  #misses = 0;

  get stats(): ExpansionCacheStats {
    return Object.freeze({
      hits: this.#hits,
      misses: this.#misses,
      entries: this.#values.size,
    });
  }

  getOrCompute(
    key: string,
    compute: () => Value,
  ): {
    readonly value: Value;
    readonly cache: "hit" | "miss";
  } {
    if (this.#values.has(key)) {
      const cached = this.#values.get(key) as Value;
      this.#hits += 1;
      return Object.freeze({ value: cached, cache: "hit" });
    }
    this.#misses += 1;
    const value = compute();
    this.#values.set(key, value);
    return Object.freeze({ value, cache: "miss" });
  }
}
