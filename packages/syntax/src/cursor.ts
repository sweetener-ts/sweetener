import type { GroupSyntax, Syntax, SyntaxSequence } from "./syntax.js";
import { createSyntaxSequence } from "./syntax.js";

declare const cursorIdentityBrand: unique symbol;
const markOwner: unique symbol = Symbol("cursor-mark-owner");

export type CursorIdentity = string & {
  readonly [cursorIdentityBrand]: "CursorIdentity";
};

export interface CursorMark {
  readonly index: number;
  readonly [markOwner]: object;
}

export interface CursorParentLocation {
  readonly group: GroupSyntax;
  readonly index: number;
  readonly depth: number;
}

export class SyntaxRange {
  constructor(
    readonly sequence: SyntaxSequence,
    readonly start: number,
    readonly end: number,
  ) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > sequence.length
    ) {
      throw new RangeError(
        `Invalid syntax range: [${String(start)}, ${String(end)}) for length ${String(sequence.length)}`,
      );
    }
    Object.freeze(this);
  }

  get length(): number {
    return this.end - this.start;
  }

  at(offset: number): Syntax | undefined {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError(
        "Syntax range offset must be a non-negative integer",
      );
    }
    if (offset >= this.length) return undefined;
    return this.sequence[this.start + offset];
  }

  toArray(): readonly Syntax[] {
    return Object.freeze(this.sequence.slice(this.start, this.end));
  }
}

interface ParentFrame {
  readonly sequence: SyntaxSequence;
  readonly sequenceId: number;
  readonly index: number;
  readonly group: GroupSyntax;
  readonly parent: ParentFrame | undefined;
  readonly depth: number;
}

class CursorContext {
  static #nextTraversalId = 1;

  readonly traversalId = CursorContext.#nextTraversalId++;
  readonly #sequenceIds = new WeakMap<SyntaxSequence, number>();
  #nextSequenceId = 1;

  sequenceId(sequence: SyntaxSequence): number {
    const existing = this.#sequenceIds.get(sequence);
    if (existing !== undefined) return existing;
    const id = this.#nextSequenceId;
    this.#nextSequenceId += 1;
    this.#sequenceIds.set(sequence, id);
    return id;
  }
}

export class SyntaxCursor {
  readonly #context: CursorContext;
  readonly #sequence: SyntaxSequence;
  readonly #sequenceId: number;
  readonly #parent: ParentFrame | undefined;
  readonly #markToken = Object.freeze({});
  #index: number;

  private constructor(
    context: CursorContext,
    sequence: SyntaxSequence,
    index: number,
    parent: ParentFrame | undefined,
  ) {
    this.#context = context;
    this.#sequence = sequence;
    this.#sequenceId = context.sequenceId(sequence);
    this.#index = index;
    this.#parent = parent;
  }

  static create(sequence: readonly Syntax[]): SyntaxCursor {
    return new SyntaxCursor(
      new CursorContext(),
      createSyntaxSequence(sequence),
      0,
      undefined,
    );
  }

  get index(): number {
    return this.#index;
  }

  get length(): number {
    return this.#sequence.length;
  }

  get remainingLength(): number {
    return this.#sequence.length - this.#index;
  }

  get atEnd(): boolean {
    return this.#index === this.#sequence.length;
  }

  get depth(): number {
    return this.#parent === undefined ? 0 : this.#parent.depth;
  }

  get identity(): CursorIdentity {
    return `${String(this.#context.traversalId)}:${String(this.#sequenceId)}:${String(this.#index)}` as CursorIdentity;
  }

  get parentLocation(): CursorParentLocation | undefined {
    if (this.#parent === undefined) return undefined;
    return Object.freeze({
      group: this.#parent.group,
      index: this.#parent.index,
      depth: this.#parent.depth - 1,
    });
  }

  peek(offset = 0): Syntax | undefined {
    this.#validateCount(offset, "Peek offset");
    return this.#sequence[this.#index + offset];
  }

  advance(count = 1): void {
    this.#validateCount(count, "Advance count");
    if (count > this.remainingLength) {
      throw new RangeError(
        `Cannot advance ${String(count)} item(s) with ${String(this.remainingLength)} remaining`,
      );
    }
    this.#index += count;
  }

  consume(): Syntax | undefined {
    const syntax = this.peek();
    if (syntax !== undefined) this.#index += 1;
    return syntax;
  }

  mark(): CursorMark {
    return Object.freeze({
      index: this.#index,
      [markOwner]: this.#markToken,
    });
  }

  reset(mark: CursorMark): void {
    if (mark[markOwner] !== this.#markToken) {
      throw new TypeError("Cursor mark belongs to another cursor instance");
    }
    this.#index = mark.index;
  }

  fork(): SyntaxCursor {
    return new SyntaxCursor(
      this.#context,
      this.#sequence,
      this.#index,
      this.#parent,
    );
  }

  /**
   * A cursor standing where this one does, in the same traversal and group,
   * over `sequence`: this cursor's sequence as far as the cursor, written
   * differently somewhere after it. A parser that finds it has read a token
   * the way the grammar does not reads on over the tokens the grammar reads.
   */
  over(sequence: readonly Syntax[]): SyntaxCursor {
    return new SyntaxCursor(
      this.#context,
      createSyntaxSequence(sequence),
      this.#index,
      this.#parent,
    );
  }

  enterGroup(): SyntaxCursor {
    const syntax = this.peek();
    if (syntax === undefined) {
      throw new RangeError("Cannot enter a group at the end of a cursor");
    }
    if (syntax.tag !== "group") {
      throw new TypeError(`Cannot enter ${syntax.tag} syntax as a group`);
    }
    const depth = this.depth + 1;
    const parent: ParentFrame = Object.freeze({
      sequence: this.#sequence,
      sequenceId: this.#sequenceId,
      index: this.#index,
      group: syntax,
      parent: this.#parent,
      depth,
    });
    return new SyntaxCursor(this.#context, syntax.children, 0, parent);
  }

  exitGroup(): SyntaxCursor | undefined {
    if (this.#parent === undefined) return undefined;
    return new SyntaxCursor(
      this.#context,
      this.#parent.sequence,
      this.#parent.index + 1,
      this.#parent.parent,
    );
  }

  remainingRange(): SyntaxRange {
    return new SyntaxRange(this.#sequence, this.#index, this.#sequence.length);
  }

  #validateCount(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
}

export function createSyntaxCursor(sequence: readonly Syntax[]): SyntaxCursor {
  return SyntaxCursor.create(sequence);
}
