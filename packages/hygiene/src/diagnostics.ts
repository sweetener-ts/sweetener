import { DiagnosticRegistry, diagnosticCode } from "@sweetener/shared";

export const ambiguousBindingCode = diagnosticCode("SWR3001");
export const malformedBindingContractCode = diagnosticCode("SWR3002");
export const invalidBindingPathCode = diagnosticCode("SWR3003");
export const incompatibleBindingAlignmentCode = diagnosticCode("SWR3004");
export const incompatibleBindingSpaceCode = diagnosticCode("SWR3005");
export const followingOutsideLexicalScopeCode = diagnosticCode("SWR3006");
export const operatorFollowingCode = diagnosticCode("SWR3007");

export const hygieneDiagnosticRegistry = new DiagnosticRegistry([
  {
    code: ambiguousBindingCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "Several visible bindings have incomparable maximal scope sets for one identifier.",
    format: (arguments_) =>
      `Identifier ${String(arguments_[0] ?? "unknown")} has ${String(arguments_[1] ?? "multiple")} equally specific bindings.`,
  },
  {
    code: malformedBindingContractCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "Binding contracts use bind <path> in <path|following> as <kind> <space>.",
    format: () => "Malformed declarative binding contract.",
  },
  {
    code: invalidBindingPathCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "Binder and region paths must resolve through declared capture fields.",
    format: (arguments_) =>
      `Invalid binding-contract path ${String(arguments_[0] ?? "unknown")}.`,
  },
  {
    code: incompatibleBindingAlignmentCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "Sequential and element-aligned contracts require compatible repetition dimensions.",
    format: () => "Binding-contract repetitions are not alignable.",
  },
  {
    code: incompatibleBindingSpaceCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "A binding space must be valid for the macro output category.",
    format: (arguments_) =>
      `Binding space ${String(arguments_[0] ?? "unknown")} is invalid for this macro category.`,
  },
  {
    code: followingOutsideLexicalScopeCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "A `following` region is the rest of the block or module an invocation stands in. A class element or type member macro stands in a member list, which binds nothing a later member can see.",
    format: (arguments_) =>
      `A ${String(arguments_[0] ?? "member")} macro cannot bind in following: a member list is not a lexical scope.`,
  },
  {
    code: operatorFollowingCode,
    owner: "hygiene-binding",
    stage: "binding",
    severity: "error",
    documentation:
      "An expression operator is applied while the expression holding it is read, to the operands the parser found around it, and the syntax following that expression is read after it: nothing there can be bound by the operator. A statement operator, which stands in the statements it binds, can.",
    format: (arguments_) =>
      `Operator ${String(arguments_[0] ?? "")} is an expression operator, which cannot bind in following: it is applied while the expression holding it is read. Declare it stmt to bind the statements after it.`,
  },
]);
