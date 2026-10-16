import {
  createIdAllocator,
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

function indexKey(spelling: string, phase: Phase, space: SyntaxSpace): string {
  return `${String(spelling.length)}:${spelling}|${String(phase)}|${space}`;
}

export interface BindingEnvironment {
  readonly id: EnvironmentId;
  readonly epoch: EnvironmentEpoch;
  readonly parent: BindingEnvironment | undefined;
  readonly depth: number;
  localCandidates(
    spelling: string,
    phase: Phase,
    space: SyntaxSpace,
  ): readonly Binding[];
}

const withBinding: unique symbol = Symbol("with-binding");

/**
 * The bindings one frame holds for one key, newest first. Extending it shares
 * every older entry; the array `localCandidates` answers with is built once.
 */
class BindingList {
  #declarationOrder: readonly Binding[] | undefined;

  constructor(
    readonly binding: Binding,
    readonly previous: BindingList | undefined,
  ) {}

  get declarationOrder(): readonly Binding[] {
    if (this.#declarationOrder === undefined) {
      const newer = [this.binding];
      let older = this.previous;
      while (older !== undefined && older.#declarationOrder === undefined) {
        newer.push(older.binding);
        older = older.previous;
      }
      this.#declarationOrder = Object.freeze([
        ...(older === undefined ? [] : older.declarationOrder),
        ...newer.reverse(),
      ]);
    }
    return this.#declarationOrder;
  }
}

class PersistentBindingEnvironment implements BindingEnvironment {
  readonly #locals: PersistentStringMap<BindingList>;

  constructor(
    readonly owner: object,
    readonly id: EnvironmentId,
    readonly epoch: EnvironmentEpoch,
    readonly parent: BindingEnvironment | undefined,
    readonly depth: number,
    locals: PersistentStringMap<BindingList> = PersistentStringMap.empty(),
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
  ): readonly Binding[] {
    return (
      this.#locals.get(indexKey(spelling, phase, space))?.declarationOrder ?? []
    );
  }

  [withBinding](
    id: EnvironmentId,
    epoch: EnvironmentEpoch,
    binding: Binding,
  ): PersistentBindingEnvironment {
    const key = indexKey(binding.spelling, binding.phase, binding.space);
    return new PersistentBindingEnvironment(
      this.owner,
      id,
      epoch,
      this.parent,
      this.depth,
      this.#locals.set(key, new BindingList(binding, this.#locals.get(key))),
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
