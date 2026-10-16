import { describe, expect, it } from "vitest";
import { PersistentStringMap } from "../src/persistent-map.js";

describe("persistent string maps", () => {
  it("leaves every earlier version as it was", () => {
    const empty = PersistentStringMap.empty<number>();
    const one = empty.set("a", 1);
    const two = one.set("b", 2);
    const replaced = two.set("a", 3);
    expect(empty.get("a")).toBeUndefined();
    expect(one.get("a")).toBe(1);
    expect(one.get("b")).toBeUndefined();
    expect(two.get("a")).toBe(1);
    expect(two.get("b")).toBe(2);
    expect(replaced.get("a")).toBe(3);
    expect(replaced.get("b")).toBe(2);
    expect(Object.isFrozen(replaced)).toBe(true);
  });

  it("keeps keys whose hashes are equal apart", () => {
    // "k32728" and "k261234" have the same 32-bit FNV-1a hash.
    const both = PersistentStringMap.empty<string>()
      .set("k32728", "first")
      .set("k261234", "second");
    expect(both.get("k32728")).toBe("first");
    expect(both.get("k261234")).toBe("second");
    const replaced = both.set("k261234", "third");
    expect(replaced.get("k261234")).toBe("third");
    expect(both.get("k261234")).toBe("second");
    const widened = replaced.set("k0", "other");
    expect(widened.get("k32728")).toBe("first");
    expect(widened.get("k261234")).toBe("third");
    expect(widened.get("k0")).toBe("other");
    expect(widened.get("k32729")).toBeUndefined();
  });

  it("matches a Map over fixed-seed generated versions", () => {
    let seed = 0x2f6b_1a3;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const keys = [
      ...Array.from({ length: 3_000 }, (_, index) => `k${String(index)}`),
      "k32728",
      "k261234",
      "k32729",
      "k261235",
    ];
    const versions = [PersistentStringMap.empty<number>()];
    const models = [new Map<string, number>()];
    for (let iteration = 0; iteration < 6_000; iteration += 1) {
      const base = random() % versions.length;
      const key = keys[random() % keys.length]!;
      const model = new Map(models[base]!);
      model.set(key, iteration);
      versions.push(versions[base]!.set(key, iteration));
      models.push(model);
    }
    for (let index = 0; index < versions.length; index += 97) {
      for (const key of keys) {
        expect(versions[index]!.get(key)).toBe(models[index]!.get(key));
      }
    }
  });
});
