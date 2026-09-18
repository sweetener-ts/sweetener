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
export const wrongCategoryMacroCode = diagnosticCode("SWR4013");
export const expansionCycleCode = diagnosticCode("SWR4014");
export const expansionLimitCode = diagnosticCode("SWR4015");
export const unprocessedDefinitionCode = diagnosticCode("SWR4016");
export const macroNotYetVisibleCode = diagnosticCode("SWR4017");
export const unparameterizedSyntaxParameterCode = diagnosticCode("SWR4018");
export const notSyntaxParameterCode = diagnosticCode("SWR4019");
export const unreadableSyntaxCode = diagnosticCode("SWR4020");
export const unexpandedOperatorCode = diagnosticCode("SWR4021");
export const unusedRequiredParameterCode = diagnosticCode("SWR4022");
export const uncopiableClosureCode = diagnosticCode("SWR4023");
export const bareMacroNameCode = diagnosticCode("SWR4024");
export const unreadItemCode = diagnosticCode("SWR4025");

/**
 * The indefinite article for a space's name. The spaces a macro can be
 * declared for include `expr` and `item`, and "a expr is read" is not a
 * sentence.
 */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export const expansionDiagnosticRegistry = new DiagnosticRegistry([
  {
    code: unparameterizedSyntaxParameterCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A syntax parameter declared without rules means something only inside a `#parameterize` that names it. Written anywhere else it has no expansion, and passing it through would leave macro syntax in the emitted TypeScript.",
    format: (arguments_) =>
      `Syntax parameter ${String(arguments_[0] ?? "unknown")} is used outside any #parameterize that gives it a meaning. It is declared without rules, so it means nothing here.`,
  },
  {
    code: uncopiableClosureCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A `#let` whose body waits, with `await` or `yield`, keeps its value in a variable of the enclosing function, and each function in the body that reads it takes a copy when it is created. A method or accessor cannot be taken out of its object literal to be given one, so the object literal is -- which it cannot be when the literal itself waits, since the wait would move into a function of its own.",
    format: () =>
      "This object literal waits, with `await` or `yield`, and has a method that reads a value a macro evaluated once for it. The method cannot be given its own copy of that value; move the `await` or `yield` out of the object literal.",
  },
  {
    code: unusedRequiredParameterCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "`#parameterize(required name = replacement) { body }` gives a syntax parameter a meaning that the body is expected to use -- the topic of a Hack pipe, which a pipe body must mention. A body that never uses it almost always lost the placeholder by mistake, so it is reported rather than expanded with the replacement unused.",
    format: (arguments_) =>
      `This must use ${String(arguments_[0] ?? "unknown")}, and does not. The macro gives ${String(arguments_[0] ?? "unknown")} a meaning here only for syntax that uses it.`,
  },
  {
    code: notSyntaxParameterCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "`#parameterize` adjusts a syntax parameter, which is declared with `syntax parameter`. Naming an ordinary macro, or a name no macro in scope has, would silently change nothing.",
    format: (arguments_) =>
      `#parameterize names ${String(arguments_[0] ?? "unknown")}, which is not a syntax parameter in scope here. Declare it with \`syntax parameter\`, and import it for syntax where the template is defined.`,
  },
  {
    code: unreadableSyntaxCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Syntax the enforester has to read before it can expand what is inside -- a template literal's substitution, a group holding a custom operator -- is reported where it could not be read, rather than thrown past every caller.",
    format: (arguments_) =>
      `Sweetener could not read this as ${String(arguments_[0] ?? "syntax")}: ${String(arguments_[1] ?? "")}`,
  },
  {
    code: unexpandedOperatorCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A custom operator is expanded while the expression around it is read. When that expression cannot be read, the operator's rules are never tried, and its spelling -- which TypeScript does not have -- would reach the emitted code.",
    format: (arguments_) =>
      `Operator ${String(arguments_[0] ?? "unknown")} was left unexpanded: the expression it is written in could not be read, so none of its rules were tried.`,
  },
  {
    code: expansionCycleCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A macro whose expansion reaches the same state again would expand forever. The cycle is reported against the invocation that began it, because the macro itself is usually correct and the input is what does not reduce.",
    format: (arguments_) =>
      `Macro ${String(arguments_[0] ?? "unknown")} expanded to itself and would not terminate. A rule has to reduce its input, so one of them must match without reaching this macro again.`,
  },
  {
    code: macroNotYetVisibleCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A macro is visible to what follows its definition, the way a `const` is. A name used above its definition is therefore not a macro there, and the invocation would be emitted as a call to a name the output does not define.",
    format: (arguments_) =>
      `Macro ${String(arguments_[0] ?? "unknown")} is defined below this point, and a macro is visible only to what follows its definition. Move the definition above this use, or into a module imported for syntax.`,
  },
  {
    code: unprocessedDefinitionCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Definition contexts are read at module level. A definition written inside a block is not processed, and passing it through would leave macro-language syntax in the emitted TypeScript for the host compiler to reject.",
    format: (arguments_) =>
      `Macro definitions are read at module level, so ${String(arguments_[0] ?? "this definition")} written inside a block was not processed. Move it to a module and import it for syntax.`,
  },
  {
    code: expansionLimitCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "Expansion is bounded so that a macro cannot consume the build. Reaching a bound is reported where it was reached rather than thrown, so the file and the macro are named.",
    format: (arguments_) =>
      `Expanding ${String(arguments_[0] ?? "this file")} reached the ${String(arguments_[1] ?? "expansion")} limit. No further macros in it were expanded.`,
  },
  {
    code: wrongCategoryMacroCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A macro is dispatched only in the category it declares. A name written where another category is read is left alone and emitted verbatim, so the mismatch is said in these words rather than in whatever TypeScript makes of the leftover name. Written where TypeScript reports the name is one it cannot find, or a member it cannot type, and nowhere else: which names a program declares is TypeScript's to answer, since `lib.d.ts`, an ambient declaration and a `declare global` all declare names expansion cannot see, and a member list names members of its own. A macro spelled like one of those is an ordinary name there, and saying otherwise refused valid TypeScript.",
    format: (arguments_) =>
      `Macro ${String(arguments_[0] ?? "unknown")} is declared ${String(arguments_[1] ?? "unknown")} and cannot be written where ${article(String(arguments_[2] ?? "node"))} ${String(arguments_[2] ?? "node")} is read. Declare it ${String(arguments_[2] ?? "unknown")} to use it here.`,
  },
  {
    code: unreadItemCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "warning",
    documentation:
      "An item the enforester cannot read is recovered as written and expansion carries on, which is how syntax the reader is not meant to read -- a macro written after its first operand, an operator in an initializer -- reaches the expander at all. It is also how a declaration the reader disagrees with TypeScript about passes through: the item's structure is lost, and nothing said so. Reported where the run begins at a word that begins a declaration and nothing else, where expansion went on to rewrite nothing in it, and where no other diagnostic speaks about it -- so a recovery that did its job, or one another diagnostic already describes, stays quiet. A warning rather than an error: the item is usually valid TypeScript that the reader does not yet handle, and passing it through is only wrong when something in it needed expanding, which `SWR4012` reports for itself.",
    format: (arguments_) =>
      `Sweetener could not read this item, so it was passed through as written and no macro in it was expanded. Its reader expected ${String(arguments_[0] ?? "something else")}. TypeScript may well accept the item as written -- a reader that cannot read it is a gap in Sweetener rather than a mistake here.`,
  },
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
    code: bareMacroNameCode,
    owner: "expansion-enforestation",
    stage: "expansion",
    severity: "error",
    documentation:
      "A macro name stands for the rules that expand where it is written, not for anything the emitted code defines. Written on its own, with nothing after it for any rule to match, it is a reference to a name that its compile-time import does not leave behind -- which is what is wrong, rather than that the closest rule wanted different syntax there.",
    format: (arguments_) =>
      `Macro ${String(arguments_[0] ?? "unknown")} is written here as a name on its own, where ${article(String(arguments_[1] ?? "node"))} ${String(arguments_[1] ?? "node")} is read. A macro is a compile-time name, so nothing defines ${String(arguments_[0] ?? "unknown")} in the emitted code. Write an invocation its rules accept.`,
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
