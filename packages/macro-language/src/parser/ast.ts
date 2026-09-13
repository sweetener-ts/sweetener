import type {
  CaptureId,
  DefinitionId,
  OriginId,
  RuleId,
  SyntaxClassId,
} from "@sweetener/shared";
import type { PatternNode } from "@sweetener/pattern";
import type {
  GroupSyntax,
  Syntax,
  SyntaxCategory,
  SyntaxSequence,
} from "@sweetener/syntax";

export interface MacroLanguageNode {
  readonly origin: OriginId;
}

export interface DefinitionField extends MacroLanguageNode {
  readonly capture: CaptureId;
  readonly name: string;
  readonly classId: SyntaxClassId;
  readonly className: string;
  readonly repeated: boolean;
  readonly optional: boolean;
  readonly syntax: SyntaxSequence;
}

export interface DefinitionClause extends MacroLanguageNode {
  readonly kind:
    "binding" | "refinement" | "property" | "diagnostic" | "unknown";
  readonly keyword: string;
  readonly syntax: SyntaxSequence;
}

export interface MacroRule extends MacroLanguageNode {
  readonly id: RuleId;
  readonly fallback: boolean;
  readonly patternGroup: GroupSyntax;
  readonly pattern: PatternNode;
  readonly clauses: readonly DefinitionClause[];
  readonly template: GroupSyntax | undefined;
}

export interface SyntaxDefinition extends MacroLanguageNode {
  readonly kind: "syntax";
  readonly id: DefinitionId;
  readonly exported: boolean;
  readonly recursive: boolean;
  /**
   * Whether this is a syntax parameter: a macro binding whose meaning a
   * template can adjust, with `#parameterize`, for the syntax it wraps. Its
   * rules, if it has any, say what it means where no parameterization is in
   * effect.
   */
  readonly parameter: boolean;
  readonly name: string;
  readonly category: SyntaxCategory;
  readonly shadowsCore: boolean;
  readonly rules: readonly MacroRule[];
  readonly clauses: readonly DefinitionClause[];
  /** Absent only for a syntax parameter declared without rules. */
  readonly body: GroupSyntax | undefined;
  /** The last node of the definition: its body, or what ends a bodiless one. */
  readonly end: Syntax;
}

export interface SyntaxClassDefinition extends MacroLanguageNode {
  readonly kind: "syntax-class";
  readonly id: DefinitionId;
  readonly classId: SyntaxClassId;
  readonly exported: boolean;
  readonly recursive: boolean;
  readonly name: string;
  readonly fields: readonly DefinitionField[];
  readonly rules: readonly MacroRule[];
  readonly clauses: readonly DefinitionClause[];
  readonly body: GroupSyntax;
}

export interface OperatorDefinition extends MacroLanguageNode {
  readonly kind: "operator";
  readonly id: DefinitionId;
  readonly exported: boolean;
  readonly spelling: string;
  readonly category: SyntaxCategory;
  readonly shadowsCore: boolean;
  readonly rules: readonly MacroRule[];
  readonly clauses: readonly DefinitionClause[];
  readonly body: GroupSyntax;
}

export type MacroDefinition =
  SyntaxDefinition | SyntaxClassDefinition | OperatorDefinition;

export interface UnparsedTopLevel extends MacroLanguageNode {
  readonly syntax: Syntax;
}

export function freezeSequence(syntax: readonly Syntax[]): SyntaxSequence {
  return Object.freeze([...syntax]);
}
