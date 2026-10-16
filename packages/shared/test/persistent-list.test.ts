import { describe, expect, it } from "vitest";
import { PersistentList } from "../src/persistent-list.js";

describe("persistent lists", () => {
  it("leaves every earlier version as it was", () => {
    const empty = PersistentList.empty<string>();
    const one = empty.append("a");
    const two = one.append("b");
    const branch = one.append("c");
    expect(empty.length).toBe(0);
    expect([...empty]).toEqual([]);
    expect([...one]).toEqual(["a"]);
    expect([...two]).toEqual(["a", "b"]);
    expect([...branch]).toEqual(["a", "c"]);
    expect(two.length).toBe(2);
    expect(Object.isFrozen(two)).toBe(true);
  });

  it("reads a long list oldest first, into a new array each time", () => {
    let list = PersistentList.empty<number>();
    for (let index = 0; index < 50_000; index += 1) list = list.append(index);
    const values = list.toArray();
    expect(values).toEqual(Array.from({ length: 50_000 }, (_, index) => index));
    expect(list.toArray()).not.toBe(values);
  });
});
