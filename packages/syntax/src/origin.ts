import {
  createIdAllocator,
  type CaptureId,
  type OriginId,
  type SourceId,
} from "@sweetener/shared";
import type { Span } from "./span.js";
import { createSpan } from "./span.js";

export type SynthesisReason =
  | "missing-token"
  | "recovery"
  | "grouping-parentheses"
  | "generated-binding"
  | "printer-separator"
  | "source-map-anchor";

export interface SourceOrigin {
  readonly id: OriginId;
  readonly kind: "source";
  readonly sourceId: SourceId;
  readonly span: Span;
}

export interface CopiedOrigin {
  readonly id: OriginId;
  readonly kind: "copied";
  readonly capture: CaptureId;
  readonly parent: OriginId;
}

export interface IntroducedOrigin {
  readonly id: OriginId;
  readonly kind: "introduced";
  readonly definition: OriginId;
  readonly invocation: OriginId;
}

export interface SynthesizedOrigin {
  readonly id: OriginId;
  readonly kind: "synthesized";
  readonly invocation: OriginId;
  readonly reason: SynthesisReason;
}

export interface ComposedOrigin {
  readonly id: OriginId;
  readonly kind: "composed";
  readonly parts: readonly OriginId[];
}

export type Origin =
  | SourceOrigin
  | CopiedOrigin
  | IntroducedOrigin
  | SynthesizedOrigin
  | ComposedOrigin;

export type PrimaryOriginPolicy = "invocation" | "definition" | "leftmost";

export interface OriginStoreOptions {
  readonly startId?: number;
}

export class OriginGraphError extends Error {
  override readonly name = "OriginGraphError";
}

/**
 * One number standing for a span, or nothing when it will not fit.
 *
 * Offsets and lengths below 2^26 — a 67 MB file, with a 67 MB token in it —
 * pack into a safe integer. Anything larger falls back to a string key, so the
 * guarantee that one span in one file is one origin does not depend on the
 * size of the file.
 */
const spanKeyLimit = 0x4000000;

function spanKey(start: number, end: number): number | undefined {
  const length = end - start;
  if (start >= spanKeyLimit || length >= spanKeyLimit) return undefined;
  return start * spanKeyLimit + length;
}

export class OriginStore {
  readonly #ids;
  /**
   * Origins by id, in an array rather than a map.
   *
   * Ids come from an allocator that counts up from a known start, so the id is
   * an index. A map cost a hash and a bucket write for every token in the file
   * to store a dense integer key.
   */
  readonly #origins: (Origin | undefined)[] = [];
  readonly #firstId: number;
  #count = 0;
  readonly #interned = new Map<string, OriginId>();
  readonly #sourceIndex = new Map<SourceId, Map<number, OriginId>>();
  #lastSourceId: SourceId | undefined;
  #lastSpans: Map<number, OriginId> | undefined;

  constructor(options: OriginStoreOptions = {}) {
    this.#ids = createIdAllocator<OriginId>(options.startId);
    this.#firstId = options.startId ?? 1;
  }

  #store(id: OriginId, origin: Origin): void {
    this.#origins[id - this.#firstId] = origin;
    this.#count += 1;
  }

  #read(id: OriginId): Origin | undefined {
    const index = id - this.#firstId;
    return index >= 0 && index < this.#origins.length
      ? this.#origins[index]
      : undefined;
  }

  get size(): number {
    return this.#count;
  }

  has(id: OriginId): boolean {
    return this.#read(id) !== undefined;
  }

  get(id: OriginId): Origin | undefined {
    return this.#read(id);
  }

  source(sourceId: SourceId, span: Span): OriginId {
    // Source origins outnumber every other kind — one per token — and hardly
    // ever repeat, since each token occupies its own span. Keying them by a
    // built-up string meant allocating and hashing a key per token only to
    // miss on it. Nesting maps on the numbers keeps the same guarantee, that
    // one span in one file is one origin, without the key.
    // Tokens arrive in file order, so the same source is asked for thousands
    // of times in a row before another one is.
    let spans =
      sourceId === this.#lastSourceId
        ? this.#lastSpans
        : this.#sourceIndex.get(sourceId);
    if (spans === undefined) {
      spans = new Map();
      this.#sourceIndex.set(sourceId, spans);
    }
    this.#lastSourceId = sourceId;
    this.#lastSpans = spans;
    // One number for the pair rather than a map per start offset. Since a
    // token's span hardly ever repeats, the inner map held a single entry and
    // allocating it cost a Map for every token in the file.
    const key = spanKey(span.start, span.end);
    if (key !== undefined) {
      const existing = spans.get(key);
      if (existing !== undefined) return existing;
    }
    const fallbackKey =
      key === undefined
        ? `${String(sourceId)}:${String(span.start)}:${String(span.end)}`
        : undefined;
    if (fallbackKey !== undefined) {
      const existing = this.#interned.get(fallbackKey);
      if (existing !== undefined) return existing;
    }
    const id = this.#ids.allocate();
    this.#store(
      id,
      Object.freeze({
        id,
        kind: "source",
        sourceId,
        // A caller that already holds an immutable span holds exactly what
        // this would build. Rebuilding it allocated and revalidated a second
        // span for every token in the file.
        span: Object.isFrozen(span) ? span : createSpan(span.start, span.end),
      }),
    );
    if (key !== undefined) spans.set(key, id);
    else this.#interned.set(fallbackKey!, id);
    return id;
  }

  copied(capture: CaptureId, parent: OriginId): OriginId {
    this.#require(parent);
    return this.#intern(`copied|${capture}|${parent}`, (id) =>
      Object.freeze({ id, kind: "copied", capture, parent }),
    );
  }

  introduced(definition: OriginId, invocation: OriginId): OriginId {
    this.#require(definition);
    this.#require(invocation);
    return this.#intern(`introduced|${definition}|${invocation}`, (id) =>
      Object.freeze({
        id,
        kind: "introduced",
        definition,
        invocation,
      }),
    );
  }

  synthesized(invocation: OriginId, reason: SynthesisReason): OriginId {
    this.#require(invocation);
    return this.#intern(`synthesized|${invocation}|${reason}`, (id) =>
      Object.freeze({ id, kind: "synthesized", invocation, reason }),
    );
  }

  composed(parts: readonly OriginId[]): OriginId {
    if (parts.length === 0) {
      throw new OriginGraphError("Composed origin requires at least one part");
    }
    for (const part of parts) this.#require(part);
    const frozenParts = Object.freeze([...parts]);
    return this.#intern(`composed|${parts.join(",")}`, (id) =>
      Object.freeze({ id, kind: "composed", parts: frozenParts }),
    );
  }

  collectSourceOrigins(id: OriginId): readonly SourceOrigin[] {
    this.#require(id);
    const output: SourceOrigin[] = [];
    const seenOrigins = new Set<OriginId>();
    const seenSources = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const currentId = stack.pop();
      if (currentId === undefined || seenOrigins.has(currentId)) continue;
      seenOrigins.add(currentId);
      const current = this.#require(currentId);
      if (current.kind === "source") {
        const key = `${current.sourceId}|${current.span.start}|${current.span.end}`;
        if (!seenSources.has(key)) {
          seenSources.add(key);
          output.push(current);
        }
        continue;
      }
      const parents = this.#parents(current, "leftmost");
      for (let index = parents.length - 1; index >= 0; index -= 1) {
        const parent = parents[index];
        if (parent !== undefined) stack.push(parent);
      }
    }
    return Object.freeze(output);
  }

  selectPrimarySource(
    id: OriginId,
    policy: PrimaryOriginPolicy = "invocation",
  ): SourceOrigin {
    this.#require(id);
    const seen = new Set<OriginId>();
    const stack = [id];
    while (stack.length > 0) {
      const currentId = stack.pop();
      if (currentId === undefined || seen.has(currentId)) continue;
      seen.add(currentId);
      const current = this.#require(currentId);
      if (current.kind === "source") return current;
      const parents = this.#parents(current, policy);
      for (let index = parents.length - 1; index >= 0; index -= 1) {
        const parent = parents[index];
        if (parent !== undefined) stack.push(parent);
      }
    }
    throw new OriginGraphError(`Origin ${String(id)} has no source ancestor`);
  }

  #parents(origin: Exclude<Origin, SourceOrigin>, policy: PrimaryOriginPolicy) {
    switch (origin.kind) {
      case "copied":
        return [origin.parent];
      case "synthesized":
        return [origin.invocation];
      case "introduced":
        return policy === "invocation"
          ? [origin.invocation, origin.definition]
          : [origin.definition, origin.invocation];
      case "composed":
        return origin.parts;
    }
  }

  #require(id: OriginId): Origin {
    const origin = this.#read(id);
    if (origin === undefined) {
      throw new OriginGraphError(
        `Origin ${String(id)} is not owned by this store; unknown and forward references are forbidden`,
      );
    }
    return origin;
  }

  #intern(key: string, create: (id: OriginId) => Origin): OriginId {
    const existing = this.#interned.get(key);
    if (existing !== undefined) return existing;
    const id = this.#ids.allocate();
    const origin = create(id);
    this.#store(id, origin);
    this.#interned.set(key, id);
    return id;
  }
}
