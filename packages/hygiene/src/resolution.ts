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
import type { BindingEnvironment, EnvironmentStore } from "./environment.js";
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

/** One spelling's bindings, filed under the largest scope each carries. */
interface BindingsByLargestScope {
  readonly unscoped: readonly Binding[];
  readonly byScope: ReadonlyMap<ScopeId, readonly Binding[]>;
}

/**
 * Resolves many references against one environment, answering for each
 * exactly what `resolveBinding` does.
 *
 * `resolveBinding` tests every binding of a reference's spelling, so resolving
 * n references to n bindings of one spelling costs n²: a file in which n
 * expansions each introduce a binder `v`. A binding applies only to a
 * reference that carries every one of its scopes, its largest among them, so
 * this files each spelling's bindings under their largest scope once and
 * tests only those filed under the reference's own scopes.
 */
export class BindingResolver {
  readonly #environments: EnvironmentStore;
  readonly #environment: BindingEnvironment;
  readonly #scopes: ScopeStore;
  readonly #bySpelling = new Map<string, BindingsByLargestScope>();

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
    const filed = this.#filed(identifier);
    const applicable: Binding[] = [];
    const consider = (bindings: readonly Binding[] | undefined): void => {
      for (const binding of bindings ?? []) {
        if (
          bindingVisibleAt(binding, identifier.position) &&
          this.#scopes.subset(binding.scopes, identifier.scopes)
        )
          applicable.push(binding);
      }
    };
    consider(filed.unscoped);
    for (const scope of this.#scopes.scopesOf(identifier.scopes))
      consider(filed.byScope.get(scope));
    return resolveAmong(this.#scopes, applicable);
  }

  #filed(identifier: IdentifierReference): BindingsByLargestScope {
    const key = `${String(identifier.spelling.length)}:${identifier.spelling}|${String(identifier.phase)}|${identifier.space}`;
    const known = this.#bySpelling.get(key);
    if (known !== undefined) return known;
    const unscoped: Binding[] = [];
    const byScope = new Map<ScopeId, Binding[]>();
    for (const binding of this.#environments.declared(
      this.#environment,
      identifier,
    )) {
      const largest = this.#scopes.scopesOf(binding.scopes).at(-1);
      if (largest === undefined) unscoped.push(binding);
      else {
        const filed = byScope.get(largest);
        if (filed === undefined) byScope.set(largest, [binding]);
        else filed.push(binding);
      }
    }
    const filed = { unscoped, byScope };
    this.#bySpelling.set(key, filed);
    return filed;
  }
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
