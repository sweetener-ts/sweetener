import {
  CaptureRecord,
  createCaptureLeaf,
  createCaptureSequence,
  joinedIdentifierText,
  type CaptureLeaf,
  type CapturePath,
  type CaptureValue,
  type IdentifierCasing,
} from "@sweetener/pattern";
import type { OriginId, ScopeId, ScopeSetId } from "@sweetener/shared";
import {
  createGroup,
  createMissingToken,
  createProtectedSyntax,
  createRootSyntax,
  createSyntaxSequence,
  createToken,
  type Syntax,
  type SyntaxSequence,
  type TokenSyntax,
} from "@sweetener/syntax";
import type { Binding, Phase, SyntaxSpace } from "./binding.js";
import type { BindingEnvironment, EnvironmentStore } from "./environment.js";
import type { ScopeStore } from "./scope-store.js";

export type BindingContractKind = "lexical" | "recursive" | "sequential";

export type BindingContractRegion =
  | { readonly kind: "capture"; readonly path: CapturePath }
  | { readonly kind: "following" };

export interface BindingContract {
  readonly origin: OriginId;
  readonly binders: CapturePath;
  readonly region: BindingContractRegion;
  readonly space: SyntaxSpace;
  readonly kind: BindingContractKind;
  readonly generatedName?: GeneratedBindingName | undefined;
}

export interface GeneratedBindingName {
  readonly prefix: string;
  readonly suffix: string;
  readonly casing: IdentifierCasing;
}

export interface GeneratedContractBinding {
  readonly spelling: string;
  readonly origin: OriginId;
  readonly scopes: ScopeSetId;
}

export function createBindingContract(
  options: BindingContract,
): BindingContract {
  if (!Object.isFrozen(options.binders)) {
    throw new TypeError("Binding-contract binder path must be immutable");
  }
  if (
    options.region.kind === "capture" &&
    !Object.isFrozen(options.region.path)
  ) {
    throw new TypeError("Binding-contract region path must be immutable");
  }
  return Object.freeze({
    ...options,
    generatedName:
      options.generatedName === undefined
        ? undefined
        : Object.freeze({ ...options.generatedName }),
    region: Object.freeze({ ...options.region }),
  });
}

interface Dimension {
  readonly group: number;
  readonly index: number;
}

interface LocatedLeaf {
  readonly leaf: CaptureLeaf;
  readonly dimensions: readonly Dimension[];
}

function locatePath(captures: CaptureRecord, path: CapturePath): LocatedLeaf[] {
  const root = captures.get(path.root);
  if (root === undefined) return [];
  const output: LocatedLeaf[] = [];
  const walk = (
    value: CaptureValue,
    fieldIndex: number,
    dimensions: readonly Dimension[],
  ): void => {
    if (value.kind === "sequence") {
      for (let index = 0; index < value.elements.length; index += 1) {
        walk(value.elements[index]!, fieldIndex, [
          ...dimensions,
          { group: value.cardinalityGroup, index },
        ]);
      }
      return;
    }
    const field = path.fields[fieldIndex];
    if (field === undefined) {
      output.push({ leaf: value, dimensions });
      return;
    }
    const selected = value.fields.get(field.capture);
    if (selected !== undefined) walk(selected, fieldIndex + 1, dimensions);
  };
  walk(root, 0, []);
  return output;
}

function indexFor(location: LocatedLeaf, group: number): number | undefined {
  return location.dimensions.find((dimension) => dimension.group === group)
    ?.index;
}

function commonGroups(
  binders: readonly LocatedLeaf[],
  regions: readonly LocatedLeaf[],
): readonly number[] {
  const binder = binders[0];
  const region = regions[0];
  if (binder === undefined || region === undefined) return [];
  const regionGroups = new Set(region.dimensions.map((item) => item.group));
  return binder.dimensions
    .map((item) => item.group)
    .filter((group) => regionGroups.has(group));
}

function alignmentKey(
  location: LocatedLeaf,
  groups: readonly number[],
): string {
  return groups
    .map((group) => `${group}:${String(indexFor(location, group))}`)
    .join("|");
}

function tokenSpelling(syntax: SyntaxSequence): string | undefined {
  const stack: Syntax[] = [...syntax].reverse();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (
      current.tag === "token" &&
      (current.kind === "identifier" ||
        current.kind === "private-identifier" ||
        current.kind === "jsx-identifier")
    ) {
      return current.raw;
    }
    if (
      current.tag === "group" ||
      current.tag === "protected" ||
      current.tag === "root"
    ) {
      stack.push(...[...current.children].reverse());
    }
  }
  return undefined;
}

function addScopesToSyntax(
  syntax: Syntax,
  store: ScopeStore,
  scopes: readonly ScopeId[],
): Syntax {
  let scopeSet = syntax.scopes;
  for (const scope of scopes) scopeSet = store.add(scopeSet, scope);
  switch (syntax.tag) {
    case "token":
      return createToken({ ...syntax, scopes: scopeSet });
    case "group": {
      const open = addScopesToSyntax(syntax.open, store, scopes) as TokenSyntax;
      const close =
        syntax.close.tag === "token"
          ? (addScopesToSyntax(syntax.close, store, scopes) as TokenSyntax)
          : createMissingToken({ ...syntax.close, scopes: scopeSet });
      return createGroup({
        ...syntax,
        scopes: scopeSet,
        open,
        children: syntax.children.map((child) =>
          addScopesToSyntax(child, store, scopes),
        ),
        close,
      });
    }
    case "protected":
      return createProtectedSyntax({
        ...syntax,
        scopes: scopeSet,
        children: syntax.children.map((child) =>
          addScopesToSyntax(child, store, scopes),
        ),
      });
    case "root":
      return createRootSyntax({
        ...syntax,
        scopes: scopeSet,
        children: syntax.children.map((child) =>
          addScopesToSyntax(child, store, scopes),
        ),
      });
  }
}

function transformValue(
  value: CaptureValue,
  scopesByLeaf: ReadonlyMap<CaptureLeaf, readonly ScopeId[]>,
  store: ScopeStore,
): CaptureValue {
  if (value.kind === "sequence") {
    return createCaptureSequence({
      depth: value.depth,
      cardinalityGroup: value.cardinalityGroup,
      elements: value.elements.map((element) =>
        transformValue(element, scopesByLeaf, store),
      ),
    });
  }
  const fields = new CaptureRecord(
    value.fields
      .entries()
      .map(([capture, field]) => [
        capture,
        transformValue(field, scopesByLeaf, store),
      ]),
  );
  const scopes = scopesByLeaf.get(value) ?? [];
  return createCaptureLeaf({
    id: value.id,
    classId: value.classId,
    syntax: createSyntaxSequence(
      value.syntax.map((syntax) => addScopesToSyntax(syntax, store, scopes)),
    ),
    fields,
    origin: value.origin,
  });
}

function addLeafScope(
  target: Map<CaptureLeaf, ScopeId[]>,
  leaf: CaptureLeaf,
  scope: ScopeId,
): void {
  const scopes = target.get(leaf) ?? [];
  if (!scopes.includes(scope)) scopes.push(scope);
  target.set(leaf, scopes);
}

export interface ApplyBindingContractOptions {
  readonly captures: CaptureRecord;
  readonly scopeStore: ScopeStore;
  readonly environments: EnvironmentStore;
  readonly environment: BindingEnvironment;
  readonly phase: Phase;
  readonly position: number;
  readonly followingScopes?: ScopeSetId | undefined;
  readonly extractBindings?:
    | ((syntax: SyntaxSequence) => readonly {
        readonly spelling: string;
        readonly origin: OriginId;
        readonly scopes: ScopeSetId;
      }[])
    | undefined;
}

export interface ApplyBindingContractResult {
  readonly captures: CaptureRecord;
  readonly environment: BindingEnvironment;
  readonly bindings: readonly Binding[];
  readonly followingScopes: ScopeSetId;
  readonly introducedScopes: readonly ScopeId[];
  readonly generatedBindings: readonly GeneratedContractBinding[];
}

export function applyBindingContract(
  contract: BindingContract,
  options: ApplyBindingContractOptions,
): ApplyBindingContractResult {
  const binders = locatePath(options.captures, contract.binders);
  const regions =
    contract.region.kind === "capture"
      ? locatePath(options.captures, contract.region.path)
      : [];
  // A contract over a repetition that matched nothing binds nothing.
  //
  // These were refusals, and they read as though they caught a contract that
  // names a capture the rule does not have -- but that is caught when the
  // macro is compiled, as `SWR3002`, so the only thing left for them to catch
  // is a path that exists and selected nothing this time. That is an ordinary
  // outcome: `bind $arm.binders in $result` over a match whose every arm binds
  // nothing, or `bind $typeParameter in $constructor.fields.valueType` over a
  // `data` declaration whose constructors have no fields. Refused here, an
  // enum of nullary variants could not be declared or matched at all, and the
  // refusal arrived as an expansion failure rather than as a diagnostic,
  // because it is thrown rather than reported.
  if (
    binders.length === 0 ||
    (contract.region.kind === "capture" && regions.length === 0)
  ) {
    return Object.freeze({
      captures: options.captures,
      environment: options.environment,
      bindings: Object.freeze([]),
      followingScopes: options.followingScopes ?? options.scopeStore.empty(),
      introducedScopes: Object.freeze([]),
      generatedBindings: Object.freeze([]),
    });
  }

  const scopesByLeaf = new Map<CaptureLeaf, ScopeId[]>();
  const bindingScopesByLeaf = new Map<CaptureLeaf, ScopeId[]>();
  const allocated: ScopeId[] = [];
  const groups = commonGroups(binders, regions);
  if (contract.kind === "sequential") {
    const sequentialGroup = groups.at(-1);
    if (sequentialGroup === undefined) {
      throw new RangeError(
        "Sequential binding contract has no aligned dimension",
      );
    }
    const outerGroups = groups.slice(0, -1);
    const partitions = new Map<string, LocatedLeaf[]>();
    for (const binder of binders) {
      const key = alignmentKey(binder, outerGroups);
      const values = partitions.get(key) ?? [];
      values.push(binder);
      partitions.set(key, values);
    }
    for (const partition of partitions.values()) {
      const byIndex = new Map<number, LocatedLeaf[]>();
      for (const binder of partition) {
        const binderIndex = indexFor(binder, sequentialGroup)!;
        const values = byIndex.get(binderIndex) ?? [];
        values.push(binder);
        byIndex.set(binderIndex, values);
      }
      const precedingScopes: ScopeId[] = [];
      for (const [binderIndex, binderGroup] of [...byIndex].sort(
        ([left], [right]) => left - right,
      )) {
        const scope = options.scopeStore.freshScope(
          "lexical",
          "binding contract",
        );
        allocated.push(scope);
        for (const binder of binderGroup) {
          for (const preceding of precedingScopes) {
            addLeafScope(bindingScopesByLeaf, binder.leaf, preceding);
            if (contract.generatedName === undefined)
              addLeafScope(scopesByLeaf, binder.leaf, preceding);
          }
          addLeafScope(bindingScopesByLeaf, binder.leaf, scope);
          if (contract.generatedName === undefined) {
            addLeafScope(scopesByLeaf, binder.leaf, scope);
          }
        }
        const reference = binderGroup[0]!;
        for (const region of regions) {
          const sameOuter = outerGroups.every(
            (group) => indexFor(region, group) === indexFor(reference, group),
          );
          const regionIndex = indexFor(region, sequentialGroup);
          if (
            sameOuter &&
            regionIndex !== undefined &&
            regionIndex > binderIndex
          ) {
            addLeafScope(scopesByLeaf, region.leaf, scope);
          }
        }
        precedingScopes.push(scope);
      }
    }
  } else {
    const partitions = new Map<string, LocatedLeaf[]>();
    for (const binder of binders) {
      const key = alignmentKey(binder, groups);
      const values = partitions.get(key) ?? [];
      values.push(binder);
      partitions.set(key, values);
    }
    for (const [key, binderGroup] of partitions) {
      const scope = options.scopeStore.freshScope(
        "lexical",
        "binding contract",
      );
      allocated.push(scope);
      for (const binder of binderGroup) {
        addLeafScope(bindingScopesByLeaf, binder.leaf, scope);
        if (contract.generatedName === undefined)
          addLeafScope(scopesByLeaf, binder.leaf, scope);
      }
      for (const region of regions) {
        if (groups.length === 0 || alignmentKey(region, groups) === key) {
          addLeafScope(scopesByLeaf, region.leaf, scope);
        }
      }
    }
  }

  const transformed = new CaptureRecord(
    options.captures
      .entries()
      .map(([capture, value]) => [
        capture,
        transformValue(value, scopesByLeaf, options.scopeStore),
      ]),
  );
  let environment = options.environment;
  const bindings: Binding[] = [];
  const generatedBindings: GeneratedContractBinding[] = [];
  for (const binder of binders) {
    const fallbackSpelling = tokenSpelling(binder.leaf.syntax);
    const names =
      contract.generatedName === undefined
        ? (options.extractBindings?.(binder.leaf.syntax) ??
          (fallbackSpelling === undefined
            ? []
            : [
                {
                  spelling: fallbackSpelling,
                  origin: binder.leaf.origin,
                  scopes:
                    binder.leaf.syntax[0]?.scopes ?? options.scopeStore.empty(),
                },
              ]))
        : fallbackSpelling === undefined
          ? []
          : [
              {
                spelling: joinedIdentifierText(
                  contract.generatedName,
                  fallbackSpelling,
                ),
                origin: binder.leaf.origin,
                scopes:
                  binder.leaf.syntax[0]?.scopes ?? options.scopeStore.empty(),
              },
            ];
    if (names.length === 0) {
      throw new TypeError("Binding capture does not contain an identifier");
    }
    for (const name of names) {
      let bindingScopes = name.scopes;
      const declaredScopes =
        contract.generatedName === undefined
          ? scopesByLeaf.get(binder.leaf)
          : bindingScopesByLeaf.get(binder.leaf);
      for (const scope of declaredScopes ?? []) {
        bindingScopes = options.scopeStore.add(bindingScopes, scope);
      }
      const declared = options.environments.declare(environment, {
        spelling: name.spelling,
        scopes: bindingScopes,
        phase: options.phase,
        space: contract.space,
        declaration: name.origin,
        kind: "lexical",
        visibility:
          contract.region.kind === "following"
            ? { kind: "from", start: options.position }
            : { kind: "whole-frame" },
      });
      environment = declared.environment;
      bindings.push(declared.binding);
      if (contract.generatedName !== undefined) {
        generatedBindings.push(
          Object.freeze({
            spelling: name.spelling,
            origin: name.origin,
            scopes: bindingScopes,
          }),
        );
      }
    }
  }
  let followingScopes = options.followingScopes ?? options.scopeStore.empty();
  if (contract.region.kind === "following" || contract.kind !== "lexical") {
    for (const scope of allocated) {
      followingScopes = options.scopeStore.add(followingScopes, scope);
    }
  }
  return Object.freeze({
    captures: transformed,
    environment,
    bindings: Object.freeze(bindings),
    followingScopes,
    introducedScopes: Object.freeze(allocated),
    generatedBindings: Object.freeze(generatedBindings),
  });
}

export interface ApplyBindingContractsOptions extends ApplyBindingContractOptions {
  readonly contracts: readonly BindingContract[];
}

/** Applies contracts in declaration order, threading immutable captures and environments. */
export function applyBindingContracts(
  options: ApplyBindingContractsOptions,
): ApplyBindingContractResult {
  let captures = options.captures;
  let environment = options.environment;
  let followingScopes = options.followingScopes ?? options.scopeStore.empty();
  const bindings: Binding[] = [];
  const introducedScopes: ScopeId[] = [];
  const generatedBindings: GeneratedContractBinding[] = [];

  for (const contract of options.contracts) {
    const result = applyBindingContract(contract, {
      ...options,
      captures,
      environment,
      followingScopes,
    });
    captures = result.captures;
    environment = result.environment;
    followingScopes = result.followingScopes;
    bindings.push(...result.bindings);
    introducedScopes.push(...result.introducedScopes);
    generatedBindings.push(...result.generatedBindings);
  }

  return Object.freeze({
    captures,
    environment,
    bindings: Object.freeze(bindings),
    followingScopes,
    introducedScopes: Object.freeze(introducedScopes),
    generatedBindings: Object.freeze(generatedBindings),
  });
}
