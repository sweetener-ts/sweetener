import type { BindingId, SyntaxId } from "@sweetener/shared";

/**
 * `shorthand-value` covers `{ x }`, where the property keeps its spelling and
 * the value moves. `import-binding` covers `import { x }`, where the spelling
 * names the module's export and only the local binding may move.
 */
export type NameOccurrenceKind =
  "identifier" | "shorthand-value" | "import-binding";

interface NamedBinding {
  readonly binding: BindingId;
  readonly preferredName: string;
}

/** A declaration that lists the bindings it conflicts with. */
export interface BindingNameDeclaration extends NamedBinding {
  /**
   * Bindings simultaneously visible with this binding after hygiene erasure.
   * A declaration that conflicts with none lists none.
   */
  readonly conflicts: readonly BindingId[];
}

/**
 * A declaration among ones that each conflict with every other, which lists
 * no conflicts of its own.
 */
export interface ConflictingBindingNameDeclaration extends NamedBinding {
  readonly conflicts?: never;
}

export interface BindingNameOccurrence {
  readonly syntax: SyntaxId;
  readonly binding: BindingId;
  readonly kind: NameOccurrenceKind;
  /**
   * Required for shorthand values and import bindings; this is the spelling
   * that must stay put — the property key, or the imported export's name.
   */
  readonly propertySpelling?: string | undefined;
}

export interface NameRewrite {
  readonly syntax: SyntaxId;
  readonly binding: BindingId;
  readonly printedName: string;
  readonly replacement: string;
  readonly expandsShorthand: boolean;
}

export interface NameAssignmentPlan {
  readonly names: ReadonlyMap<BindingId, string>;
  readonly rewrites: readonly NameRewrite[];
  nameFor(binding: BindingId): string | undefined;
}

interface AssignPrintedNamesCommonOptions {
  /** Occurrences must be in expanded-file traversal order. */
  readonly occurrences: readonly BindingNameOccurrence[];
  /** Unbound or property names which generated binding names must not shadow. */
  readonly unavailableNames?: readonly string[] | undefined;
}

/** Declarations that each list what they conflict with. */
export interface ListedConflictsOptions extends AssignPrintedNamesCommonOptions {
  readonly declarations: readonly BindingNameDeclaration[];
  readonly everyDeclarationConflicts?: false | undefined;
}

/**
 * Declarations that each conflict with every other. Saying so once spares
 * listing the n² conflicts between n declarations, and lets each declaration
 * take its name without looking at every name taken before it.
 */
export interface EveryDeclarationConflictsOptions extends AssignPrintedNamesCommonOptions {
  readonly declarations: readonly ConflictingBindingNameDeclaration[];
  readonly everyDeclarationConflicts: true;
}

/**
 * Either every declaration lists its conflicts, or none does and every one
 * conflicts with every other: a declaration whose conflicts were forgotten is
 * a type error, not one that conflicts with nothing.
 */
export type AssignPrintedNamesOptions =
  ListedConflictsOptions | EveryDeclarationConflictsOptions;

const reservedWords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

function legalBase(preferredName: string): string {
  const normalized = preferredName.normalize("NFC");
  const parts = [...normalized];
  let result = "";
  for (const [index, part] of parts.entries()) {
    const valid =
      index === 0
        ? /^[$_\p{ID_Start}]$/u.test(part)
        : /^[$_\u200c\u200d\p{ID_Continue}]$/u.test(part);
    result += valid ? part : "_";
  }
  if (result.length === 0 || !/^[$_\p{ID_Start}]$/u.test([...result][0]!)) {
    result = `_${result}`;
  }
  return reservedWords.has(result) ? `_${result}` : result;
}

function immutableMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const map = new Map(source);
  return Object.freeze({
    get size() {
      return map.size;
    },
    get: (key: K) => map.get(key),
    has: (key: K) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback: (value: V, key: K, owner: ReadonlyMap<K, V>) => void) =>
      map.forEach((value, key) => callback(value, key, source)),
    [Symbol.iterator]: () => map[Symbol.iterator](),
    [Symbol.toStringTag]: "Map",
  } as ReadonlyMap<K, V>);
}

type AnyBindingNameDeclaration =
  BindingNameDeclaration | ConflictingBindingNameDeclaration;

/** `base`, then `base_1`, `base_2` and so on. */
function suffixed(base: string, suffix: number): string {
  return suffix === 0 ? base : `${base}_${String(suffix)}`;
}

function namesForListedConflicts(
  ordered: readonly AnyBindingNameDeclaration[],
  declarations: ReadonlyMap<BindingId, AnyBindingNameDeclaration>,
  unavailable: ReadonlySet<string>,
): Map<BindingId, string> {
  const conflictGraph = new Map<BindingId, Set<BindingId>>(
    ordered.map((declaration) => [declaration.binding, new Set()]),
  );
  for (const declaration of ordered) {
    if (declaration.conflicts === undefined) {
      throw new TypeError(
        `Binding ${String(declaration.binding)} lists no conflicts, and not every declaration conflicts with every other`,
      );
    }
    for (const conflict of declaration.conflicts) {
      if (!declarations.has(conflict)) {
        throw new RangeError(
          `Binding ${String(declaration.binding)} conflicts with unknown binding ${String(conflict)}`,
        );
      }
      conflictGraph.get(declaration.binding)!.add(conflict);
      conflictGraph.get(conflict)!.add(declaration.binding);
    }
  }
  const names = new Map<BindingId, string>();
  for (const declaration of ordered) {
    const conflictNames = new Set(
      [...conflictGraph.get(declaration.binding)!].flatMap((binding) => {
        const name = names.get(binding);
        return name === undefined ? [] : [name];
      }),
    );
    const base = legalBase(declaration.preferredName);
    let suffix = 0;
    while (
      unavailable.has(suffixed(base, suffix)) ||
      conflictNames.has(suffixed(base, suffix))
    )
      suffix += 1;
    names.set(declaration.binding, suffixed(base, suffix));
  }
  return names;
}

/**
 * The names `namesForListedConflicts` gives when every declaration conflicts
 * with every other: each takes the first of its base's names that is neither
 * unavailable nor taken by an earlier declaration.
 *
 * Taken names are never given back, so a name passed over once stays passed
 * over, and each base's search resumes where its last one stopped. A name is
 * among the names of at most two bases, itself and the base its numeric
 * suffix was added to, so the searches together pass over each taken or
 * unavailable name at most twice, where searching from the start cost n² for
 * n declarations of one base.
 */
function namesAllConflicting(
  ordered: readonly AnyBindingNameDeclaration[],
  unavailable: ReadonlySet<string>,
): Map<BindingId, string> {
  const names = new Map<BindingId, string>();
  const taken = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (const declaration of ordered) {
    if (declaration.conflicts !== undefined) {
      throw new TypeError(
        `Binding ${String(declaration.binding)} lists its conflicts, but every declaration conflicts with every other`,
      );
    }
    const base = legalBase(declaration.preferredName);
    let suffix = nextSuffix.get(base) ?? 0;
    while (
      unavailable.has(suffixed(base, suffix)) ||
      taken.has(suffixed(base, suffix))
    )
      suffix += 1;
    const name = suffixed(base, suffix);
    nextSuffix.set(base, suffix + 1);
    taken.add(name);
    names.set(declaration.binding, name);
  }
  return names;
}

export function assignPrintedNames(
  options: AssignPrintedNamesOptions,
): NameAssignmentPlan {
  const declarations = new Map<BindingId, AnyBindingNameDeclaration>();
  for (const declaration of options.declarations) {
    if (declarations.has(declaration.binding)) {
      throw new RangeError(`Duplicate binding ${String(declaration.binding)}`);
    }
    declarations.set(declaration.binding, declaration);
  }
  const firstOccurrence = new Map<BindingId, number>();
  options.occurrences.forEach((occurrence, index) => {
    if (!declarations.has(occurrence.binding)) {
      throw new RangeError(
        `Occurrence names unknown binding ${String(occurrence.binding)}`,
      );
    }
    if (!firstOccurrence.has(occurrence.binding)) {
      firstOccurrence.set(occurrence.binding, index);
    }
    if (
      occurrence.kind !== "identifier" &&
      occurrence.propertySpelling === undefined
    ) {
      throw new TypeError(
        `${occurrence.kind} occurrence requires a property spelling`,
      );
    }
  });
  for (const declaration of declarations.values()) {
    if (!firstOccurrence.has(declaration.binding)) {
      throw new RangeError(
        `Binding ${String(declaration.binding)} has no traversal occurrence`,
      );
    }
  }
  const ordered = [...declarations.values()].sort(
    (left, right) =>
      firstOccurrence.get(left.binding)! - firstOccurrence.get(right.binding)!,
  );
  const unavailable = new Set(options.unavailableNames ?? []);
  const names =
    options.everyDeclarationConflicts === true
      ? namesAllConflicting(ordered, unavailable)
      : namesForListedConflicts(ordered, declarations, unavailable);
  const readonlyNames = immutableMap(names);
  const separators = { "shorthand-value": ": ", "import-binding": " as " };
  const rewrites = options.occurrences.map((occurrence) => {
    const printedName = names.get(occurrence.binding)!;
    const expandsShorthand =
      occurrence.kind !== "identifier" &&
      occurrence.propertySpelling !== printedName;
    return Object.freeze({
      syntax: occurrence.syntax,
      binding: occurrence.binding,
      printedName,
      replacement: expandsShorthand
        ? `${occurrence.propertySpelling!}${separators[occurrence.kind as keyof typeof separators]}${printedName}`
        : printedName,
      expandsShorthand,
    });
  });
  return Object.freeze({
    names: readonlyNames,
    rewrites: Object.freeze(rewrites),
    nameFor: (binding: BindingId) => names.get(binding),
  });
}
