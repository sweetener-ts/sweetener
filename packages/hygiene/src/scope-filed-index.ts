import type { ScopeId, ScopeSetId } from "@sweetener/shared";
import type { ScopeStore } from "./scope-store.js";

/**
 * Entries filed under the largest scope of each one's scope set, asked about
 * a scope set: an entry that applies only to names carrying all of its
 * scopes applies to none that lacks its largest, so a name is held only
 * against the entries filed under a scope it carries, and those with none.
 *
 * Asked of every entry, the binders of one spelling a file of invocations
 * declares -- each template's `const v`, or `tmp` -- were held against every
 * other, which cost the square of how many invocations the file holds.
 */
export class ScopeFiledIndex<Entry> {
  readonly #unscoped: Entry[] = [];
  readonly #byScope = new Map<ScopeId, Entry[]>();

  constructor(
    readonly store: ScopeStore,
    readonly scopesOf: (entry: Entry) => ScopeSetId,
  ) {}

  add(entry: Entry): void {
    const largest = this.store.scopesOf(this.scopesOf(entry)).at(-1);
    if (largest === undefined) {
      this.#unscoped.push(entry);
      return;
    }
    const filed = this.#byScope.get(largest);
    if (filed === undefined) this.#byScope.set(largest, [entry]);
    else filed.push(entry);
  }

  /**
   * Whether `test` holds of an entry a name carrying `set` may be reached by:
   * one filed under a scope `set` holds, or under none. The entries are read
   * from whichever is shorter, the scopes of `set` or the scopes filed under.
   */
  some(set: ScopeSetId, test: (entry: Entry) => boolean): boolean {
    if (this.#unscoped.some(test)) return true;
    const scopes = this.store.scopesOf(set);
    if (scopes.length <= this.#byScope.size)
      return scopes.some(
        (scope) => this.#byScope.get(scope)?.some(test) === true,
      );
    for (const [scope, filed] of this.#byScope)
      if (this.store.has(set, scope) && filed.some(test)) return true;
    return false;
  }

  /** The entries `some` would ask of, for which `test` holds. */
  filter(set: ScopeSetId, test: (entry: Entry) => boolean): Entry[] {
    const kept = this.#unscoped.filter(test);
    for (const scope of this.store.scopesOf(set))
      for (const entry of this.#byScope.get(scope) ?? [])
        if (test(entry)) kept.push(entry);
    return kept;
  }
}
