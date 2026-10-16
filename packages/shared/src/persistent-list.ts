/**
 * An immutable sequence extended at its end. `append` returns a new list that
 * shares every element of the one it extends, so it costs O(1) however long
 * the list is, and every earlier version stays as it was.
 *
 * The list is stored newest first. Reading it oldest first costs its length,
 * as reading any sequence does; nothing is copied or kept between reads.
 */
export class PersistentList<Value> implements Iterable<Value> {
  static readonly #empty = new PersistentList<never>(undefined, undefined, 0);

  static empty<Value>(): PersistentList<Value> {
    return PersistentList.#empty;
  }

  readonly #last: Value | undefined;
  readonly #previous: PersistentList<Value> | undefined;
  readonly length: number;

  private constructor(
    last: Value | undefined,
    previous: PersistentList<Value> | undefined,
    length: number,
  ) {
    this.#last = last;
    this.#previous = previous;
    this.length = length;
    Object.freeze(this);
  }

  append(value: Value): PersistentList<Value> {
    return new PersistentList(value, this, this.length + 1);
  }

  /** The values oldest first, in a new array. */
  toArray(): Value[] {
    return PersistentList.#valuesOf(this);
  }

  static #valuesOf<Value>(newest: PersistentList<Value>): Value[] {
    const values = new Array<Value>(newest.length);
    let list = newest;
    for (let index = newest.length - 1; index >= 0; index -= 1) {
      values[index] = list.#last as Value;
      list = list.#previous!;
    }
    return values;
  }

  [Symbol.iterator](): Iterator<Value> {
    return this.toArray()[Symbol.iterator]();
  }
}
