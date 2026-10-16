import type { ScopeId, ScopeSetId } from "@sweetener/shared";
import { describe, expect, it } from "vitest";
import { createScope, type ScopeMark, ScopeStore } from "../src/index.js";

describe("scope store", () => {
  it("allocates fresh scopes with immutable debug metadata", () => {
    const store = new ScopeStore();
    const lexical = store.freshScope("lexical", "function body");
    const introduction = store.freshScope("introduction", "unless invocation");
    expect(lexical).not.toBe(introduction);
    expect(store.stats).toEqual({
      allocatedScopes: 2,
      internedSets: 1,
      internHits: 0,
    });
    const serialized = JSON.parse(
      store.serialize(store.add(store.empty(), lexical)),
    );
    expect(serialized).toEqual({
      id: 1,
      scopes: [{ id: lexical, kind: "lexical", label: "function body" }],
    });
    expect(() =>
      createScope(100 as ScopeId, "generated", "two\nlines"),
    ).toThrow(/one line/);
  });

  it("interns canonical sorted sets and preserves idempotent operations", () => {
    const store = new ScopeStore();
    const first = store.freshScope();
    const second = store.freshScope();
    const empty = store.empty();
    const one = store.add(empty, first);
    const two = store.add(store.add(empty, second), first);
    expect(store.add(one, first)).toBe(one);
    expect(store.remove(one, second)).toBe(one);
    expect(store.union(one, empty)).toBe(one);
    expect(store.union(one, store.singleton(second))).toBe(two);
    expect(store.debugRecord(two).scopes).toEqual([first, second]);
    expect(store.size(two)).toBe(2);
    expect(store.has(two, first)).toBe(true);
    expect(store.has(two, second)).toBe(true);
    expect(store.remove(two, first)).toBe(store.singleton(second));
    expect(store.flip(one, first)).toBe(empty);
    expect(store.flip(empty, first)).toBe(one);
    expect(Object.isFrozen(store.debugRecord(two))).toBe(true);
    expect(Object.isFrozen(store.debugRecord(two).scopes)).toBe(true);
  });

  it("implements subset including equality and the empty set", () => {
    const store = new ScopeStore();
    const first = store.freshScope();
    const second = store.freshScope();
    const empty = store.empty();
    const one = store.singleton(first);
    const two = store.add(one, second);
    expect(store.subset(empty, two)).toBe(true);
    expect(store.subset(one, two)).toBe(true);
    expect(store.subset(two, two)).toBe(true);
    expect(store.subset(two, one)).toBe(false);
    expect(store.subset(one, empty)).toBe(false);
  });

  it("satisfies union identity, idempotence, commutativity, and associativity", () => {
    const store = new ScopeStore();
    const [first, second, third] = Array.from({ length: 3 }, () =>
      store.freshScope(),
    );
    const a = store.singleton(first!);
    const b = store.singleton(second!);
    const c = store.singleton(third!);
    expect(store.union(a, store.empty())).toBe(a);
    expect(store.union(a, a)).toBe(a);
    expect(store.union(a, b)).toBe(store.union(b, a));
    expect(store.union(store.union(a, b), c)).toBe(
      store.union(a, store.union(b, c)),
    );
  });

  it("rejects unknown scope and set IDs", () => {
    const store = new ScopeStore();
    const scope = store.freshScope();
    expect(() => store.add(999 as ScopeSetId, scope)).toThrow(
      /Unknown scope set/,
    );
    expect(() => store.add(store.empty(), 999 as ScopeId)).toThrow(
      /Unknown scope/,
    );
    expect(() => store.size(999 as ScopeSetId)).toThrow(/Unknown scope set/);
  });

  it("matches JavaScript Set algebra over fixed-seed generated operations", () => {
    let seed = 0x51c0_5e7;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const store = new ScopeStore();
    const scopes = Array.from({ length: 24 }, () => store.freshScope());
    const models: Set<ScopeId>[] = [new Set()];
    const ids: ScopeSetId[] = [store.empty()];
    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const baseIndex = random() % ids.length;
      const baseId = ids[baseIndex]!;
      const baseModel = models[baseIndex]!;
      const scope = scopes[random() % scopes.length]!;
      const add = (random() & 1) === 0;
      const model = new Set(baseModel);
      if (add) model.add(scope);
      else model.delete(scope);
      const id = add ? store.add(baseId, scope) : store.remove(baseId, scope);
      expect(store.debugRecord(id).scopes).toEqual(
        [...model].sort((left, right) => left - right),
      );
      const comparisonIndex = random() % ids.length;
      const comparison = models[comparisonIndex]!;
      expect(store.subset(id, ids[comparisonIndex]!)).toBe(
        [...model].every((candidate) => comparison.has(candidate)),
      );
      ids.push(id);
      models.push(model);
    }
  });

  it("matches a model of every query and gives one set one ID however it was built", () => {
    let seed = 0x7a3e_c41;
    const random = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const store = new ScopeStore();
    // Four batches, each a lexical scope, one invocation's paired
    // introduction and use-site scopes, and an introduction scope left
    // unpaired, with a mark taken before each batch.
    const scopes: ScopeId[] = [];
    const marks: ScopeMark[] = [];
    const partners = new Map<ScopeId, ScopeId>();
    for (let batch = 0; batch < 4; batch += 1) {
      marks.push(store.mark());
      scopes.push(store.freshScope("lexical"));
      const introduction = store.freshScope("introduction");
      const useSite = store.freshScope("use-site");
      store.pairInvocationScopes(introduction, useSite);
      partners.set(introduction, useSite);
      scopes.push(introduction, useSite, store.freshScope("introduction"));
    }
    marks.push(store.mark());
    const unmatched = (model: ReadonlySet<ScopeId>, since: number): boolean =>
      [...model].some((scope) => {
        const partner = partners.get(scope);
        return scope >= since && partner !== undefined && !model.has(partner);
      });
    const models: Set<ScopeId>[] = [new Set()];
    const ids: ScopeSetId[] = [store.empty()];
    const idByContent = new Map<string, ScopeSetId>([["", store.empty()]]);
    const sorted = (model: ReadonlySet<ScopeId>): ScopeId[] =>
      [...model].sort((left, right) => left - right);
    const expectOneId = (model: ReadonlySet<ScopeId>, id: ScopeSetId): void => {
      const content = sorted(model).join(",");
      expect(idByContent.get(content) ?? id).toBe(id);
      idByContent.set(content, id);
    };
    for (let iteration = 0; iteration < 3_000; iteration += 1) {
      const baseIndex = random() % ids.length;
      const otherIndex = random() % ids.length;
      const scope = scopes[random() % scopes.length]!;
      const model = new Set(models[baseIndex]);
      let id: ScopeSetId;
      switch (random() % 5) {
        case 0:
          model.add(scope);
          id = store.add(ids[baseIndex]!, scope);
          break;
        case 1:
          model.delete(scope);
          id = store.remove(ids[baseIndex]!, scope);
          break;
        case 2:
          if (model.has(scope)) model.delete(scope);
          else model.add(scope);
          id = store.flip(ids[baseIndex]!, scope);
          break;
        case 3:
          for (const [introduction, useSite] of partners) {
            if (model.has(introduction) && model.has(useSite)) {
              model.delete(introduction);
              model.delete(useSite);
            }
          }
          id = store.publishedTo(ids[baseIndex]!);
          break;
        default:
          for (const other of models[otherIndex]!) model.add(other);
          id = store.union(ids[baseIndex]!, ids[otherIndex]!);
      }
      expect(store.debugRecord(id).scopes).toEqual(sorted(model));
      expect(store.size(id)).toBe(model.size);
      expect(scopes.map((candidate) => store.has(id, candidate))).toEqual(
        scopes.map((candidate) => model.has(candidate)),
      );
      const comparison = models[otherIndex]!;
      expect(store.subset(id, ids[otherIndex]!)).toBe(
        [...model].every((candidate) => comparison.has(candidate)),
      );
      expect(store.subset(ids[otherIndex]!, id)).toBe(
        [...comparison].every((candidate) => model.has(candidate)),
      );
      expect(store.hasUnmatchedIntroduction(id)).toBe(unmatched(model, 0));
      expect(marks.map((mark) => store.introducedSince(id, mark))).toEqual(
        marks.map((mark) => unmatched(model, mark)),
      );
      const published = new Set(model);
      for (const [introduction, useSite] of partners) {
        if (model.has(introduction) && model.has(useSite)) {
          published.delete(introduction);
          published.delete(useSite);
        }
      }
      const publishedId = store.publishedTo(id);
      expect(store.debugRecord(publishedId).scopes).toEqual(sorted(published));
      expectOneId(model, id);
      expectOneId(published, publishedId);
      ids.push(id);
      models.push(model);
    }
  });

  it("interns only the sets the answer's own scopes start with", () => {
    const store = new ScopeStore();
    const size = 1_000;
    const build = (scopes: readonly ScopeId[]): ScopeSetId =>
      scopes.reduce((set, scope) => store.add(set, scope), store.empty());
    // Every scope of the smaller set is older than every scope of the
    // larger one, so the union shares no prefix with the larger set.
    const older = build(Array.from({ length: size }, () => store.freshScope()));
    const younger = build(
      Array.from({ length: size + 1 }, () => store.freshScope()),
    );
    let before = store.stats.internedSets;
    expect(store.size(store.union(older, younger))).toBe(2 * size + 1);
    expect(store.stats.internedSets - before).toBe(size + 1);

    // A set carrying many invocations' introduction and use-site scopes,
    // followed by scopes of its own, publishes to only the latter.
    let carried = store.empty();
    for (let index = 0; index < size; index += 1) {
      const introduction = store.freshScope("introduction");
      const useSite = store.freshScope("use-site");
      store.pairInvocationScopes(introduction, useSite);
      carried = store.add(store.add(carried, introduction), useSite);
    }
    for (let index = 0; index < size; index += 1) {
      carried = store.add(carried, store.freshScope());
    }
    before = store.stats.internedSets;
    expect(store.size(store.publishedTo(carried))).toBe(size);
    expect(store.stats.internedSets - before).toBe(size);
  });

  it("allocates large batches without exposing mutable set storage", () => {
    const store = new ScopeStore();
    let set = store.empty();
    for (let index = 0; index < 2_000; index += 1) {
      set = store.add(set, store.freshScope("generated"));
    }
    expect(store.size(set)).toBe(2_000);
    expect(store.stats.allocatedScopes).toBe(2_000);
    expect(store.serialize(set)).toContain('"kind":"generated"');
  });
});
