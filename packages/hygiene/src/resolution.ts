import type {
  Diagnostic,
  ScopeId,
  ScopeSetId,
  SourceSpan,
} from "@sweetener/shared";
import {
  bindingVisibleAt,
  type Binding,
  type Phase,
  type SyntaxSpace,
} from "./binding.js";
import {
  bindingIndexKey,
  type BindingEnvironment,
  type EnvironmentStore,
} from "./environment.js";
import {
  ambiguousBindingCode,
  hygieneDiagnosticRegistry,
} from "./diagnostics.js";
import type { ScopeStore } from "./scope-store.js";

export interface IdentifierReference {
  readonly spelling: string;
  readonly scopes: ScopeSetId;
  readonly phase: Phase;
  readonly space: SyntaxSpace;
  readonly position: number;
}

export type BindingResolution =
  | { readonly kind: "resolved"; readonly binding: Binding }
  | { readonly kind: "unbound" }
  | { readonly kind: "ambiguous"; readonly candidates: readonly Binding[] };

function compareNumbers(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBindings(
  scopes: ScopeStore,
  left: Binding,
  right: Binding,
): number {
  const leftScopes = scopes.debugRecord(left.scopes).scopes;
  const rightScopes = scopes.debugRecord(right.scopes).scopes;
  const length = Math.min(leftScopes.length, rightScopes.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = compareNumbers(leftScopes[index]!, rightScopes[index]!);
    if (comparison !== 0) return comparison;
  }
  return (
    compareNumbers(leftScopes.length, rightScopes.length) ||
    compareNumbers(left.declaration, right.declaration) ||
    left.kind.localeCompare(right.kind) ||
    compareNumbers(left.id, right.id)
  );
}

export function resolveBinding(
  environments: EnvironmentStore,
  environment: BindingEnvironment,
  scopes: ScopeStore,
  identifier: IdentifierReference,
): BindingResolution {
  return resolveAmong(
    scopes,
    environments
      .candidates(environment, identifier)
      .filter((candidate) =>
        scopes.subset(candidate.scopes, identifier.scopes),
      ),
  );
}

/**
 * The resolution among the bindings whose scopes a reference carries. It does
 * not depend on their order: the answer is the one binding no other one
 * extends, or every such binding in `compareBindings` order.
 */
function resolveAmong(
  scopes: ScopeStore,
  applicable: readonly Binding[],
): BindingResolution {
  const maximal = applicable.filter(
    (candidate) =>
      !applicable.some(
        (other) =>
          candidate !== other &&
          scopes.subset(candidate.scopes, other.scopes) &&
          !scopes.subset(other.scopes, candidate.scopes),
      ),
  );

  if (maximal.length === 0) return Object.freeze({ kind: "unbound" });
  if (maximal.length === 1) {
    return Object.freeze({ kind: "resolved", binding: maximal[0]! });
  }
  return Object.freeze({
    kind: "ambiguous",
    candidates: Object.freeze(
      [...maximal].sort((left, right) => compareBindings(scopes, left, right)),
    ),
  });
}

/**
 * One spelling's bindings, filed in a trie over their sorted scopes: a node
 * holds the bindings whose scopes are exactly the scopes on the path to it.
 */
interface ScopeTrieNode {
  readonly bindings: Binding[];
  readonly children: Map<ScopeId, ScopeTrieNode>;
}

function createTrieNode(): ScopeTrieNode {
  return { bindings: [], children: new Map() };
}

/**
 * Resolves many references against one environment, answering for each
 * exactly what `resolveBinding` does.
 *
 * `resolveBinding` tests every binding of a reference's spelling, so resolving
 * n references to n bindings of one spelling costs n²: a file in which n
 * expansions each introduce a binder `v`. A binding applies to a reference
 * that carries every one of its scopes, so this files each spelling's bindings
 * once in a trie over their sorted scopes and walks, for a reference, only
 * the paths made of scopes the reference carries. Each node it reaches holds
 * bindings that apply or leads to some, and from each it steps only to
 * children the reference's scopes name, so a reference costs what it carries
 * and what applies to it rather than every binding of its spelling.
 */
export class BindingResolver {
  readonly #environments: EnvironmentStore;
  readonly #environment: BindingEnvironment;
  readonly #scopes: ScopeStore;
  readonly #bySpelling = new Map<string, ScopeTrieNode>();

  constructor(
    environments: EnvironmentStore,
    environment: BindingEnvironment,
    scopes: ScopeStore,
  ) {
    this.#environments = environments;
    this.#environment = environment;
    this.#scopes = scopes;
  }

  resolve(identifier: IdentifierReference): BindingResolution {
    const applicable: Binding[] = [];
    this.#visitApplicable(identifier, (binding) => {
      applicable.push(binding);
      return false;
    });
    return resolveAmong(this.#scopes, applicable);
  }

  /**
   * Whether some binding applies to the reference: whether `resolve` would
   * answer other than unbound, since among bindings that apply one always
   * extends no other. It stops at the first, and never compares bindings.
   */
  applies(identifier: IdentifierReference): boolean {
    return this.#visitApplicable(identifier, () => true);
  }

  /**
   * Calls `visit` with each binding that applies to the reference until it
   * answers true, and says whether one did.
   */
  #visitApplicable(
    identifier: IdentifierReference,
    visit: (binding: Binding) => boolean,
  ): boolean {
    const carried = this.#scopes.scopesOf(identifier.scopes);
    // Each entry is a node whose path the reference carries, and the index in
    // `carried` past that path's greatest scope.
    const pending: [ScopeTrieNode, number][] = [[this.#filed(identifier), 0]];
    for (
      let entry = pending.pop();
      entry !== undefined;
      entry = pending.pop()
    ) {
      const [node, next] = entry;
      for (const binding of node.bindings) {
        if (bindingVisibleAt(binding, identifier.position) && visit(binding))
          return true;
      }
      if (node.children.size <= carried.length - next) {
        for (const [scope, child] of node.children) {
          const index = sortedIndexOf(carried, scope, next);
          if (index !== -1) pending.push([child, index + 1]);
        }
      } else {
        for (let index = next; index < carried.length; index += 1) {
          const child = node.children.get(carried[index]!);
          if (child !== undefined) pending.push([child, index + 1]);
        }
      }
    }
    return false;
  }

  #filed(identifier: IdentifierReference): ScopeTrieNode {
    const key = bindingIndexKey(
      identifier.spelling,
      identifier.phase,
      identifier.space,
    );
    const known = this.#bySpelling.get(key);
    if (known !== undefined) return known;
    const root = createTrieNode();
    const nodeBySet = new Map<ScopeSetId, ScopeTrieNode>();
    for (const binding of this.#environments.declared(
      this.#environment,
      identifier,
    )) {
      let filed = nodeBySet.get(binding.scopes);
      if (filed === undefined) {
        let node = root;
        for (const scope of this.#scopes.scopesOf(binding.scopes)) {
          let child = node.children.get(scope);
          if (child === undefined) {
            child = createTrieNode();
            node.children.set(scope, child);
          }
          node = child;
        }
        nodeBySet.set(binding.scopes, node);
        filed = node;
      }
      filed.bindings.push(binding);
    }
    this.#bySpelling.set(key, root);
    return root;
  }
}

/** Where `value` stands in the sorted `values` at or after `from`, or -1. */
function sortedIndexOf(
  values: readonly ScopeId[],
  value: ScopeId,
  from: number,
): number {
  let low = from;
  let high = values.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = values[middle]!;
    if (candidate === value) return middle;
    if (candidate < value) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

export interface AmbiguityDiagnosticOrigins {
  readonly reference: SourceSpan;
  readonly declaration: (binding: Binding) => SourceSpan;
}

export function ambiguityDiagnostic(
  identifier: IdentifierReference,
  resolution: BindingResolution,
  origins: AmbiguityDiagnosticOrigins,
): Diagnostic | undefined {
  if (resolution.kind !== "ambiguous") return undefined;
  return hygieneDiagnosticRegistry.create(ambiguousBindingCode, {
    primaryOrigin: origins.reference,
    messageArguments: [identifier.spelling, resolution.candidates.length],
    relatedOrigins: resolution.candidates.map((binding) => ({
      message: `Candidate ${binding.kind} binding`,
      origin: origins.declaration(binding),
    })),
  });
}
