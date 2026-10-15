import { DiagnosticRegistry, diagnosticCode } from "@sweetener/shared";

export const unknownTemplateCaptureCode = diagnosticCode("SWR2011");
export const unknownTemplateFieldCode = diagnosticCode("SWR2012");
export const templateCaptureDepthCode = diagnosticCode("SWR2013");
export const missingTemplateDriverCode = diagnosticCode("SWR2014");
export const incompatibleTemplateDriversCode = diagnosticCode("SWR2015");
export const malformedTemplateCode = diagnosticCode("SWR2016");
export const invalidTemplateOperationCode = diagnosticCode("SWR2017");
export const unknownTemplateOperationCode = diagnosticCode("SWR2018");
export const foldAccumulatorCode = diagnosticCode("SWR2020");

export const templateDiagnosticRegistry = new DiagnosticRegistry([
  {
    code: unknownTemplateOperationCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "A `#name(...)` in a template must name a template operation.",
    format: (arguments_) =>
      `Template has no operation #${String(arguments_[0] ?? "unknown")}.`,
  },
  {
    code: unknownTemplateCaptureCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation: "A template capture must be bound by its rule pattern.",
    format: (arguments_) =>
      `Template refers to unknown capture $${String(arguments_[0] ?? "unknown")}.`,
  },
  {
    code: unknownTemplateFieldCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "A template field path must exist in the captured syntax class.",
    format: (arguments_) =>
      `Template capture has no field ${String(arguments_[0] ?? "unknown")}.`,
  },
  {
    code: templateCaptureDepthCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "A repeated capture requires enough enclosing template repetitions.",
    format: (arguments_) =>
      `Capture $${String(arguments_[0] ?? "unknown")} requires template depth ${String(arguments_[1] ?? "unknown")}.`,
  },
  {
    code: missingTemplateDriverCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "Every template repetition needs a capture at its dimension.",
    format: (arguments_) =>
      `Template repetition at depth ${String(arguments_[0] ?? "unknown")} has no driving capture.`,
  },
  {
    code: incompatibleTemplateDriversCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "Captures driving one repetition must share a cardinality group.",
    format: (arguments_) =>
      `Template repetition at depth ${String(arguments_[0] ?? "unknown")} has incompatible driving captures.`,
  },
  {
    code: malformedTemplateCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "Template repetition uses the declarative $(...) separator? form.",
    format: (arguments_) =>
      `Malformed template: ${String(arguments_[0] ?? "invalid syntax")}.`,
  },
  {
    code: foldAccumulatorCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "A `#fold`'s step says what its accumulator is by how it writes `$acc`. Written beside an operator or inside brackets, `$acc` is one operand -- one expression or one type -- and every step and the initial template build exactly one. Written as a part of a list, between the list's separators or beside the parts it runs into, it is the run of parts built so far. A step that writes it both ways, a step or an initial template that builds a list where an operand is needed, and an empty initial template there are reported where they are written.",
    format: (arguments_) =>
      `This #fold ${String(arguments_[0] ?? "uses $acc ambiguously")}.`,
  },
  {
    code: invalidTemplateOperationCode,
    owner: "pattern-definition",
    stage: "macro-definition",
    severity: "error",
    documentation:
      "Declarative template operations accept only their documented fixed argument classes.",
    format: (arguments_) =>
      `Invalid argument for template operation #${String(arguments_[0] ?? "unknown")}.`,
  },
]);
