import { DiagnosticRegistry, diagnosticCode } from "@sweetener/shared";

export const noMatchingMacroRuleCode = diagnosticCode("SWR4001");
export const invalidCoreShadowCode = diagnosticCode("SWR4002");
export const unauthorizedCoreShadowImportCode = diagnosticCode("SWR4003");
export const ambiguousSyntaxDispatchCode = diagnosticCode("SWR4004");
export const malformedGeneratedDefinitionCode = diagnosticCode("SWR4005");
export const invalidOperatorConfigurationCode = diagnosticCode("SWR4006");
export const conflictingOperatorImportCode = diagnosticCode("SWR4007");
export const invalidMacroContextCode = diagnosticCode("SWR4008");
export const unresolvedBindingLiteralCode = diagnosticCode("SWR4009");
export const duplicateMacroDefinitionCode = diagnosticCode("SWR4010");
export const uncategorizedExpansionCode = diagnosticCode("SWR4011");
export const unreadableItemCode = diagnosticCode("SWR4012");

export const expansionDiagnosticRegistry = new DiagnosticRegistry([
  {
    code: unreadableItemCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Syntax the enforester cannot read is passed through untouched, which is only safe while it invokes no macro. Passing an invocation through would emit a call to a name that expansion removes.",
    format: (arguments_) =>
      `Sweetener could not read this item, so ${String(arguments_[0] ?? "a macro")} in it was left unexpanded. Its compile-time import does not survive into the output, so the emitted code would call a name that does not exist.`,
  },
  {
    code: uncategorizedExpansionCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A macro's expansion must read as one node of the category the macro declares.",
    format: (arguments_) =>
      `Macro ${String(arguments_[0] ?? "unknown")} expanded to syntax that is not one ${String(arguments_[1] ?? "node")}: ${String(arguments_[2] ?? "")}`,
  },
  {
    code: duplicateMacroDefinitionCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "One module may define a macro name only once, and may export it for only one syntax category.",
    format: (arguments_) =>
      `Macro ${String(arguments_[0] ?? "unknown")} is already defined in this module: ${String(arguments_[1] ?? "a second definition")}.`,
  },
  {
    code: noMatchingMacroRuleCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "No source-ordered macro rule matched and passed the surrounding consumer boundary.",
    format: (arguments_) =>
      `No rule for macro ${String(arguments_[0] ?? "unknown")} accepted this input: ${String(arguments_[1] ?? "no matching syntax")}.`,
  },
  {
    code: invalidCoreShadowCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A shadows-core clause may name only a pinned core form in the declared syntax category.",
    format: (arguments_) =>
      `Syntax ${String(arguments_[0] ?? "unknown")} cannot shadow a core ${String(arguments_[1] ?? "unknown")} form.`,
  },
  {
    code: unauthorizedCoreShadowImportCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "An import may opt into core interception only when the exported definition also declares shadows core.",
    format: (arguments_) =>
      `Import requests core shadowing for ${String(arguments_[0] ?? "unknown")}, but its definition does not authorize interception.`,
  },
  {
    code: ambiguousSyntaxDispatchCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Lexical syntax dispatch requires one unambiguous binding at the nearest scope.",
    format: (arguments_) =>
      `Syntax dispatch for ${String(arguments_[0] ?? "unknown")} is ambiguous between ${String(arguments_[1] ?? 0)} bindings.`,
  },
  {
    code: malformedGeneratedDefinitionCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Generated definitions must use one #syntax marker followed by a brace-delimited declarative definition context.",
    format: () =>
      "Generated macro output must have the form #syntax { declarative definitions }.",
  },
  {
    code: invalidOperatorConfigurationCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Operator fixity, associativity, and precedence must form a complete valid declaration.",
    format: (arguments_) =>
      `Invalid operator ${String(arguments_[0] ?? "unknown")}: ${String(arguments_[1] ?? "invalid configuration")}.`,
  },
  {
    code: conflictingOperatorImportCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "One lexical frame cannot import multiple operators with the same spelling, category, phase, and fixity.",
    format: (arguments_) =>
      `Imported ${String(arguments_[1] ?? "unknown")} operator ${String(arguments_[0] ?? "unknown")} conflicts with an existing local operator.`,
  },
  {
    code: invalidMacroContextCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Context clauses name a fixed compiler-recognized syntactic context.",
    format: (arguments_) =>
      `Unknown macro context ${String(arguments_[0] ?? "unknown")}.`,
  },
  {
    code: unresolvedBindingLiteralCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A declared binding literal must resolve to one TypeScript symbol during definition compilation.",
    format: (arguments_) =>
      `Binding literal ${String(arguments_[0] ?? "unknown")} cannot resolve ${String(arguments_[1] ?? "unknown")}.`,
  },
]);
