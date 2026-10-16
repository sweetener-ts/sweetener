import {
  createIdAllocator,
  PersistentList,
  PersistentStringMap,
  type BindingId,
  type DeclarationGroupId,
  type EnvironmentEpoch,
  type EnvironmentId,
  type OriginId,
  type ScopeSetId,
} from "@sweetener/shared";
import {
  bindingVisibleAt,
  createBinding,
  type Binding,
  type BindingKind,
  type BindingVisibility,
  type Phase,
  type SyntaxSpace,
} from "./binding.js";

/**
 * The key an environment files a spelling's bindings under in one phase and
 * syntax space. Anything that indexes bindings the way an environment does
 * uses this key, so the two cannot disagree about which bindings share one.
 */
export function bindingIndexKey(
  spelling: string,
  phase: Phase,
  space: SyntaxSpace,
): string {
  return `${String(spelling.length)}:${spelling}|${String(phase)}|${space}`;
}

export interface BindingEnvironment {
  readonly id: EnvironmentId;
  readonly epoch: EnvironmentEpoch;
  readonly parent: BindingEnvironment | undefined;
  readonly depth: number;
  /**
   * The bindings this frame holds for the spelling in the phase and space, in
   * declaration order. Each declaration extends the list without copying it,
   * and a lookup answers with the list itself, so declarations and lookups
   * interleaved cost the same as declarations alone.
   */
  localCandidates(
    spelling: string,
    phase: Phase,
    space: SyntaxSpace,
  ): PersistentList<Binding>;
}

const withBinding: unique symbol = Symbol("with-binding");

class PersistentBindingEnvironment implements BindingEnvironment {
  readonly #locals: PersistentStringMap<PersistentList<Binding>>;

  constructor(
    readonly owner: object,
    readonly id: EnvironmentId,
    readonly epoch: EnvironmentEpoch,
    readonly parent: BindingEnvironment | undefined,
    readonly depth: number,
    locals: PersistentStringMap<
      PersistentList<Binding>
    > = PersistentStringMap.empty(),
  ) {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError(
        "Environment depth must be a non-negative safe integer",
      );
    }
    this.#locals = locals;
    Object.freeze(this);
  }

  localCandidates(
    spelling: string,
    phase: Phase,
    space: SyntaxSpace,
  ): PersistentList<Binding> {
    return (
      this.#locals.get(bindingIndexKey(spelling, phase, space)) ??
      PersistentList.empty()
    );
  }

  [withBinding](
    id: EnvironmentId,
    epoch: EnvironmentEpoch,
    binding: Binding,
  ): PersistentBindingEnvironment {
    const key = bindingIndexKey(binding.spelling, binding.phase, binding.space);
    const local = this.#locals.get(key) ?? PersistentList.empty();
    return new PersistentBindingEnvironment(
      this.owner,
      id,
      epoch,
      this.parent,
      this.depth,
      this.#locals.set(key, local.append(binding)),
    );
  }
}

export interface DeclaredQuery {
  readonly spelling: string;
  readonly phase: Phase;
  readonly space: SyntaxSpace;
}

export interface CandidateQuery extends DeclaredQuery {
  readonly position: number;
}

export interface DeclareBindingOptions {
  readonly spelling: string;
  readonly scopes: ScopeSetId;
  readonly phase: Phase;
  readonly space: SyntaxSpace;
  readonly declaration: OriginId;
  readonly kind: BindingKind;
  readonly declarationGroup?: DeclarationGroupId | undefined;
  readonly visibility?: BindingVisibility | undefined;
}

export interface DeclarationResult {
  readonly environment: BindingEnvironment;
  readonly binding: Binding;
}

export class EnvironmentStore {
  readonly #owner = Object.freeze({});
  readonly #bindingIds = createIdAllocator<BindingId>(1);
  readonly #groupIds = createIdAllocator<DeclarationGroupId>(1);
  readonly #environmentIds = createIdAllocator<EnvironmentId>(1);
  readonly #epochs = createIdAllocator<EnvironmentEpoch>(0);

  createRoot(): BindingEnvironment {
    return new PersistentBindingEnvironment(
      this.#owner,
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      undefined,
      0,
    );
  }

  child(parent: BindingEnvironment): BindingEnvironment {
    this.#requireEnvironment(parent);
    return new PersistentBindingEnvironment(
      this.#owner,
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      parent,
      parent.depth + 1,
    );
  }

  freshDeclarationGroup(): DeclarationGroupId {
    return this.#groupIds.allocate();
  }

  declare(
    environment: BindingEnvironment,
    options: DeclareBindingOptions,
  ): DeclarationResult {
    const binding = createBinding({
      id: this.#bindingIds.allocate(),
      ...options,
    });
    const persistent = this.#requireEnvironment(environment);
    const updated = persistent[withBinding](
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      binding,
    );
    return Object.freeze({ environment: updated, binding });
  }

  candidates(
    environment: BindingEnvironment,
    query: CandidateQuery,
  ): readonly Binding[] {
    return Object.freeze(
      this.declared(environment, query).filter((binding) =>
        bindingVisibleAt(binding, query.position),
      ),
    );
  }

  /**
   * Every binding of the query's spelling, phase and space in the environment
   * and the frames around it, wherever it is visible: the innermost frame's
   * first, and each frame's in declaration order.
   */
  declared(
    environment: BindingEnvironment,
    query: DeclaredQuery,
  ): readonly Binding[] {
    this.#requireEnvironment(environment);
    const declared: Binding[] = [];
    let current: BindingEnvironment | undefined = environment;
    while (current !== undefined) {
      for (const binding of current.localCandidates(
        query.spelling,
        query.phase,
        query.space,
      ))
        declared.push(binding);
      current = current.parent;
    }
    return Object.freeze(declared);
  }

  #requireEnvironment(
    environment: BindingEnvironment,
  ): PersistentBindingEnvironment {
    if (
      !(environment instanceof PersistentBindingEnvironment) ||
      environment.owner !== this.#owner
    ) {
      throw new TypeError(
        "Binding environment belongs to another implementation",
      );
    }
    return environment;
  }
}
