import type {
  BindingId,
  DeclarationGroupId,
  OriginId,
  ScopeSetId,
} from "@sweetener/shared";

declare const phaseBrand: unique symbol;

export type Phase = number & { readonly [phaseBrand]: "Phase" };

export function createPhase(value: number): Phase {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Phase must be a safe integer");
  }
  return value as Phase;
}

export const runtimePhase = createPhase(0);
export const syntaxPhase = createPhase(1);

export type SyntaxSpace =
  | "value"
  | "type"
  | "namespace"
  | "label"
  | "syntax-item"
  | "syntax-stmt"
  | "syntax-expr"
  | "syntax-type"
  | "syntax-binding"
  | "syntax-class-element"
  | "syntax-type-member"
  | "syntax-jsx-child"
  | "syntax-token"
  | "syntax-tt";

export type BindingKind =
  | "lexical"
  | "parameter"
  | "function"
  | "class"
  | "interface"
  | "type-alias"
  | "namespace"
  | "import"
  | "macro"
  | "operator"
  | "generated";

export type BindingVisibility =
  | { readonly kind: "whole-frame" }
  | { readonly kind: "from"; readonly start: number }
  | { readonly kind: "range"; readonly start: number; readonly end: number };

export interface Binding {
  readonly id: BindingId;
  readonly spelling: string;
  readonly scopes: ScopeSetId;
  readonly phase: Phase;
  readonly space: SyntaxSpace;
  readonly declaration: OriginId;
  readonly kind: BindingKind;
  readonly declarationGroup: DeclarationGroupId | undefined;
  readonly visibility: BindingVisibility;
}

function validatePosition(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

export function createBindingVisibility(
  visibility: BindingVisibility,
): BindingVisibility {
  if (visibility.kind === "from") {
    validatePosition(visibility.start, "Visibility start");
  } else if (visibility.kind === "range") {
    validatePosition(visibility.start, "Visibility start");
    validatePosition(visibility.end, "Visibility end");
    if (visibility.end < visibility.start) {
      throw new RangeError("Visibility end must not precede its start");
    }
  }
  return Object.freeze({ ...visibility });
}

export function bindingVisibleAt(binding: Binding, position: number): boolean {
  validatePosition(position, "Visibility query position");
  const visibility = binding.visibility;
  switch (visibility.kind) {
    case "whole-frame":
      return true;
    case "from":
      return position >= visibility.start;
    case "range":
      return position >= visibility.start && position < visibility.end;
  }
}

export function createBinding(options: {
  readonly id: BindingId;
  readonly spelling: string;
  readonly scopes: ScopeSetId;
  readonly phase: Phase;
  readonly space: SyntaxSpace;
  readonly declaration: OriginId;
  readonly kind: BindingKind;
  readonly declarationGroup?: DeclarationGroupId | undefined;
  readonly visibility?: BindingVisibility | undefined;
}): Binding {
  if (options.spelling.length === 0 || /[\r\n]/u.test(options.spelling)) {
    throw new RangeError(
      "Binding spelling must be nonempty and fit on one line",
    );
  }
  return Object.freeze({
    ...options,
    declarationGroup: options.declarationGroup,
    visibility: createBindingVisibility(
      options.visibility ?? { kind: "whole-frame" },
    ),
  });
}
