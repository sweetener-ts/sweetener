import type { Binding, Phase } from "@sweetener/hygiene";
import { coreExpressionOperators } from "@sweetener/enforestation";
import type { MacroDefinition } from "@sweetener/macro-language";
import type {
  BindingId,
  Diagnostic,
  OriginId,
  SourceSpan,
} from "@sweetener/shared";
import type { SyntaxCategory } from "@sweetener/syntax";
import {
  ambiguousSyntaxDispatchCode,
  expansionDiagnosticRegistry,
  invalidCoreShadowCode,
  unauthorizedCoreShadowImportCode,
} from "./diagnostics.js";
import type {
  ExpansionEnvironment,
  ExpansionEnvironmentStore,
} from "./environment.js";
import { syntaxSpaceForCategory } from "./environment.js";

export interface CoreFormIdentity {
  readonly spelling: string;
  readonly category: SyntaxCategory;
}

const coreSpellingsByCategory = {
  expr: [
    "await",
    "class",
    "delete",
    "function",
    "new",
    "super",
    "this",
    "typeof",
    "void",
    "yield",
  ],
  stmt: [
    "break",
    "class",
    "const",
    "continue",
    "debugger",
    "do",
    "for",
    "function",
    "if",
    "let",
    "return",
    "switch",
    "throw",
    "try",
    "var",
    "while",
    "with",
  ],
  item: [
    "class",
    "const",
    "declare",
    "enum",
    "export",
    "function",
    "import",
    "interface",
    "let",
    "module",
    "namespace",
    "type",
    "var",
  ],
  type: [
    "abstract",
    "any",
    "asserts",
    "bigint",
    "boolean",
    "false",
    "infer",
    "keyof",
    "never",
    "new",
    "null",
    "number",
    "object",
    "readonly",
    "string",
    "symbol",
    "this",
    "true",
    "typeof",
    "undefined",
    "unique",
    "unknown",
    "void",
  ],
  classElement: [
    "abstract",
    "accessor",
    "constructor",
    "declare",
    "get",
    "override",
    "private",
    "protected",
    "public",
    "readonly",
    "set",
    "static",
  ],
  // A member name is written where a reserved word may also stand, so the
  // words an interface body dispatches on are its modifiers and signature
  // heads, not every keyword that can spell a property name.
  typeMember: ["get", "new", "readonly", "set"],
} as const satisfies Partial<Record<SyntaxCategory, readonly string[]>>;

const declaredCoreForms: CoreFormIdentity[] = Object.entries(
  coreSpellingsByCategory,
).flatMap(([category, spellings]) =>
  spellings.map((spelling) => ({
    spelling,
    category: category as SyntaxCategory,
  })),
);

/** The category-qualified surface forms that require explicit interception. */
export const coreFormIdentities: readonly CoreFormIdentity[] = Object.freeze(
  [
    ...declaredCoreForms,
    ...coreExpressionOperators.map(({ spelling }) => ({
      spelling,
      category: "expr" as const,
    })),
  ]
    .filter(
      ({ spelling, category }, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.spelling === spelling && candidate.category === category,
        ) === index,
    )
    .map((identity) => Object.freeze(identity)),
);

const coreFormKeys = new Set(
  coreFormIdentities.map(({ spelling, category }) => `${category}|${spelling}`),
);

export function isCoreForm(
  spelling: string,
  category: SyntaxCategory,
): boolean {
  return coreFormKeys.has(`${category}|${spelling}`);
}

export interface CoreShadowMetadata {
  readonly binding: BindingId;
  readonly spelling: string;
  readonly category: SyntaxCategory;
  readonly definitionOrigin: OriginId;
  readonly definitionOptIn: boolean;
  readonly provenance: "local" | "import";
  readonly importOrigin: OriginId | undefined;
  readonly importOptIn: boolean;
  readonly authorized: boolean;
}

export interface CoreShadowRegistrationResult {
  readonly registry: CoreShadowRegistry;
  readonly metadata: CoreShadowMetadata;
  readonly diagnostics: readonly Diagnostic[];
}

function definitionCategory(
  definition: MacroDefinition,
): SyntaxCategory | undefined {
  return definition.kind === "syntax-class" ? undefined : definition.category;
}

function definitionSpelling(definition: MacroDefinition): string {
  return definition.kind === "operator" ? definition.spelling : definition.name;
}

function definitionOptIn(definition: MacroDefinition): boolean {
  return definition.kind !== "syntax-class" && definition.shadowsCore;
}

function validateBinding(
  binding: Binding,
  spelling: string,
  category: SyntaxCategory,
): void {
  if (binding.spelling !== spelling) {
    throw new TypeError("Core-shadow metadata and binding spellings differ");
  }
  if (binding.space !== syntaxSpaceForCategory(category)) {
    throw new TypeError("Core-shadow metadata and binding categories differ");
  }
}

export class CoreShadowRegistry {
  readonly #metadata: ReadonlyMap<BindingId, CoreShadowMetadata>;

  constructor(metadata: readonly CoreShadowMetadata[] = []) {
    const indexed = new Map<BindingId, CoreShadowMetadata>();
    for (const item of metadata) {
      if (indexed.has(item.binding)) {
        throw new RangeError(
          `Duplicate core-shadow binding ${String(item.binding)}`,
        );
      }
      indexed.set(item.binding, Object.freeze({ ...item }));
    }
    this.#metadata = indexed;
    Object.freeze(this);
  }

  get(binding: BindingId): CoreShadowMetadata | undefined {
    return this.#metadata.get(binding);
  }

  withLocal(options: {
    readonly binding: Binding;
    readonly definition: MacroDefinition;
    readonly diagnosticOrigin: (origin: OriginId) => SourceSpan;
  }): CoreShadowRegistrationResult {
    const category = definitionCategory(options.definition);
    if (category === undefined) {
      throw new TypeError("Syntax classes cannot register core-form metadata");
    }
    const spelling = definitionSpelling(options.definition);
    validateBinding(options.binding, spelling, category);
    const requested = definitionOptIn(options.definition);
    const valid = !requested || isCoreForm(spelling, category);
    const diagnostics = valid
      ? []
      : [
          expansionDiagnosticRegistry.create(invalidCoreShadowCode, {
            primaryOrigin: options.diagnosticOrigin(options.definition.origin),
            messageArguments: [spelling, category],
          }),
        ];
    const metadata: CoreShadowMetadata = Object.freeze({
      binding: options.binding.id,
      spelling,
      category,
      definitionOrigin: options.definition.origin,
      definitionOptIn: requested && valid,
      provenance: "local",
      importOrigin: undefined,
      importOptIn: false,
      authorized: requested && valid,
    });
    return Object.freeze({
      registry: this.with(metadata),
      metadata,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  withImport(options: {
    readonly binding: Binding;
    readonly exported: CoreShadowMetadata;
    readonly importOrigin: OriginId;
    readonly shadowsCore: boolean;
    readonly diagnosticOrigin: (origin: OriginId) => SourceSpan;
  }): CoreShadowRegistrationResult {
    validateBinding(
      options.binding,
      options.exported.spelling,
      options.exported.category,
    );
    const mismatch = options.shadowsCore && !options.exported.definitionOptIn;
    const diagnostics = mismatch
      ? [
          expansionDiagnosticRegistry.create(unauthorizedCoreShadowImportCode, {
            primaryOrigin: options.diagnosticOrigin(options.importOrigin),
            messageArguments: [options.binding.spelling],
            relatedOrigins: [
              {
                message: "Imported definition",
                origin: options.diagnosticOrigin(
                  options.exported.definitionOrigin,
                ),
              },
            ],
          }),
        ]
      : [];
    const metadata: CoreShadowMetadata = Object.freeze({
      binding: options.binding.id,
      spelling: options.exported.spelling,
      category: options.exported.category,
      definitionOrigin: options.exported.definitionOrigin,
      definitionOptIn: options.exported.definitionOptIn,
      provenance: "import",
      importOrigin: options.importOrigin,
      importOptIn: options.shadowsCore,
      authorized:
        options.exported.definitionOptIn && options.shadowsCore && !mismatch,
    });
    return Object.freeze({
      registry: this.with(metadata),
      metadata,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  private with(metadata: CoreShadowMetadata): CoreShadowRegistry {
    return new CoreShadowRegistry([
      ...[...this.#metadata.values()].filter(
        ({ binding }) => binding !== metadata.binding,
      ),
      metadata,
    ]);
  }
}

export function isAuthorizedCoreShadow(
  registry: CoreShadowRegistry,
  binding: BindingId,
): boolean {
  return registry.get(binding)?.authorized === true;
}

export interface CoreDispatchTrace {
  readonly spelling: string;
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly environmentEpoch: ExpansionEnvironment["epoch"];
  readonly candidates: readonly BindingId[];
  readonly authorized: readonly BindingId[];
  readonly selected: BindingId | undefined;
  readonly decision: "shadow-macro" | "core" | "macro" | "none" | "ambiguous";
  readonly definitionOrigin: OriginId | undefined;
  readonly importOrigin: OriginId | undefined;
}

export type CoreDispatchResult =
  | {
      readonly kind: "shadow-macro" | "macro";
      readonly binding: Binding;
      readonly trace: CoreDispatchTrace;
    }
  | {
      readonly kind: "core" | "none";
      readonly trace: CoreDispatchTrace;
    }
  | {
      readonly kind: "ambiguous";
      readonly diagnostic: Diagnostic;
      readonly trace: CoreDispatchTrace;
    };

export function resolveCoreDispatch(options: {
  readonly environments: ExpansionEnvironmentStore;
  readonly environment: ExpansionEnvironment;
  readonly shadows: CoreShadowRegistry;
  readonly spelling: string;
  readonly category: SyntaxCategory;
  readonly phase: Phase;
  readonly origin: OriginId;
  readonly diagnosticOrigin: (origin: OriginId) => SourceSpan;
}): CoreDispatchResult {
  const candidates = options.environments.lookupBindings(options.environment, {
    spelling: options.spelling,
    category: options.category,
    phase: options.phase,
  });
  const authorized = candidates.filter(
    ({ id }) => options.shadows.get(id)?.authorized === true,
  );
  const core = isCoreForm(options.spelling, options.category);
  const decision =
    authorized.length > 1 || (!core && candidates.length > 1)
      ? "ambiguous"
      : authorized.length === 1
        ? "shadow-macro"
        : core
          ? "core"
          : candidates.length === 1
            ? "macro"
            : "none";
  const selected =
    decision === "shadow-macro"
      ? authorized[0]
      : decision === "macro"
        ? candidates[0]
        : undefined;
  const metadata = selected && options.shadows.get(selected.id);
  const trace: CoreDispatchTrace = Object.freeze({
    spelling: options.spelling,
    category: options.category,
    phase: options.phase,
    environmentEpoch: options.environment.epoch,
    candidates: Object.freeze(candidates.map(({ id }) => id)),
    authorized: Object.freeze(authorized.map(({ id }) => id)),
    selected: selected?.id,
    decision,
    definitionOrigin: metadata?.definitionOrigin,
    importOrigin: metadata?.importOrigin,
  });
  if (decision === "ambiguous") {
    return Object.freeze({
      kind: "ambiguous",
      trace,
      diagnostic: expansionDiagnosticRegistry.create(
        ambiguousSyntaxDispatchCode,
        {
          primaryOrigin: options.diagnosticOrigin(options.origin),
          messageArguments: [options.spelling, candidates.length],
          relatedOrigins: candidates.map((binding) => ({
            message: `Candidate ${String(binding.id)}`,
            origin: options.diagnosticOrigin(binding.declaration),
          })),
        },
      ),
    });
  }
  if (decision === "shadow-macro" || decision === "macro") {
    return Object.freeze({ kind: decision, binding: selected!, trace });
  }
  return Object.freeze({ kind: decision, trace });
}
