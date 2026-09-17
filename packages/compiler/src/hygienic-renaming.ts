import {
  EnvironmentStore,
  type Binding,
  type Phase,
  type ScopeStore,
} from "@sweetener/hygiene";
import type { BindingId, OriginId, ScopeSetId } from "@sweetener/shared";
import {
  createHygienicNamePlan,
  type NameAssignmentPlan,
  type PrintedTokenSpan,
} from "@sweetener/printer";
import type { Syntax, TokenSyntax } from "@sweetener/syntax";
import * as ts from "typescript";

/**
 * How an identifier sits in the printed program. Only `binder` positions
 * declare a name, and only non-`property` positions refer to one, so the two
 * roles decide which tokens a rename may touch.
 */
type IdentifierRole = "binder" | "property" | "reference";

/**
 * Which family of names an identifier belongs to.
 *
 * A label named `outer` and a variable named `outer` are different names, and
 * a rename of one must not reach the other. Renaming runs once per namespace.
 *
 * A parameter property is not a third namespace: `constructor(private held)`
 * declares a parameter and a member under the one spelling, and renaming it
 * has to move both together.
 */
type NameNamespace = "value" | "label";

interface IdentifierClassification {
  readonly roleByOffset: ReadonlyMap<number, IdentifierRole>;
  readonly namespaceByOffset: ReadonlyMap<number, NameNamespace>;
  readonly shorthandOffsets: ReadonlySet<number>;
  readonly importBindingOffsets: ReadonlySet<number>;
  readonly publicBinderOffsets: ReadonlySet<number>;
  readonly exportSpecifierOffsets: ReadonlySet<number>;
}

function nameOf(node: ts.Node): ts.Node | undefined {
  return (node as { readonly name?: ts.Node }).name;
}

/** The namespace the identifier's own position puts it in. */
function namespaceFor(identifier: ts.Identifier): NameNamespace {
  const parent: ts.Node | undefined = identifier.parent;
  if (parent === undefined) return "value";
  if (
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent) ||
    ts.isContinueStatement(parent)
  )
    return "label";
  return "value";
}

/**
 * The names this file declares as parameter properties.
 *
 * A `this.name` may only be renamed along with the parameter that declares it,
 * so the renamer has to know which names those are before it classifies any
 * property access.
 */
function parameterPropertyNames(parsed: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isParameter(node) &&
      ts.isParameterPropertyDeclaration(node, node.parent) &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names;
}

function roleFor(
  identifier: ts.Identifier,
  parameterProperties: ReadonlySet<string>,
): IdentifierRole {
  const parent: ts.Node | undefined = identifier.parent;
  if (parent === undefined) return "reference";
  switch (parent.kind) {
    // A parameter property declares a class member as well as a parameter,
    // under the one spelling. Both are the macro's own, and `this.name` reaches
    // the member, so the two are renamed together in the member namespace.
    case ts.SyntaxKind.Parameter:
      return nameOf(parent) === identifier ? "binder" : "property";
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ClassExpression:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.TypeParameter:
    case ts.SyntaxKind.ImportClause:
    case ts.SyntaxKind.NamespaceImport:
    case ts.SyntaxKind.ImportEqualsDeclaration:
      return nameOf(parent) === identifier ? "binder" : "reference";
    case ts.SyntaxKind.BindingElement: {
      const element = parent as ts.BindingElement;
      if (element.propertyName === identifier) return "property";
      return element.name === identifier ? "binder" : "reference";
    }
    case ts.SyntaxKind.ImportSpecifier: {
      const specifier = parent as ts.ImportSpecifier;
      if (specifier.propertyName === identifier) return "property";
      return specifier.name === identifier ? "binder" : "reference";
    }
    // Both halves of an export specifier name the module's public surface, so
    // neither may be rewritten; a class reached this way is pinned instead.
    case ts.SyntaxKind.ExportSpecifier:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.EnumMember:
    case ts.SyntaxKind.JsxAttribute:
    case ts.SyntaxKind.NamedTupleMember:
      return nameOf(parent) === identifier ? "property" : "reference";
    case ts.SyntaxKind.PropertyAccessExpression: {
      const access = parent as ts.PropertyAccessExpression;
      if (access.name !== identifier) return "reference";
      // `this.name` reaching a parameter property declared in this file names
      // the same thing the parameter does, so a rename has to move both. Every
      // other property access reaches a name declared somewhere this rename
      // cannot follow, and stays put.
      return access.expression.kind === ts.SyntaxKind.ThisKeyword &&
        parameterProperties.has(identifier.text)
        ? "reference"
        : "property";
    }
    case ts.SyntaxKind.QualifiedName:
      return (parent as ts.QualifiedName).right === identifier
        ? "property"
        : "reference";
    // A label declares a name and `break`/`continue` refer to one, in a
    // namespace of their own. Read as properties, a label a macro introduces
    // would never be renamed, so it would collide with a label of the same
    // spelling around the call site: a duplicate label, and a `break` that
    // leaves whichever loop the collision leaves standing.
    case ts.SyntaxKind.LabeledStatement:
      return (parent as ts.LabeledStatement).label === identifier
        ? "binder"
        : "reference";
    case ts.SyntaxKind.BreakStatement:
    case ts.SyntaxKind.ContinueStatement:
      return "reference";
    case ts.SyntaxKind.MetaProperty:
      return "property";
    default:
      return "reference";
  }
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = (
    node as { readonly modifiers?: readonly ts.ModifierLike[] }
  ).modifiers;
  return (
    modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

/**
 * Whether the declaration this name belongs to is part of the module's public
 * surface. A macro that writes `export` has named something on purpose, so the
 * name stays put and a genuine clash becomes an ordinary redeclaration error
 * rather than a silently renamed export.
 */
function declaresPublicName(identifier: ts.Identifier): boolean {
  let node: ts.Node | undefined = identifier.parent;
  while (
    node !== undefined &&
    (ts.isVariableDeclaration(node) ||
      ts.isVariableDeclarationList(node) ||
      ts.isBindingElement(node) ||
      ts.isObjectBindingPattern(node) ||
      ts.isArrayBindingPattern(node))
  ) {
    node = node.parent;
  }
  return node !== undefined && hasExportModifier(node);
}

function classifyIdentifiers(
  text: string,
  fileName: string,
): IdentifierClassification {
  const parsed = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parameterProperties = parameterPropertyNames(parsed);
  const roleByOffset = new Map<number, IdentifierRole>();
  const namespaceByOffset = new Map<number, NameNamespace>();
  const shorthandOffsets = new Set<number>();
  const importBindingOffsets = new Set<number>();
  const publicBinderOffsets = new Set<number>();
  const exportSpecifierOffsets = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const start = node.getStart(parsed);
      const role = roleFor(node, parameterProperties);
      roleByOffset.set(start, role);
      namespaceByOffset.set(start, namespaceFor(node));
      const parent: ts.Node | undefined = node.parent;
      if (
        parent !== undefined &&
        ((ts.isShorthandPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) &&
            parent.name === node &&
            parent.propertyName === undefined &&
            parent.parent.kind === ts.SyntaxKind.ObjectBindingPattern))
      ) {
        shorthandOffsets.add(start);
      }
      if (
        parent !== undefined &&
        ts.isImportSpecifier(parent) &&
        parent.propertyName === undefined
      ) {
        // The one spelling names both the export and the local binding.
        importBindingOffsets.add(start);
      }
      if (role === "binder" && declaresPublicName(node)) {
        publicBinderOffsets.add(start);
      }
      // `export { name }` names the module surface with no declaration to
      // anchor on, so the binder it names stays put. Which binder that is has
      // to be resolved by scope, not by spelling.
      if (parent !== undefined && ts.isExportSpecifier(parent)) {
        exportSpecifierOffsets.add(start);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return Object.freeze({
    roleByOffset,
    namespaceByOffset,
    shorthandOffsets,
    importBindingOffsets,
    publicBinderOffsets,
    exportSpecifierOffsets,
  });
}

function tokensOf(syntax: readonly Syntax[]): TokenSyntax[] {
  const tokens: TokenSyntax[] = [];
  const pending = [...syntax].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.tag === "token") {
      tokens.push(node);
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      pending.push(node.children[index]!);
  }
  return tokens;
}

interface IntroducedBinderClass {
  readonly spelling: string;
  readonly scopes: ScopeSetId;
  readonly declaration: OriginId;
}

/**
 * Whether any template-introduced spelling is also spelled by syntax from
 * somewhere else. Only then can a name capture another, so this spares the
 * common file a second TypeScript parse.
 */
function mayCapture(
  scopes: ScopeStore,
  tokens: readonly TokenSyntax[],
): boolean {
  const scopesBySpelling = new Map<string, ScopeSetId>();
  const contested = new Set<string>();
  for (const token of tokens) {
    const seen = scopesBySpelling.get(token.raw);
    if (seen === undefined) scopesBySpelling.set(token.raw, token.scopes);
    else if (seen !== token.scopes) contested.add(token.raw);
  }
  return tokens.some(
    (token) =>
      contested.has(token.raw) && scopes.hasUnmatchedIntroduction(token.scopes),
  );
}

export interface PlanHygienicRenamesOptions {
  readonly syntax: readonly Syntax[];
  readonly scopes: ScopeStore;
  readonly phase: Phase;
  /** The printed program, used to locate binder positions with TypeScript. */
  readonly text: string;
  readonly tokenSpans: readonly PrintedTokenSpan[];
  readonly fileName: string;
  /** Names already claimed by generated imports at the top of the file. */
  readonly reservedNames?: readonly string[] | undefined;
}

/**
 * Renames macro-introduced bindings so they cannot capture call-site
 * identifiers.
 *
 * Expansion records where every token came from and which scopes it carries,
 * but neither fact says which tokens are *binders* — that is a question about
 * the grammar of the expanded program, so TypeScript answers it. Identifiers
 * that TypeScript reports in binding position and that expansion reports as
 * template-introduced form the rename candidates; each becomes one binding,
 * keyed by spelling and scope set, so the uses that belong to it resolve
 * through the ordinary scope-set rules while call-site identifiers of the same
 * spelling resolve elsewhere and keep their text.
 *
 * A class is only renamed when its spelling is claimed by something else in the
 * file, so untroubled expansions print exactly as they did before.
 */
export function planHygienicRenames(
  options: PlanHygienicRenamesOptions,
): NameAssignmentPlan | undefined {
  const tokens = tokensOf(options.syntax).filter(
    (token) => token.kind === "identifier",
  );
  if (!mayCapture(options.scopes, tokens)) return undefined;

  const classification = classifyIdentifiers(options.text, options.fileName);
  const roleBySyntax = new Map<number, IdentifierRole>();
  const shorthandSyntax = new Set<number>();
  const importBindingSyntax = new Set<number>();
  const publicBinderSyntax = new Set<number>();
  const exportSpecifierSyntax = new Set<number>();
  const namespaceBySyntax = new Map<number, NameNamespace>();
  for (const span of options.tokenSpans) {
    const role = classification.roleByOffset.get(span.start);
    if (role !== undefined) roleBySyntax.set(span.syntax, role);
    const space = classification.namespaceByOffset.get(span.start);
    if (space !== undefined) namespaceBySyntax.set(span.syntax, space);
    if (classification.shorthandOffsets.has(span.start))
      shorthandSyntax.add(span.syntax);
    if (classification.importBindingOffsets.has(span.start))
      importBindingSyntax.add(span.syntax);
    if (classification.publicBinderOffsets.has(span.start))
      publicBinderSyntax.add(span.syntax);
    if (classification.exportSpecifierOffsets.has(span.start))
      exportSpecifierSyntax.add(span.syntax);
  }
  const exportSpecifiers = tokens.filter((token) =>
    exportSpecifierSyntax.has(token.id),
  );
  /**
   * Whether an `export { name }` in this file names this binder.
   *
   * An export specifier resolves the way any reference does: to a binder whose
   * scopes it contains. Checked by spelling alone, a call site that exports
   * its own `tmp` would pin a macro-introduced `tmp` as well -- leaving two
   * `const tmp` declarations in the output and a redeclaration error where
   * hygiene should have renamed one of them.
   */
  const isExported = (token: TokenSyntax): boolean =>
    exportSpecifiers.some(
      (specifier) =>
        specifier.raw === token.raw &&
        options.scopes.subset(token.scopes, specifier.scopes),
    );

  const spaceOf = (token: TokenSyntax): NameNamespace =>
    namespaceBySyntax.get(token.id) ?? "value";

  /**
   * Plans the renames for one namespace.
   *
   * A token takes part only if it is in the namespace being planned, so a
   * member named `held` is never renamed by a class built from a variable
   * named `held`, and neither is renamed by a label of that spelling.
   */
  const planFor = (space: NameNamespace): NameAssignmentPlan | undefined => {
    const inSpace = tokens.filter((token) => spaceOf(token) === space);
    const classes = new Map<string, IntroducedBinderClass>();
    const published = new Set<string>();
    for (const token of inSpace) {
      if (roleBySyntax.get(token.id) !== "binder") continue;
      if (!options.scopes.hasUnmatchedIntroduction(token.scopes)) continue;
      const key = `${token.raw} ${String(token.scopes)}`;
      if (publicBinderSyntax.has(token.id) || isExported(token)) {
        published.add(key);
        continue;
      }
      classes.set(key, {
        spelling: token.raw,
        scopes: token.scopes,
        declaration: token.origin,
      });
    }
    // One published binder holds the whole class in place; the rest of the
    // class is the same name.
    for (const key of published) classes.delete(key);
    if (classes.size === 0) return undefined;

    const belongsToClass = (token: TokenSyntax): boolean =>
      [...classes.values()].some(
        (candidate) =>
          candidate.spelling === token.raw &&
          options.scopes.subset(candidate.scopes, token.scopes),
      );

    const environments = new EnvironmentStore();
    let environment = environments.createRoot();
    const bindings: Binding[] = [];
    for (const candidate of classes.values()) {
      const declared = environments.declare(environment, {
        spelling: candidate.spelling,
        scopes: candidate.scopes,
        phase: options.phase,
        space,
        declaration: candidate.declaration,
        kind: "generated",
      });
      environment = declared.environment;
      bindings.push(declared.binding);
    }

    const unavailable = new Set(options.reservedNames ?? []);
    for (const token of inSpace) {
      if (roleBySyntax.get(token.id) === "property") continue;
      if (!belongsToClass(token)) unavailable.add(token.raw);
    }

    const takesPart = (token: TokenSyntax): boolean =>
      spaceOf(token) === space && roleBySyntax.get(token.id) !== "property";

    return createHygienicNamePlan({
      syntax: options.syntax,
      bindings,
      environments,
      environment,
      scopes: options.scopes,
      phase: options.phase,
      space,
      unavailableNames: [...unavailable],
      includeToken: takesPart,
      occurrenceKind: (token) =>
        shorthandSyntax.has(token.id)
          ? "shorthand-value"
          : importBindingSyntax.has(token.id)
            ? "import-binding"
            : "identifier",
      propertySpelling: (token) => token.raw,
    });
  };

  const plans = (["value", "label"] as const)
    .map(planFor)
    .filter((plan): plan is NameAssignmentPlan => plan !== undefined);
  if (plans.length === 0) return undefined;
  if (plans.length === 1) return plans[0];
  // The namespaces rename disjoint sets of tokens, so their plans compose.
  const names = new Map<BindingId, string>();
  for (const plan of plans)
    for (const [binding, name] of plan.names) names.set(binding, name);
  return Object.freeze({
    names,
    rewrites: Object.freeze(plans.flatMap((plan) => [...plan.rewrites])),
    nameFor: (binding: BindingId) => names.get(binding),
  });
}
