import type {
  CaptureId,
  CardinalityGroupId,
  Diagnostic,
  OriginId,
  RuleId,
  SourceId,
  SyntaxClassId,
} from "@sweetener/shared";
import type { Span, Syntax, SyntaxCursor } from "@sweetener/syntax";
import {
  createSyntaxSequence,
  greaterThanTokenWidth,
  isIdentifierToken,
} from "@sweetener/syntax";
import type { PatternNode } from "./ast.js";
import {
  CaptureRecord,
  createCaptureLeaf,
  createCaptureSequence,
  type CaptureValue,
} from "./capture-record.js";
import {
  createLeafShape,
  createSequenceShape,
  CaptureShapeRecord,
} from "./capture-shape.js";
import {
  leftRecursiveSyntaxClassCode,
  invalidRefinementCode,
  patternDiagnosticRegistry,
  unresolvedSyntaxClassCode,
} from "./diagnostics.js";
import { compileMatcherProgram } from "./matcher-compiler.js";
import {
  describeFailureAs,
  farthestFailure,
  type MatchFailure,
} from "./matcher-failure.js";
import type { MatcherProgram } from "./matcher-program.js";
import {
  executeMatcher,
  type ExecuteMatcherOptions,
  type SyntaxClassConsumer,
  type SyntaxClassMatch,
} from "./matcher-vm.js";
import {
  createRefinement,
  evaluateRefinements,
  type CaptureRefinement,
  type RefinementPredicate,
} from "./refinement.js";
import {
  inferCaptureShapes,
  validateClassRuleFields,
} from "./shape-inference.js";

export interface SyntaxClassFieldInput {
  readonly capture: CaptureId;
  readonly name: string;
  readonly classId: SyntaxClassId;
  readonly repeated: boolean;
  /** An optional field may be left unbound by a rule that does not match it. */
  readonly optional?: boolean | undefined;
  readonly origin: OriginId;
}

export interface SyntaxClassRuleInput {
  readonly rule: RuleId;
  readonly pattern: PatternNode;
  readonly origin: OriginId;
  readonly refinements?: readonly SyntaxClassRefinementInput[] | undefined;
  readonly failureDescription?: string | undefined;
}

export interface SyntaxClassRefinementInput {
  readonly targetName: string;
  readonly predicate: RefinementPredicate;
  readonly origin: OriginId;
}

export interface SyntaxClassInput {
  readonly classId: SyntaxClassId;
  readonly name: string;
  readonly origin: OriginId;
  readonly fields: readonly SyntaxClassFieldInput[];
  readonly rules: readonly SyntaxClassRuleInput[];
}

export interface CompiledSyntaxClassField extends SyntaxClassFieldInput {
  readonly cardinalityGroup: CardinalityGroupId | undefined;
}

export interface CompiledSyntaxClassRule {
  readonly rule: RuleId;
  readonly origin: OriginId;
  readonly program: MatcherProgram;
  readonly fieldSources: readonly {
    readonly field: CaptureId;
    readonly source: CaptureId;
  }[];
  readonly refinements: readonly CaptureRefinement[];
  readonly failureDescription: string | undefined;
}

export interface CompiledSyntaxClass {
  readonly classId: SyntaxClassId;
  readonly name: string;
  readonly origin: OriginId;
  readonly fields: readonly CompiledSyntaxClassField[];
  readonly rules: readonly CompiledSyntaxClassRule[];
}

export interface BuiltinSyntaxClassIds {
  readonly token: SyntaxClassId;
  readonly tt: SyntaxClassId;
  readonly ident: SyntaxClassId;
}

export interface CompileSyntaxClassesOptions {
  readonly sourceId: SourceId;
  readonly spanForOrigin: (origin: OriginId) => Span;
  readonly builtins: BuiltinSyntaxClassIds;
  readonly externalClassIds?: readonly SyntaxClassId[] | undefined;
}

export interface CompileSyntaxClassesResult {
  readonly registry: SyntaxClassRegistry;
  readonly diagnostics: readonly Diagnostic[];
}

export class SyntaxClassRegistry {
  readonly #classes: ReadonlyMap<SyntaxClassId, CompiledSyntaxClass>;
  readonly #shapes: ReadonlyMap<SyntaxClassId, CaptureShapeRecord>;

  constructor(classes: readonly CompiledSyntaxClass[]) {
    const values = new Map<SyntaxClassId, CompiledSyntaxClass>();
    for (const syntaxClass of classes) {
      if (values.has(syntaxClass.classId)) {
        throw new RangeError(
          `Duplicate syntax class ${String(syntaxClass.classId)}`,
        );
      }
      values.set(syntaxClass.classId, syntaxClass);
    }
    this.#classes = values;
    const shapes = new Map<SyntaxClassId, CaptureShapeRecord>();
    const pending = new Map(values);
    let madeProgress = true;
    const createShape = (syntaxClass: CompiledSyntaxClass) =>
      new CaptureShapeRecord(
        syntaxClass.fields.map((field) => {
          const leaf = createLeafShape(
            field.classId,
            shapes.get(field.classId) ?? CaptureShapeRecord.empty,
          );
          return [
            field.capture,
            field.repeated
              ? createSequenceShape({
                  element: leaf,
                  cardinalityGroup:
                    field.cardinalityGroup ??
                    (field.capture as unknown as CardinalityGroupId),
                  minimum: 0,
                })
              : leaf,
          ] as const;
        }),
      );
    while (pending.size > 0 && madeProgress) {
      madeProgress = false;
      for (const [classId, syntaxClass] of pending) {
        if (
          syntaxClass.fields.some(
            (field) => values.has(field.classId) && !shapes.has(field.classId),
          )
        ) {
          continue;
        }
        shapes.set(classId, createShape(syntaxClass));
        pending.delete(classId);
        madeProgress = true;
      }
    }
    for (const [classId, syntaxClass] of pending) {
      shapes.set(classId, createShape(syntaxClass));
    }
    this.#shapes = shapes;
    Object.freeze(this);
  }

  get(classId: SyntaxClassId): CompiledSyntaxClass | undefined {
    return this.#classes.get(classId);
  }

  list(): readonly CompiledSyntaxClass[] {
    return Object.freeze(
      [...this.#classes.values()].sort(
        (left, right) => left.classId - right.classId,
      ),
    );
  }

  shapeForClass(classId: SyntaxClassId): CaptureShapeRecord | undefined {
    return this.#shapes.get(classId);
  }
}

function patternConsumption(pattern: PatternNode): Map<PatternNode, boolean> {
  const consumes = new Map<PatternNode, boolean>();
  const stack = [{ node: pattern, visited: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (!frame.visited) {
      stack.push({ node: frame.node, visited: true });
      switch (frame.node.kind) {
        case "sequence":
          for (const child of frame.node.elements)
            stack.push({ node: child, visited: false });
          break;
        case "choice":
          for (const child of frame.node.alternatives)
            stack.push({ node: child, visited: false });
          break;
        case "group":
        case "optional":
        case "repeat":
          stack.push({ node: frame.node.body, visited: false });
          break;
        default:
          break;
      }
      continue;
    }
    const node = frame.node;
    switch (node.kind) {
      case "literal":
      case "capture":
      case "class-call":
      case "group":
        consumes.set(node, true);
        break;
      case "lookahead":
      case "optional":
        consumes.set(node, false);
        break;
      case "repeat":
        consumes.set(
          node,
          node.minimum > 0 && consumes.get(node.body) === true,
        );
        break;
      case "sequence":
        consumes.set(
          node,
          node.elements.some((child) => consumes.get(child) === true),
        );
        break;
      case "choice":
        consumes.set(
          node,
          node.alternatives.every((child) => consumes.get(child) === true),
        );
        break;
    }
  }
  return consumes;
}

/**
 * Every syntax class a pattern names, and where it named it. Exported so that
 * macro rules can be checked against the registry the same way class rules
 * are. A rule naming a class that does not exist would otherwise compile, and
 * report only that no rule matched wherever the macro is used.
 */
export function classReferences(pattern: PatternNode): readonly {
  classId: SyntaxClassId;
  origin: OriginId;
  guarded: boolean;
}[] {
  const consumes = patternConsumption(pattern);
  const references: {
    classId: SyntaxClassId;
    origin: OriginId;
    guarded: boolean;
  }[] = [];
  const stack: { node: PatternNode; guarded: boolean }[] = [
    { node: pattern, guarded: false },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    switch (node.kind) {
      case "capture":
      case "class-call":
        references.push({
          classId: node.classId,
          origin: node.origin,
          guarded: frame.guarded,
        });
        break;
      case "group":
        stack.push({ node: node.body, guarded: true });
        break;
      case "sequence": {
        let guarded = frame.guarded;
        for (const child of node.elements) {
          stack.push({ node: child, guarded });
          guarded ||= consumes.get(child) === true;
        }
        break;
      }
      case "choice":
        for (const child of node.alternatives)
          stack.push({ node: child, guarded: frame.guarded });
        break;
      case "optional":
      case "repeat":
        stack.push({ node: node.body, guarded: frame.guarded });
        break;
      default:
        break;
    }
  }
  return Object.freeze(references);
}

function sourceSpan(
  origin: OriginId,
  options: CompileSyntaxClassesOptions,
): { sourceId: SourceId; start: number; end: number; originId: OriginId } {
  const span = options.spanForOrigin(origin);
  return {
    sourceId: options.sourceId,
    start: span.start,
    end: span.end,
    originId: origin,
  };
}

export function compileSyntaxClasses(
  inputs: readonly SyntaxClassInput[],
  options: CompileSyntaxClassesOptions,
): CompileSyntaxClassesResult {
  const diagnostics: Diagnostic[] = [];
  const builtinIds = new Set<SyntaxClassId>(Object.values(options.builtins));
  const externalIds = new Set(options.externalClassIds ?? []);
  const userIds = new Set(inputs.map((input) => input.classId));
  const knownIds = new Set([...builtinIds, ...externalIds, ...userIds]);
  const unguarded = new Map<SyntaxClassId, Set<SyntaxClassId>>();
  const invalidClasses = new Set<SyntaxClassId>();

  for (const input of inputs) {
    const references = input.rules.flatMap((rule) =>
      classReferences(rule.pattern),
    );
    for (const reference of references) {
      if (!knownIds.has(reference.classId)) {
        invalidClasses.add(input.classId);
        diagnostics.push(
          patternDiagnosticRegistry.create(unresolvedSyntaxClassCode, {
            primaryOrigin: sourceSpan(reference.origin, options),
            messageArguments: [reference.classId],
          }),
        );
      } else if (!reference.guarded && userIds.has(reference.classId)) {
        let edges = unguarded.get(input.classId);
        if (edges === undefined) {
          edges = new Set();
          unguarded.set(input.classId, edges);
        }
        edges.add(reference.classId);
      }
    }
  }

  const recursive = new Set<SyntaxClassId>();
  for (const input of inputs) {
    const pending = [...(unguarded.get(input.classId) ?? [])];
    const seen = new Set<SyntaxClassId>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || seen.has(current)) continue;
      if (current === input.classId) {
        recursive.add(input.classId);
        break;
      }
      seen.add(current);
      pending.push(...(unguarded.get(current) ?? []));
    }
  }
  for (const input of inputs) {
    if (!recursive.has(input.classId)) continue;
    invalidClasses.add(input.classId);
    diagnostics.push(
      patternDiagnosticRegistry.create(leftRecursiveSyntaxClassCode, {
        primaryOrigin: sourceSpan(input.origin, options),
        messageArguments: [input.name],
      }),
    );
  }

  const declaredShapes = new Map<SyntaxClassId, CaptureShapeRecord>();
  const inputById = new Map(inputs.map((input) => [input.classId, input]));
  const createDeclaredShape = (input: SyntaxClassInput): CaptureShapeRecord =>
    new CaptureShapeRecord(
      input.fields.map((field) => {
        const leaf = createLeafShape(
          field.classId,
          declaredShapes.get(field.classId) ?? CaptureShapeRecord.empty,
        );
        return [
          field.capture,
          field.repeated
            ? createSequenceShape({
                element: leaf,
                cardinalityGroup:
                  field.capture as unknown as CardinalityGroupId,
                minimum: 0,
              })
            : leaf,
        ] as const;
      }),
    );
  const remainingShapes = new Map(inputById);
  let madeProgress = true;
  while (remainingShapes.size > 0 && madeProgress) {
    madeProgress = false;
    for (const [classId, input] of remainingShapes) {
      const dependenciesReady = input.fields.every(
        (field) =>
          !inputById.has(field.classId) || declaredShapes.has(field.classId),
      );
      if (!dependenciesReady) continue;
      declaredShapes.set(classId, createDeclaredShape(input));
      remainingShapes.delete(classId);
      madeProgress = true;
    }
  }
  for (const [classId, input] of remainingShapes) {
    declaredShapes.set(classId, createDeclaredShape(input));
  }

  const compiled: CompiledSyntaxClass[] = [];
  for (const input of inputs) {
    if (invalidClasses.has(input.classId)) continue;
    const rules: CompiledSyntaxClassRule[] = [];
    const fieldCardinalityGroups = new Map<CaptureId, CardinalityGroupId>();
    const canonicalGroups = new Map<CardinalityGroupId, CardinalityGroupId>();
    for (const rule of input.rules) {
      const inference = inferCaptureShapes(rule.pattern, {
        sourceId: options.sourceId,
        spanForOrigin: options.spanForOrigin,
        fieldsForClass: (classId) => declaredShapes.get(classId),
      });
      diagnostics.push(...inference.diagnostics);
      const fieldDiagnostics = validateClassRuleFields(
        input.fields,
        inference,
        options,
      );
      diagnostics.push(...fieldDiagnostics);
      if (inference.diagnostics.length > 0 || fieldDiagnostics.length > 0)
        continue;
      const bindingByName = new Map(
        inference.bindings.map((binding) => [binding.name, binding.capture]),
      );
      for (const field of input.fields) {
        if (!field.repeated || fieldCardinalityGroups.has(field.capture))
          continue;
        const source = bindingByName.get(field.name);
        const shape =
          source === undefined ? undefined : inference.shapes.get(source);
        if (shape?.kind !== "sequence") continue;
        let canonical = canonicalGroups.get(shape.cardinalityGroup);
        if (canonical === undefined) {
          canonical = field.capture as unknown as CardinalityGroupId;
          canonicalGroups.set(shape.cardinalityGroup, canonical);
        }
        fieldCardinalityGroups.set(field.capture, canonical);
      }
      const refinements: CaptureRefinement[] = [];
      for (const refinement of rule.refinements ?? []) {
        const target = bindingByName.get(refinement.targetName);
        if (target === undefined) {
          diagnostics.push(
            patternDiagnosticRegistry.create(invalidRefinementCode, {
              primaryOrigin: sourceSpan(refinement.origin, options),
              messageArguments: [refinement.targetName],
            }),
          );
          continue;
        }
        refinements.push(createRefinement(target, refinement.predicate));
      }
      if (refinements.length !== (rule.refinements?.length ?? 0)) continue;
      rules.push(
        Object.freeze({
          rule: rule.rule,
          origin: rule.origin,
          program: compileMatcherProgram(rule.pattern, {
            rule: rule.rule,
            inference,
          }),
          fieldSources: Object.freeze(
            input.fields.map((field) =>
              Object.freeze({
                field: field.capture,
                source: bindingByName.get(field.name)!,
              }),
            ),
          ),
          refinements: Object.freeze(refinements),
          failureDescription: rule.failureDescription,
        }),
      );
    }
    compiled.push(
      Object.freeze({
        classId: input.classId,
        name: input.name,
        origin: input.origin,
        fields: Object.freeze(
          input.fields.map((field) =>
            Object.freeze({
              ...field,
              cardinalityGroup: fieldCardinalityGroups.get(field.capture),
            }),
          ),
        ),
        rules: Object.freeze(rules),
      }),
    );
  }

  return Object.freeze({
    registry: new SyntaxClassRegistry(compiled),
    diagnostics: Object.freeze(diagnostics),
  });
}

function remapCaptureValue(
  value: CaptureValue,
  id: CaptureId,
  cardinalityGroup: CardinalityGroupId,
  outermost = true,
): CaptureValue {
  if (value.kind === "leaf") {
    return createCaptureLeaf({
      id,
      classId: value.classId,
      syntax: value.syntax,
      fields: value.fields,
      origin: value.origin,
    });
  }
  return createCaptureSequence({
    depth: value.depth,
    cardinalityGroup: outermost ? cardinalityGroup : value.cardinalityGroup,
    elements: value.elements.map((element) =>
      remapCaptureValue(element, id, cardinalityGroup, false),
    ),
  });
}

function builtinMatch(
  classId: SyntaxClassId,
  cursor: SyntaxCursor,
  builtins: BuiltinSyntaxClassIds,
): SyntaxClassMatch | undefined {
  const syntax = cursor.peek();
  if (syntax === undefined) return undefined;
  const matches =
    classId === builtins.tt ||
    (classId === builtins.token && syntax.tag === "token") ||
    (classId === builtins.ident &&
      syntax.tag === "token" &&
      isIdentifierToken(syntax));
  if (!matches) return undefined;
  // `>=` is scanned as `>` then `=`. A token is what the author wrote, so a
  // `token` or `tt` capture takes the whole operator; taking `>` alone left
  // the `=` for the rest of the rule, which then failed on it.
  const width =
    classId === builtins.ident
      ? 1
      : Math.max(
          1,
          greaterThanTokenWidth((offset) => cursor.peek(offset)),
        );
  const taken: Syntax[] = [];
  for (let index = 0; index < width; index += 1) taken.push(cursor.consume()!);
  return Object.freeze({
    cursor,
    syntax: createSyntaxSequence(taken),
    origin: syntax.origin,
  });
}

export interface CreateSyntaxClassConsumerOptions extends Omit<
  ExecuteMatcherOptions,
  "consumeClass"
> {
  readonly builtins: BuiltinSyntaxClassIds;
  readonly externalConsumer?: SyntaxClassConsumer | undefined;
}

/** The one description a class's `expect` gives, when it gives one. */
function describeClass(
  syntaxClass: Pick<CompiledSyntaxClass, "rules">,
): string | undefined {
  const descriptions = [
    ...new Set(
      syntaxClass.rules.flatMap(({ failureDescription }) =>
        failureDescription === undefined ? [] : [failureDescription],
      ),
    ),
  ];
  return descriptions.length === 1 ? descriptions[0] : undefined;
}

export function createSyntaxClassConsumer(
  registry: SyntaxClassRegistry,
  options: CreateSyntaxClassConsumerOptions,
): SyntaxClassConsumer {
  const active = new Set<string>();
  const consume: SyntaxClassConsumer = (
    classId,
    cursor,
    boundary,
    onFailure,
  ) => {
    const builtin = builtinMatch(classId, cursor, options.builtins);
    if (builtin !== undefined) return builtin;
    const syntaxClass = registry.get(classId);
    if (syntaxClass === undefined) {
      return options.externalConsumer?.(classId, cursor, boundary, onFailure);
    }
    // A recursive class may revisit its class identity only after input or the
    // lexical environment changes. This is the syntax-class recursion
    // fingerprint; compile-time cycle checks reject paths that can never do so.
    const activeKey = `${String(classId)}:${cursor.identity}:${String(options.environmentEpoch ?? 0)}`;
    if (active.has(activeKey)) return undefined;
    active.add(activeKey);
    const failures: MatchFailure[] = [];
    try {
      for (const rule of syntaxClass.rules) {
        const result = executeMatcher(rule.program, cursor, {
          ...options,
          consumeClass: consume,
        });
        if (!result.matched) {
          if (result.failure !== undefined) failures.push(result.failure);
          continue;
        }
        if (!evaluateRefinements(rule.refinements, result.captures)) continue;
        let fields = CaptureRecord.empty;
        for (const mapping of rule.fieldSources) {
          const value = result.captures.get(mapping.source);
          if (value === undefined) continue;
          fields = fields.set(
            mapping.field,
            remapCaptureValue(
              value,
              mapping.field,
              syntaxClass.fields.find(
                ({ capture }) => capture === mapping.field,
              )?.cardinalityGroup ??
                (mapping.field as unknown as CardinalityGroupId),
            ),
          );
        }
        const start = cursor.index;
        const sequence = cursor.remainingRange().sequence;
        const syntax: readonly Syntax[] = sequence.slice(
          start,
          result.cursor.index,
        );
        return Object.freeze({
          cursor: result.cursor,
          syntax: createSyntaxSequence(syntax),
          fields,
          origin: syntax[0]?.origin ?? syntaxClass.origin,
        });
      }
      const failure = farthestFailure(failures);
      if (failure !== undefined && onFailure !== undefined) {
        const description = describeClass(syntaxClass);
        onFailure(
          description === undefined
            ? failure
            : describeFailureAs(failure, description),
        );
      }
      return undefined;
    } finally {
      active.delete(activeKey);
    }
  };
  return Object.freeze(
    Object.assign(consume, {
      nameOfClass: (classId: SyntaxClassId): string | undefined => {
        // The builtins are matched before the registry is consulted, so they
        // have no entry there to take a name from.
        for (const [name, builtin] of Object.entries(options.builtins))
          if (builtin === classId) return name;
        return (
          registry.get(classId)?.name ??
          options.externalConsumer?.nameOfClass?.(classId)
        );
      },
      describeFailure: (classId: SyntaxClassId): string | undefined => {
        const syntaxClass = registry.get(classId);
        if (syntaxClass === undefined)
          return options.externalConsumer?.describeFailure?.(classId);
        return describeClass(syntaxClass);
      },
    }),
  );
}
