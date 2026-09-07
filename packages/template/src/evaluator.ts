import {
  joinedIdentifierText,
  type CaptureLeaf,
  type CapturePath,
  type CaptureRecord,
  type CaptureValue,
} from "@sweetener/pattern";
import {
  createResourceBudget,
  neverCancelled,
  ResourceTracker,
  type CancellationToken,
  type CaptureId,
  type OriginId,
  type ResourceBudget,
  type ScopeSetId,
} from "@sweetener/shared";
import type {
  DelimiterKind,
  MissingToken,
  SyntaxSequence,
  TokenSyntax,
  Trivia,
} from "@sweetener/syntax";
import type {
  ConditionalPredicate,
  HygieneOperation,
  SequenceTemplate,
  TemplateNode,
} from "./ast.js";

export interface EvaluatedSyntax {
  readonly kind: "syntax";
  readonly origin: OriginId;
  readonly syntax: SyntaxSequence;
  readonly source: "template" | "capture";
  readonly capture: CaptureId | undefined;
  /**
   * The layout the template wrote before the placeholder this replaced, which
   * the substituted syntax wears when it brought none of its own.
   */
  readonly templateLeadingTrivia: readonly Trivia[];
}

export interface EvaluatedGroup {
  readonly kind: "group";
  readonly origin: OriginId;
  readonly delimiter: DelimiterKind;
  readonly body: readonly EvaluatedTemplate[];
  readonly open: TokenSyntax | undefined;
  readonly close: TokenSyntax | MissingToken | undefined;
  readonly scopes: ScopeSetId | undefined;
}

export type EvaluatedOperation =
  | {
      readonly kind: "operation";
      readonly origin: OriginId;
      readonly operation: "fresh";
      readonly hint: string;
      readonly ordinal: number;
      readonly prototype?: TokenSyntax | undefined;
    }
  | {
      readonly kind: "operation";
      readonly origin: OriginId;
      readonly operation: "metavar";
      readonly hint: string;
      readonly indices: readonly number[];
      readonly prototype?: TokenSyntax | undefined;
    }
  | {
      readonly kind: "operation";
      readonly origin: OriginId;
      readonly operation: "callsite" | "definition" | "capture" | "trim";
      readonly syntax: SyntaxSequence;
      readonly capture: CaptureId;
    }
  | {
      readonly kind: "operation";
      readonly origin: OriginId;
      readonly operation: "text";
      readonly text: string;
      readonly prototype?: TokenSyntax | undefined;
    }
  | {
      readonly kind: "operation";
      readonly origin: OriginId;
      readonly operation: "join";
      readonly text: string;
      readonly capture: CaptureId;
      readonly scopes: ScopeSetId;
      readonly prototype?: TokenSyntax | undefined;
      readonly sourceOrigin: OriginId;
    }
  | {
      readonly kind: "operation";
      readonly origin: OriginId;
      readonly operation: "index" | "count";
      readonly value: number;
      readonly prototype?: TokenSyntax | undefined;
    };

export type EvaluatedTemplate =
  EvaluatedSyntax | EvaluatedGroup | EvaluatedOperation;

export interface TemplateOperationTrace {
  readonly operation: HygieneOperation["kind"];
  readonly origin: OriginId;
  readonly capture: CaptureId | undefined;
  readonly repetitionIndices: readonly number[];
  readonly detail: string | number | undefined;
}

export interface EvaluateTemplateOptions {
  readonly captures: CaptureRecord;
  readonly budget?: Partial<ResourceBudget> | undefined;
  readonly tracker?: ResourceTracker | undefined;
  readonly cancellation?: CancellationToken | undefined;
}

export interface EvaluateTemplateResult {
  readonly output: readonly EvaluatedTemplate[];
  readonly templateSteps: number;
  readonly trace: readonly TemplateOperationTrace[];
}

export class TemplateCardinalityError extends Error {
  override readonly name = "TemplateCardinalityError";

  constructor(
    readonly depth: number,
    readonly lengths: readonly number[],
  ) {
    super(
      `Template repetition at depth ${String(depth)} has cardinalities ${lengths.join(", ")}`,
    );
  }
}

export class TemplateCaptureError extends Error {
  override readonly name = "TemplateCaptureError";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolves a path without failing when it is not there. An optional pattern
 * that matched nothing records no capture at all, and asking whether it is
 * present is exactly what `#if(present ...)` is for, so that question must have
 * an answer rather than an error.
 */
function tryResolvePath(
  captures: CaptureRecord,
  path: CapturePath,
  indices: readonly number[],
): CaptureValue | undefined {
  const initial = captures.get(path.root);
  if (initial === undefined) return undefined;
  let value: CaptureValue = initial;
  let fieldIndex = 0;
  let dimension = 0;
  while (true) {
    if (value.kind === "sequence") {
      if (dimension >= indices.length) return value;
      const selected = value.elements[indices[dimension]!];
      if (selected === undefined) return undefined;
      value = selected;
      dimension += 1;
      continue;
    }
    const field = path.fields[fieldIndex];
    if (field === undefined) return value;
    const selected = value.fields.get(field.capture);
    if (selected === undefined) return undefined;
    value = selected;
    fieldIndex += 1;
  }
}

function resolvePath(
  captures: CaptureRecord,
  path: CapturePath,
  indices: readonly number[],
): CaptureValue {
  const initial = captures.get(path.root);
  if (initial === undefined) {
    throw new TemplateCaptureError(`Missing capture $${path.rootName}`);
  }
  let value: CaptureValue = initial;
  let fieldIndex = 0;
  let dimension = 0;
  while (true) {
    if (value.kind === "sequence") {
      if (dimension >= indices.length) return value;
      const index = indices[dimension]!;
      const selected = value.elements[index];
      if (selected === undefined) {
        throw new TemplateCaptureError(
          `Capture $${path.rootName} has no element ${String(index)} at dimension ${String(dimension + 1)}`,
        );
      }
      value = selected;
      dimension += 1;
      continue;
    }
    const field = path.fields[fieldIndex];
    if (field === undefined) return value;
    const selected = value.fields.get(field.capture);
    if (selected === undefined) {
      throw new TemplateCaptureError(
        `Capture $${path.rootName} has no field ${field.name}`,
      );
    }
    value = selected;
    fieldIndex += 1;
  }
}

function finalCaptureId(path: CapturePath): CaptureId {
  return path.fields.at(-1)?.capture ?? path.root;
}

function isPresent(value: CaptureValue): boolean {
  return value.kind === "leaf" || value.elements.length > 0;
}

function selectFields(
  initial: CaptureValue,
  fields: readonly { readonly capture: CaptureId; readonly name: string }[],
  label: string,
): CaptureValue {
  let value = initial;
  for (const field of fields) {
    if (value.kind !== "leaf") {
      throw new TemplateCaptureError(
        `${label} requires an element before field ${field.name}`,
      );
    }
    const selected = value.fields.get(field.capture);
    if (selected === undefined) {
      throw new TemplateCaptureError(`${label} has no field ${field.name}`);
    }
    value = selected;
  }
  return value;
}

function stableSyntaxText(syntax: SyntaxSequence): string {
  type Item = SyntaxSequence[number] | string;
  const pending: Item[] = [...syntax].reverse();
  const chunks: string[] = [];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (typeof item === "string") {
      chunks.push(item);
      continue;
    }
    if (item.tag === "token") {
      for (let index = item.trailingTrivia.length - 1; index >= 0; index -= 1) {
        pending.push(item.trailingTrivia[index]!.raw);
      }
      pending.push(item.raw);
      for (let index = item.leadingTrivia.length - 1; index >= 0; index -= 1) {
        pending.push(item.leadingTrivia[index]!.raw);
      }
    } else if (item.tag === "group") {
      if (item.close.tag === "token") pending.push(item.close);
      pending.push(...[...item.children].reverse());
      pending.push(item.open);
    } else {
      pending.push(...[...item.children].reverse());
    }
  }
  // Captures retain call-site trivia so ordinary substitution can stay
  // lossless. Text conversion is a semantic operation, however: indentation
  // before or after the captured form must not become part of a generated
  // identifier, tag, or property name. Preserve internal trivia and normalize
  // only the capture boundary.
  return chunks.join("").trim();
}

interface FoldLocals {
  readonly accumulator: readonly EvaluatedTemplate[];
  readonly element: CaptureValue;
  readonly index: number;
}

class Evaluator {
  readonly #captures: CaptureRecord;
  readonly #tracker: ResourceTracker;
  readonly #cancellation: CancellationToken;
  readonly #trace: TemplateOperationTrace[] = [];
  #freshOrdinal = 0;

  constructor(options: EvaluateTemplateOptions) {
    this.#captures = options.captures;
    this.#tracker =
      options.tracker ??
      new ResourceTracker(createResourceBudget(options.budget ?? {}));
    this.#cancellation = options.cancellation ?? neverCancelled;
  }

  evaluate(template: SequenceTemplate): EvaluateTemplateResult {
    const output = this.#sequence(template, [], undefined);
    return Object.freeze({
      output: Object.freeze(output),
      templateSteps: this.#tracker.usage.templateSteps,
      trace: Object.freeze([...this.#trace]),
    });
  }

  #sequence(
    template: SequenceTemplate,
    indices: readonly number[],
    locals: FoldLocals | undefined,
  ): EvaluatedTemplate[] {
    this.#step();
    const output: EvaluatedTemplate[] = [];
    for (const node of template.elements) {
      output.push(...this.#node(node, indices, locals));
    }
    return output;
  }

  #node(
    node: TemplateNode,
    indices: readonly number[],
    locals: FoldLocals | undefined,
  ): EvaluatedTemplate[] {
    this.#step();
    switch (node.kind) {
      case "literal":
        return [
          Object.freeze({
            kind: "syntax",
            origin: node.origin,
            syntax: Object.freeze([node.syntax]),
            source: "template",
            capture: undefined,
            // A literal is the template's own token, trivia included; nothing
            // was substituted for it, so there is no placeholder layout to
            // hand on.
            templateLeadingTrivia: Object.freeze([]),
          }),
        ];
      case "capture": {
        const value = resolvePath(this.#captures, node.path, indices);
        if (value.kind !== "leaf") {
          throw new TemplateCaptureError(
            `Capture $${node.path.rootName} still has ${String(value.depth)} unselected dimensions`,
          );
        }
        return [this.#capture(value, node.leadingTrivia)];
      }
      case "sequence":
        return this.#sequence(node, indices, locals);
      case "group":
        return this.#nested(() => [
          Object.freeze({
            kind: "group",
            origin: node.origin,
            delimiter: node.delimiter,
            body: Object.freeze(this.#sequence(node.body, indices, locals)),
            open: node.open,
            close: node.close,
            scopes: node.scopes,
          }),
        ]);
      case "repeat":
        return this.#nested(() => {
          const sequences = node.drivers.map((path) => {
            const value = resolvePath(this.#captures, path, indices);
            if (value.kind !== "sequence") {
              throw new TemplateCaptureError(
                `Repetition driver $${path.rootName} is not a sequence`,
              );
            }
            if (
              node.cardinalityGroup !== undefined &&
              value.cardinalityGroup !== node.cardinalityGroup
            ) {
              throw new TemplateCardinalityError(node.depth, [
                value.elements.length,
              ]);
            }
            return value;
          });
          const lengths = sequences.map((sequence) => sequence.elements.length);
          const length = lengths[0] ?? 0;
          if (lengths.some((candidate) => candidate !== length)) {
            throw new TemplateCardinalityError(node.depth, lengths);
          }
          const output: EvaluatedTemplate[] = [];
          for (let index = 0; index < length; index += 1) {
            this.#step();
            if (index > 0 && node.separator !== undefined) {
              output.push(...this.#node(node.separator, indices, locals));
            }
            output.push(
              ...this.#sequence(node.body, [...indices, index], locals),
            );
          }
          return output;
        });
      case "conditional": {
        const branch = this.#predicate(node.predicate, indices)
          ? node.consequent
          : node.alternate;
        return branch === undefined
          ? []
          : this.#nested(() => this.#sequence(branch, indices, locals));
      }
      case "operation":
        return [
          this.#operation(node.origin, node.operation, indices, node.prototype),
        ];
      case "local": {
        if (locals === undefined) {
          throw new TemplateCaptureError(
            `Fold local $${node.local} used outside a fold`,
          );
        }
        if (node.local === "accumulator") {
          return [...locals.accumulator];
        }
        if (node.local === "index") {
          return [
            this.#indexOperation(node.origin, locals.index, indices, undefined),
          ];
        }
        const value = selectFields(locals.element, node.fields, "Fold element");
        if (value.kind !== "leaf") {
          throw new TemplateCaptureError(
            "Fold element still has unselected dimensions",
          );
        }
        return [this.#capture(value, node.leadingTrivia)];
      }
      case "fold":
        return this.#nested(() => {
          const driver = resolvePath(this.#captures, node.driver, indices);
          if (driver.kind !== "sequence") {
            throw new TemplateCaptureError(
              `Fold driver $${node.driver.rootName} is not a sequence`,
            );
          }
          let accumulator: readonly EvaluatedTemplate[] = this.#sequence(
            node.initial,
            indices,
            locals,
          );
          for (let index = 0; index < driver.elements.length; index += 1) {
            this.#step();
            accumulator = this.#sequence(node.body, indices, {
              accumulator,
              element: driver.elements[index]!,
              index,
            });
          }
          return [...accumulator];
        });
    }
  }

  #operation(
    origin: OriginId,
    operation: HygieneOperation,
    indices: readonly number[],
    prototype: TokenSyntax | undefined,
  ): EvaluatedOperation {
    if (operation.kind === "fresh") {
      const ordinal = this.#freshOrdinal;
      this.#freshOrdinal += 1;
      this.#record(operation.kind, origin, undefined, indices, operation.hint);
      return Object.freeze({
        kind: "operation",
        origin,
        operation: "fresh",
        hint: operation.hint,
        ordinal,
        prototype,
      });
    }
    if (operation.kind === "metavar") {
      // Outside a repetition there are no indices to distinguish elements, and
      // none are needed: the name is already unique within the definition the
      // template generates.
      const value = resolvePath(this.#captures, operation.path, indices);
      if (value.kind !== "leaf") {
        throw new TemplateCaptureError(
          "#metavar driver did not select one repetition element",
        );
      }
      this.#record(
        operation.kind,
        origin,
        finalCaptureId(operation.path),
        indices,
        operation.hint,
      );
      return Object.freeze({
        kind: "operation",
        origin,
        operation: "metavar",
        hint: operation.hint,
        indices: Object.freeze([...indices]),
        prototype,
      });
    }
    if (operation.kind === "index") {
      const value = indices.at(-1);
      if (value === undefined) {
        throw new TemplateCaptureError("#index used outside repetition");
      }
      return this.#indexOperation(origin, value, indices, prototype);
    }
    if (operation.kind === "join") {
      const value = resolvePath(this.#captures, operation.spec.path, indices);
      if (value.kind !== "leaf")
        throw new TemplateCaptureError("#join requires one identifier capture");
      const first = value.syntax[0];
      if (first === undefined)
        throw new TemplateCaptureError(
          "#join requires a nonempty identifier capture",
        );
      const text = joinedIdentifierText(
        operation.spec,
        stableSyntaxText(value.syntax),
      );
      const capture = finalCaptureId(operation.spec.path);
      this.#record(operation.kind, origin, capture, indices, text);
      return Object.freeze({
        kind: "operation",
        origin,
        operation: "join",
        text,
        capture,
        scopes: first.scopes,
        prototype,
        sourceOrigin: value.origin,
      });
    }
    const value = resolvePath(this.#captures, operation.path, indices);
    if (operation.kind === "count") {
      const count = (capture: CaptureValue): number =>
        capture.kind === "leaf"
          ? 1
          : capture.elements.reduce(
              (total, element) => total + count(element),
              0,
            );
      const result = count(value);
      const capture = finalCaptureId(operation.path);
      this.#record(operation.kind, origin, capture, indices, result);
      return Object.freeze({
        kind: "operation",
        origin,
        operation: "count",
        value: result,
        prototype,
      });
    }
    if (value.kind !== "leaf") {
      throw new TemplateCaptureError(
        `Operation #${operation.kind} requires one syntax value`,
      );
    }
    const capture = finalCaptureId(operation.path);
    if (operation.kind === "text") {
      const text = stableSyntaxText(value.syntax);
      this.#record(operation.kind, origin, capture, indices, text);
      return Object.freeze({
        kind: "operation",
        origin,
        operation: operation.kind,
        text,
        prototype,
      });
    }
    this.#record(operation.kind, origin, capture, indices, undefined);
    return Object.freeze({
      kind: "operation",
      origin,
      operation: operation.kind,
      syntax: value.syntax,
      capture,
    });
  }

  #indexOperation(
    origin: OriginId,
    value: number,
    indices: readonly number[],
    prototype: TokenSyntax | undefined,
  ): EvaluatedOperation {
    this.#record("index", origin, undefined, indices, value);
    return Object.freeze({
      kind: "operation",
      origin,
      operation: "index",
      value,
      prototype,
    });
  }

  #record(
    operation: HygieneOperation["kind"],
    origin: OriginId,
    capture: CaptureId | undefined,
    indices: readonly number[],
    detail: string | number | undefined,
  ): void {
    this.#trace.push(
      Object.freeze({
        operation,
        origin,
        capture,
        repetitionIndices: Object.freeze([...indices]),
        detail,
      }),
    );
  }

  #predicate(
    predicate: ConditionalPredicate,
    indices: readonly number[],
  ): boolean {
    const optional = tryResolvePath(this.#captures, predicate.path, indices);
    return optional !== undefined && isPresent(optional);
  }

  #capture(
    value: CaptureLeaf,
    templateLeadingTrivia: readonly Trivia[],
  ): EvaluatedSyntax {
    return Object.freeze({
      kind: "syntax",
      origin: value.origin,
      syntax: value.syntax,
      source: "capture",
      capture: value.id,
      templateLeadingTrivia,
    });
  }

  #nested<T>(operation: () => T): T {
    this.#tracker.enterNesting();
    try {
      return operation();
    } finally {
      this.#tracker.leaveNesting();
    }
  }

  #step(): void {
    this.#cancellation.throwIfCancellationRequested();
    this.#tracker.chargeTemplateSteps();
  }
}

export function evaluateTemplate(
  template: SequenceTemplate,
  options: EvaluateTemplateOptions,
): EvaluateTemplateResult {
  return new Evaluator(options).evaluate(template);
}
