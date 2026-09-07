import type {
  CapturePath,
  CapturePathSegment,
  CaptureShape,
  IdentifierJoinSpec,
} from "@sweetener/pattern";
import type {
  CardinalityGroupId,
  OriginId,
  ScopeSetId,
} from "@sweetener/shared";
import type {
  DelimiterKind,
  MissingToken,
  Syntax,
  TokenSyntax,
  Trivia,
} from "@sweetener/syntax";

export interface TemplateBase {
  readonly origin: OriginId;
}

export interface LiteralTemplate extends TemplateBase {
  readonly kind: "literal";
  readonly syntax: Syntax;
}

export interface CaptureTemplate extends TemplateBase {
  readonly kind: "capture";
  readonly path: CapturePath;
  readonly shape: CaptureShape;
  /**
   * The layout the template author wrote before the placeholder.
   *
   * `[$value, $value]` says the second element is spaced from the comma, and
   * that spacing is written as trivia on the placeholder token -- which
   * substitution then replaces along with it. Keeping it here lets the
   * substituted syntax wear it, so the template's own formatting reaches the
   * expansion instead of being thrown away with the placeholder.
   */
  readonly leadingTrivia: readonly Trivia[];
}

export interface SequenceTemplate extends TemplateBase {
  readonly kind: "sequence";
  readonly elements: readonly TemplateNode[];
}

export interface GroupTemplate extends TemplateBase {
  readonly kind: "group";
  readonly delimiter: DelimiterKind;
  readonly body: SequenceTemplate;
  readonly open: TokenSyntax | undefined;
  readonly close: TokenSyntax | MissingToken | undefined;
  readonly scopes: ScopeSetId | undefined;
}

export interface RepeatTemplate extends TemplateBase {
  readonly kind: "repeat";
  readonly body: SequenceTemplate;
  readonly separator: TemplateNode | undefined;
  readonly depth: number;
  readonly cardinalityGroup: CardinalityGroupId | undefined;
  readonly drivers: readonly CapturePath[];
}

/**
 * A conditional asks whether an optional capture matched.
 *
 * It once also offered `alternative`, which asked which of a pattern's choices
 * a capture took. Nothing on the matching side ever recorded that, so the
 * question was always answered no and the `#else` branch was taken for every
 * input. A syntax class with a rule per shape and an optional field for each
 * answers the same question, and does work, so the predicate that did not is
 * gone rather than kept as a second way to ask.
 */
export type ConditionalPredicate = {
  readonly kind: "present";
  readonly path: CapturePath;
};

export interface ConditionalTemplate extends TemplateBase {
  readonly kind: "conditional";
  readonly predicate: ConditionalPredicate;
  readonly consequent: SequenceTemplate;
  readonly alternate: SequenceTemplate | undefined;
}

export type HygieneOperation =
  | { readonly kind: "fresh"; readonly hint: string }
  | {
      readonly kind: "metavar";
      readonly hint: string;
      readonly path: CapturePath;
    }
  | {
      readonly kind:
        "callsite" | "definition" | "capture" | "text" | "trim" | "count";
      readonly path: CapturePath;
    }
  | {
      readonly kind: "join";
      readonly spec: IdentifierJoinSpec;
    }
  | { readonly kind: "index" };

export interface HygieneOperationTemplate extends TemplateBase {
  readonly kind: "operation";
  readonly operation: HygieneOperation;
  readonly driverShape: CaptureShape | undefined;
  readonly prototype: TokenSyntax | undefined;
}

export type FoldLocal = "accumulator" | "element" | "index";

export interface LocalTemplate extends TemplateBase {
  readonly kind: "local";
  readonly local: FoldLocal;
  readonly fields: readonly CapturePathSegment[];
  /** The layout written before the placeholder, as on a capture. */
  readonly leadingTrivia: readonly Trivia[];
}

export interface FoldTemplate extends TemplateBase {
  readonly kind: "fold";
  readonly driver: CapturePath;
  readonly initial: SequenceTemplate;
  readonly body: SequenceTemplate;
}

export type TemplateNode =
  | LiteralTemplate
  | CaptureTemplate
  | SequenceTemplate
  | GroupTemplate
  | RepeatTemplate
  | ConditionalTemplate
  | HygieneOperationTemplate
  | LocalTemplate
  | FoldTemplate;

function requireFrozen(node: TemplateNode, field: string): void {
  if (!Object.isFrozen(node)) throw new TypeError(`${field} must be immutable`);
}

export function createLiteralTemplate(syntax: Syntax): LiteralTemplate {
  if (!Object.isFrozen(syntax)) {
    throw new TypeError("Literal template syntax must be immutable");
  }
  return Object.freeze({ kind: "literal", origin: syntax.origin, syntax });
}

export function createCaptureTemplate(
  origin: OriginId,
  path: CapturePath,
  shape: CaptureShape,
  leadingTrivia: readonly Trivia[],
): CaptureTemplate {
  if (!Object.isFrozen(path) || !Object.isFrozen(shape)) {
    throw new TypeError("Capture template path and shape must be immutable");
  }
  return Object.freeze({
    kind: "capture",
    origin,
    path,
    shape,
    leadingTrivia: Object.freeze([...leadingTrivia]),
  });
}

export function createSequenceTemplate(
  origin: OriginId,
  elements: readonly TemplateNode[],
): SequenceTemplate {
  for (const element of elements) requireFrozen(element, "Sequence child");
  return Object.freeze({
    kind: "sequence",
    origin,
    elements: Object.freeze([...elements]),
  });
}

export function createGroupTemplate(
  origin: OriginId,
  delimiter: DelimiterKind,
  body: SequenceTemplate,
  open?: TokenSyntax | undefined,
  close?: TokenSyntax | MissingToken | undefined,
  scopes?: ScopeSetId | undefined,
): GroupTemplate {
  requireFrozen(body, "Group body");
  if (open !== undefined && !Object.isFrozen(open)) {
    throw new TypeError("Group open prototype must be immutable");
  }
  if (close !== undefined && !Object.isFrozen(close)) {
    throw new TypeError("Group close prototype must be immutable");
  }
  return Object.freeze({
    kind: "group",
    origin,
    delimiter,
    body,
    open,
    close,
    scopes,
  });
}

export function createRepeatTemplate(options: {
  readonly origin: OriginId;
  readonly body: SequenceTemplate;
  readonly separator?: TemplateNode | undefined;
  readonly depth: number;
  readonly cardinalityGroup?: CardinalityGroupId | undefined;
  readonly drivers: readonly CapturePath[];
}): RepeatTemplate {
  requireFrozen(options.body, "Repetition body");
  if (options.separator !== undefined) {
    requireFrozen(options.separator, "Repetition separator");
  }
  if (!Number.isSafeInteger(options.depth) || options.depth < 1) {
    throw new RangeError("Template repetition depth must be positive");
  }
  for (const driver of options.drivers) {
    if (!Object.isFrozen(driver)) {
      throw new TypeError("Repetition driver paths must be immutable");
    }
  }
  return Object.freeze({
    kind: "repeat",
    origin: options.origin,
    body: options.body,
    separator: options.separator,
    depth: options.depth,
    cardinalityGroup: options.cardinalityGroup,
    drivers: Object.freeze([...options.drivers]),
  });
}

export function createConditionalTemplate(options: {
  readonly origin: OriginId;
  readonly predicate: ConditionalPredicate;
  readonly consequent: SequenceTemplate;
  readonly alternate?: SequenceTemplate | undefined;
}): ConditionalTemplate {
  if (!Object.isFrozen(options.predicate)) {
    throw new TypeError("Conditional predicate must be immutable");
  }
  requireFrozen(options.consequent, "Conditional consequent");
  if (options.alternate !== undefined) {
    requireFrozen(options.alternate, "Conditional alternate");
  }
  return Object.freeze({
    kind: "conditional",
    origin: options.origin,
    predicate: Object.freeze({ ...options.predicate }),
    consequent: options.consequent,
    alternate: options.alternate,
  });
}

export function createHygieneOperationTemplate(
  origin: OriginId,
  operation: HygieneOperation,
  driverShape?: CaptureShape,
  prototype?: TokenSyntax,
): HygieneOperationTemplate {
  if (
    (operation.kind === "fresh" || operation.kind === "metavar") &&
    operation.hint.length === 0
  ) {
    throw new RangeError("Generated identifier hint must not be empty");
  }
  if ("path" in operation && !Object.isFrozen(operation.path)) {
    throw new TypeError("Operation capture path must be immutable");
  }
  if (operation.kind === "join") {
    if (!Object.isFrozen(operation.spec.path))
      throw new TypeError("Identifier join capture path must be immutable");
  }
  if (prototype !== undefined && !Object.isFrozen(prototype))
    throw new TypeError("Operation token prototype must be immutable");
  return Object.freeze({
    kind: "operation",
    origin,
    operation: Object.freeze(
      operation.kind === "join"
        ? {
            ...operation,
            spec: Object.freeze({ ...operation.spec }),
          }
        : { ...operation },
    ),
    driverShape,
    prototype,
  });
}

export function createLocalTemplate(options: {
  readonly origin: OriginId;
  readonly local: FoldLocal;
  readonly fields?: readonly CapturePathSegment[] | undefined;
  readonly leadingTrivia: readonly Trivia[];
}): LocalTemplate {
  const fields = options.fields ?? [];
  if (options.local !== "element" && fields.length > 0) {
    throw new RangeError("Only a fold element local can select fields");
  }
  return Object.freeze({
    kind: "local",
    origin: options.origin,
    local: options.local,
    fields: Object.freeze(fields.map((field) => Object.freeze({ ...field }))),
    leadingTrivia: Object.freeze([...options.leadingTrivia]),
  });
}

export function createFoldTemplate(options: {
  readonly origin: OriginId;
  readonly driver: CapturePath;
  readonly initial: SequenceTemplate;
  readonly body: SequenceTemplate;
}): FoldTemplate {
  if (!Object.isFrozen(options.driver)) {
    throw new TypeError("Fold driver must be immutable");
  }
  requireFrozen(options.initial, "Fold initial template");
  requireFrozen(options.body, "Fold body template");
  return Object.freeze({ kind: "fold", ...options });
}
