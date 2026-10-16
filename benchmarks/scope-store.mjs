export function defineScopeStoreBenchmarks() {
  return [
    {
      id: "fresh-scopes",
      description: "Allocate fresh lexical scopes",
      operations: 100_000,
      execute(store, operations) {
        for (let index = 0; index < operations; index += 1) {
          store.freshScope("lexical");
        }
      },
    },
    {
      id: "singleton-interning",
      description: "Create each singleton twice and reuse its interned ID",
      operations: 40_000,
      execute(store, operations) {
        const scopes = Array.from({ length: operations / 2 }, () =>
          store.freshScope("introduction"),
        );
        for (const scope of scopes) {
          store.singleton(scope);
          store.singleton(scope);
        }
      },
    },
    {
      id: "persistent-add-chain",
      description: "Build one persistent sorted scope set by repeated add",
      operations: 5_000,
      execute(store, operations) {
        let set = store.empty();
        for (let index = 0; index < operations; index += 1) {
          set = store.add(set, store.freshScope("generated"));
        }
        if (store.size(set) !== operations)
          throw new Error("scope set lost entries");
      },
    },
    {
      id: "union-older-into-newer",
      description:
        "Union a set of older scopes into a set of newer ones, sharing no prefix",
      operations: 2_000,
      execute(store, operations) {
        // Adding each older scope to the newer set one at a time steps over
        // the whole newer set and interns every set on the way: d·(d + 1)
        // sets, 4 million at this size.
        let older = store.empty();
        for (let index = 0; index < operations; index += 1) {
          older = store.add(older, store.freshScope("generated"));
        }
        let newer = store.empty();
        for (let index = 0; index <= operations; index += 1) {
          newer = store.add(newer, store.freshScope("generated"));
        }
        if (store.size(store.union(older, newer)) !== 2 * operations + 1)
          throw new Error("scope set union lost entries");
      },
    },
  ];
}
