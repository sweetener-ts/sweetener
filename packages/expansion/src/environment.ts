import type { Binding, Phase, SyntaxSpace } from "@sweetener/hygiene";
import {
  createIdAllocator,
  type BindingId,
  type DefinitionContextId,
  type EnvironmentEpoch,
  type EnvironmentId,
  type OriginId,
} from "@sweetener/shared";
import type { SyntaxCategory } from "@sweetener/syntax";

export type OperatorFixity = "prefix" | "infix" | "postfix";
export type OperatorAssociativity = "left" | "right" | "none";

export interface OperatorBinding {
  readonly binding: BindingId;
  readonly spelling: string;
  readonly phase: Phase;
  readonly category: SyntaxCategory;
  readonly fixity: OperatorFixity;
  readonly associativity: OperatorAssociativity;
  readonly precedence: number;
  readonly origin: OriginId;
}

export interface ExpansionEnvironment {
  readonly id: EnvironmentId;
  readonly epoch: EnvironmentEpoch;
  readonly parent: ExpansionEnvironment | undefined;
  readonly depth: number;
  readonly definitionContext: DefinitionContextId;
}

export interface ExpansionBindingQuery {
  readonly spelling: string;
  readonly phase: Phase;
  readonly category: SyntaxCategory;
}

export interface OperatorBindingQuery {
  readonly spelling: string;
  readonly phase: Phase;
  readonly category: SyntaxCategory;
  readonly fixity?: OperatorFixity | undefined;
}

export function syntaxSpaceForCategory(category: SyntaxCategory): SyntaxSpace {
  switch (category) {
    case "item":
      return "syntax-item";
    case "stmt":
      return "syntax-stmt";
    case "expr":
      return "syntax-expr";
    case "type":
      return "syntax-type";
    case "binding":
      return "syntax-binding";
    case "classElement":
      return "syntax-class-element";
    case "typeMember":
      return "syntax-type-member";
    case "jsxChild":
      return "syntax-jsx-child";
    case "token":
      return "syntax-token";
    case "tt":
      return "syntax-tt";
  }
}

function bindingKey(
  spelling: string,
  phase: Phase,
  space: SyntaxSpace,
): string {
  return `${String(spelling.length)}:${spelling}|${String(phase)}|${space}`;
}

function operatorKey(
  spelling: string,
  phase: Phase,
  category: SyntaxCategory,
): string {
  return `${String(spelling.length)}:${spelling}|${String(phase)}|${category}`;
}

function requireSpelling(spelling: string, field: string): void {
  if (spelling.length === 0 || /[\r\n]/u.test(spelling)) {
    throw new RangeError(`${field} must be nonempty and fit on one line`);
  }
}

function createOperatorBinding(options: OperatorBinding): OperatorBinding {
  requireSpelling(options.spelling, "Operator spelling");
  if (!Number.isSafeInteger(options.precedence) || options.precedence < 0) {
    throw new RangeError(
      "Operator precedence must be a non-negative safe integer",
    );
  }
  if (options.fixity !== "infix" && options.associativity !== "none") {
    throw new RangeError("Prefix and postfix operators must be nonassociative");
  }
  return Object.freeze({ ...options });
}

const extendEnvironment: unique symbol = Symbol("extend-environment");

class PersistentExpansionEnvironment implements ExpansionEnvironment {
  constructor(
    readonly owner: object,
    readonly id: EnvironmentId,
    readonly epoch: EnvironmentEpoch,
    readonly parent: ExpansionEnvironment | undefined,
    readonly depth: number,
    readonly definitionContext: DefinitionContextId,
    readonly bindings: ReadonlyMap<string, readonly Binding[]> = new Map(),
    readonly operators: ReadonlyMap<
      string,
      readonly OperatorBinding[]
    > = new Map(),
  ) {
    Object.freeze(this);
  }

  [extendEnvironment](
    id: EnvironmentId,
    epoch: EnvironmentEpoch,
    bindings: ReadonlyMap<string, readonly Binding[]>,
    operators: ReadonlyMap<string, readonly OperatorBinding[]>,
  ): PersistentExpansionEnvironment {
    return new PersistentExpansionEnvironment(
      this.owner,
      id,
      epoch,
      this.parent,
      this.depth,
      this.definitionContext,
      bindings,
      operators,
    );
  }
}

export class ExpansionEnvironmentStore {
  readonly #owner = Object.freeze({});
  readonly #environmentIds = createIdAllocator<EnvironmentId>(1);
  readonly #epochs = createIdAllocator<EnvironmentEpoch>(0);
  readonly #contexts = createIdAllocator<DefinitionContextId>(1);

  createRoot(): ExpansionEnvironment {
    return new PersistentExpansionEnvironment(
      this.#owner,
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      undefined,
      0,
      this.#contexts.allocate(),
    );
  }

  child(parent: ExpansionEnvironment): ExpansionEnvironment {
    const checked = this.#require(parent);
    return new PersistentExpansionEnvironment(
      this.#owner,
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      checked,
      checked.depth + 1,
      this.#contexts.allocate(),
    );
  }

  extendBinding(
    environment: ExpansionEnvironment,
    binding: Binding,
  ): ExpansionEnvironment {
    const checked = this.#require(environment);
    const expectedPrefix = "syntax-";
    if (!binding.space.startsWith(expectedPrefix)) {
      throw new TypeError(
        "Expansion environment accepts only syntax-space bindings",
      );
    }
    const key = bindingKey(binding.spelling, binding.phase, binding.space);
    const bindings = new Map(checked.bindings);
    const local = checked.bindings.get(key) ?? [];
    if (local.some((candidate) => candidate.id === binding.id)) return checked;
    bindings.set(key, Object.freeze([...local, binding]));
    return checked[extendEnvironment](
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      bindings,
      checked.operators,
    );
  }

  lookupBindings(
    environment: ExpansionEnvironment,
    query: ExpansionBindingQuery,
  ): readonly Binding[] {
    this.#require(environment);
    const key = bindingKey(
      query.spelling,
      query.phase,
      syntaxSpaceForCategory(query.category),
    );
    let current: ExpansionEnvironment | undefined = environment;
    while (current !== undefined) {
      const checked = this.#require(current);
      const candidates = checked.bindings.get(key);
      if (candidates !== undefined && candidates.length > 0) return candidates;
      current = checked.parent;
    }
    return Object.freeze([]);
  }

  extendOperator(
    environment: ExpansionEnvironment,
    operator: OperatorBinding,
  ): ExpansionEnvironment {
    const checked = this.#require(environment);
    const value = createOperatorBinding(operator);
    const key = operatorKey(value.spelling, value.phase, value.category);
    const operators = new Map(checked.operators);
    const local = checked.operators.get(key) ?? [];
    if (local.some((candidate) => candidate.binding === value.binding))
      return checked;
    if (local.some((candidate) => candidate.fixity === value.fixity)) {
      throw new RangeError(
        `Duplicate local ${value.fixity} operator ${value.spelling}`,
      );
    }
    operators.set(key, Object.freeze([...local, value]));
    return checked[extendEnvironment](
      this.#environmentIds.allocate(),
      this.#epochs.allocate(),
      checked.bindings,
      operators,
    );
  }

  lookupOperators(
    environment: ExpansionEnvironment,
    query: OperatorBindingQuery,
  ): readonly OperatorBinding[] {
    this.#require(environment);
    const key = operatorKey(query.spelling, query.phase, query.category);
    let current: ExpansionEnvironment | undefined = environment;
    while (current !== undefined) {
      const checked = this.#require(current);
      const candidates = checked.operators.get(key);
      if (candidates !== undefined && candidates.length > 0) {
        if (query.fixity === undefined) return candidates;
        const matching = candidates.filter(
          (candidate) => candidate.fixity === query.fixity,
        );
        if (matching.length > 0) return Object.freeze(matching);
      }
      current = checked.parent;
    }
    return Object.freeze([]);
  }

  lookupLocalOperators(
    environment: ExpansionEnvironment,
    query: OperatorBindingQuery,
  ): readonly OperatorBinding[] {
    const checked = this.#require(environment);
    const candidates =
      checked.operators.get(
        operatorKey(query.spelling, query.phase, query.category),
      ) ?? [];
    return query.fixity === undefined
      ? candidates
      : Object.freeze(
          candidates.filter(({ fixity }) => fixity === query.fixity),
        );
  }

  #require(environment: ExpansionEnvironment): PersistentExpansionEnvironment {
    if (
      !(environment instanceof PersistentExpansionEnvironment) ||
      environment.owner !== this.#owner
    ) {
      throw new TypeError("Expansion environment belongs to another store");
    }
    return environment;
  }
}
