import {
  inferCaptureShapes,
  type SyntaxClassRegistry,
} from "@sweetener/pattern";
import type { Diagnostic, OriginId, RuleId, SourceId } from "@sweetener/shared";
import { parseTemplate, type SequenceTemplate } from "@sweetener/template";
import type { Span } from "@sweetener/syntax";
import type { ParseMacroDefinitionsResult } from "./parser/index.js";

export interface CompileParsedTemplatesOptions {
  readonly sourceId: SourceId;
  readonly spanForOrigin: (origin: OriginId) => Span;
  readonly syntaxClasses: SyntaxClassRegistry;
}

export interface CompiledRuleTemplate {
  readonly rule: RuleId;
  readonly template: SequenceTemplate;
}

export interface CompileParsedTemplatesResult {
  readonly templates: readonly CompiledRuleTemplate[];
  readonly diagnostics: readonly Diagnostic[];
}

export function compileParsedTemplates(
  parsed: ParseMacroDefinitionsResult,
  options: CompileParsedTemplatesOptions,
): CompileParsedTemplatesResult {
  const templates: CompiledRuleTemplate[] = [];
  const diagnostics: Diagnostic[] = [];
  const identifierClassIds = parsed.classBindings
    .filter((binding) => binding.name === "ident" || binding.name === "binding")
    .map((binding) => binding.classId);
  const externalClassIds = new Set(
    parsed.classBindings
      .filter((binding) =>
        [
          "token",
          "tt",
          "ident",
          "expr",
          "stmt",
          "item",
          "type",
          "binding",
          "classElement",
          "typeMember",
          "jsxChild",
        ].includes(binding.name),
      )
      .map((binding) => binding.classId),
  );
  for (const definition of parsed.definitions) {
    for (const rule of definition.rules) {
      if (rule.template === undefined) continue;
      const inference = inferCaptureShapes(rule.pattern, {
        sourceId: options.sourceId,
        spanForOrigin: options.spanForOrigin,
        fieldsForClass: (classId) =>
          options.syntaxClasses.shapeForClass(classId),
      });
      diagnostics.push(...inference.diagnostics);
      const compiled = parseTemplate(rule.template, {
        sourceId: options.sourceId,
        spanForOrigin: options.spanForOrigin,
        captures: inference.bindings,
        fieldsForClass: (classId) =>
          externalClassIds.has(classId)
            ? undefined
            : options.syntaxClasses.get(classId)?.fields,
        identifierClassIds,
      });
      diagnostics.push(...compiled.diagnostics);
      // A rule whose template did not compile must not reach invocation-time
      // matching, where evaluating it would fail with no source to blame.
      if (
        [...inference.diagnostics, ...compiled.diagnostics].some(
          ({ severity }) => severity === "error",
        )
      )
        continue;
      templates.push(
        Object.freeze({ rule: rule.id, template: compiled.template }),
      );
    }
  }
  return Object.freeze({
    templates: Object.freeze(templates),
    diagnostics: Object.freeze(diagnostics),
  });
}
