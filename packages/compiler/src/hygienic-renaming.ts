import {
  BindingResolver,
  EnvironmentStore,
  ScopeFiledIndex,
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

/** Where in the printed text the name a binder declares is in scope. */
interface Region {
  readonly start: number;
  readonly end: number;
}

interface IdentifierClassification {
  readonly roleByOffset: ReadonlyMap<number, IdentifierRole>;
  /**
   * For each binder declared inside a function or a block, the region its
   * declaration binds the name over. A module's own declarations, at its
   * top or a namespace's, have none.
   */
  readonly regionByOffset: ReadonlyMap<number, Region>;
  readonly namespaceByOffset: ReadonlyMap<number, NameNamespace>;
  readonly shorthandOffsets: ReadonlySet<number>;
  readonly importBindingOffsets: ReadonlySet<number>;
  readonly publicBinderOffsets: ReadonlySet<number>;
  readonly exportSpecifierOffsets: ReadonlySet<number>;
}

/**
 * Every node of `root`, read from a stack of its own rather than by recursion.
 * TypeScript nests a chain of binary operators one node per operator, so `0 +
 * 1 + ... + 9999` -- which a fold builds as readily as an author writes it --
 * is ten thousand nodes deep, and a recursive walk ran out of stack on it.
 */
function* everyNode(root: ts.Node): Generator<ts.Node> {
  const pending: ts.Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    yield node;
    const children: ts.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let at = children.length - 1; at >= 0; at -= 1)
      pending.push(children[at]!);
  }
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
  for (const node of everyNode(parsed))
    if (
      ts.isParameter(node) &&
      ts.isParameterPropertyDeclaration(node, node.parent) &&
      ts.isIdentifier(node.name)
    )
      names.add(node.name.text);
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

/**
 * The node over which the binder `identifier` declares its name, as
 * TypeScript scopes it: a parameter over its function, a `let`, a `const`
 * and a block-level declaration over the block holding it, a `var` over its
 * function, a function or class expression's own name over itself.
 */
function bindingScope(identifier: ts.Identifier): ts.Node | undefined {
  let declaration: ts.Node | undefined = identifier.parent;
  while (
    declaration !== undefined &&
    (ts.isBindingElement(declaration) ||
      ts.isObjectBindingPattern(declaration) ||
      ts.isArrayBindingPattern(declaration))
  )
    declaration = declaration.parent;
  if (declaration === undefined) return undefined;
  const container = (node: ts.Node | undefined): ts.Node | undefined =>
    node !== undefined && ts.isCaseClause(node) ? node.parent : node;
  // A parameter property declares a member as well, which `this.name`
  // reaches anywhere in the class.
  if (
    ts.isParameter(declaration) &&
    ts.isParameterPropertyDeclaration(declaration, declaration.parent)
  )
    return declaration.parent.parent;
  if (ts.isParameter(declaration) || ts.isTypeParameterDeclaration(declaration))
    return declaration.parent;
  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    if (ts.isCatchClause(list)) return list;
    if (!ts.isVariableDeclarationList(list)) return undefined;
    const holder = list.parent;
    if ((list.flags & ts.NodeFlags.BlockScoped) !== 0)
      return ts.isVariableStatement(holder) ? container(holder.parent) : holder;
    let scope: ts.Node | undefined = holder;
    while (
      scope !== undefined &&
      !ts.isFunctionLike(scope) &&
      !ts.isSourceFile(scope) &&
      !ts.isModuleBlock(scope) &&
      !ts.isClassStaticBlockDeclaration(scope)
    )
      scope = scope.parent;
    return scope;
  }
  if (ts.isFunctionExpression(declaration) || ts.isClassExpression(declaration))
    return declaration;
  if (ts.isLabeledStatement(declaration)) return declaration;
  if (
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  )
    return declaration.getSourceFile();
  return container(declaration.parent);
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
  const regionByOffset = new Map<number, Region>();
  const namespaceByOffset = new Map<number, NameNamespace>();
  const shorthandOffsets = new Set<number>();
  const importBindingOffsets = new Set<number>();
  const publicBinderOffsets = new Set<number>();
  const exportSpecifierOffsets = new Set<number>();
  for (const node of everyNode(parsed)) {
    if (ts.isIdentifier(node)) {
      const start = node.getStart(parsed);
      const role = roleFor(node, parameterProperties);
      roleByOffset.set(start, role);
      if (role === "binder") {
        const scope = bindingScope(node);
        if (
          scope !== undefined &&
          !ts.isSourceFile(scope) &&
          !ts.isModuleBlock(scope)
        )
          regionByOffset.set(start, {
            start: scope.getStart(parsed),
            end: scope.end,
          });
      }
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
  }
  return Object.freeze({
    roleByOffset,
    regionByOffset,
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
 * Entries kept by spelling and filed by scope (see `ScopeFiledIndex`), asked
 * for those a token reaches: spelled as it is, with every one of their
 * scopes among its own. Every class each invocation introduces of a name --
 * the `tmp` of a swap -- is one more of its spelling.
 */
class ScopedIndex<Entry extends { readonly scopes: ScopeSetId }> {
  readonly #bySpelling = new Map<string, ScopeFiledIndex<Entry>>();

  constructor(readonly scopes: ScopeStore) {}

  add(spelling: string, entry: Entry): void {
    let filed = this.#bySpelling.get(spelling);
    if (filed === undefined) {
      filed = new ScopeFiledIndex<Entry>(this.scopes, ({ scopes }) => scopes);
      this.#bySpelling.set(spelling, filed);
    }
    filed.add(entry);
  }

  reaching(token: TokenSyntax): readonly Entry[] {
    return (
      this.#bySpelling
        .get(token.raw)
        ?.filter(token.scopes, (entry) =>
          this.scopes.subset(entry.scopes, token.scopes),
        ) ?? []
    );
  }
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
  /**
   * The scopes a binder was declared with, where a binding contract declared
   * it. The printed binder carries the scopes the copy into its template gave
   * it, and a name copied through a macro keeps that macro's use-site scope,
   * which nothing written after the invocation carries: keyed on those, a
   * contract's binder bound none of the names the contract binds, and they
   * stayed spelled as a call site's binding of the same name.
   */
  readonly declaredScopes?:
    ((token: TokenSyntax) => ScopeSetId | undefined) | undefined;
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
 * A call-site binder is renamed where a name a template writes free would
 * otherwise be captured by it (see `planFor`).
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
  const regionBySyntax = new Map<number, Region>();
  const printedAt = new Map<number, number>();
  for (const span of options.tokenSpans) {
    printedAt.set(span.syntax, span.start);
    const role = classification.roleByOffset.get(span.start);
    if (role !== undefined) roleBySyntax.set(span.syntax, role);
    const region = classification.regionByOffset.get(span.start);
    if (region !== undefined) regionBySyntax.set(span.syntax, region);
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
  const exportSpecifiersBySpelling = new Map<string, TokenSyntax[]>();
  for (const token of tokens) {
    if (!exportSpecifierSyntax.has(token.id)) continue;
    const spelled = exportSpecifiersBySpelling.get(token.raw);
    if (spelled === undefined)
      exportSpecifiersBySpelling.set(token.raw, [token]);
    else spelled.push(token);
  }
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
    (exportSpecifiersBySpelling.get(token.raw) ?? []).some((specifier) =>
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
    /**
     * The regions each class's binders scope, by class, where the class
     * binds only in them; a class with a binder at a module's top binds
     * everywhere and has none. A template's tokens carry one scope set, so
     * its parameter `JSON` and the global `JSON` it uses beside it are one
     * class by their scopes alone: renamed together, `((JSON) => JSON)(1),
     * JSON.stringify(x)` printed `JSON_1.stringify(x)`, which names nothing.
     * Where a binder binds says which of them it binds.
     */
    const classRegions = new Map<string, Region[]>();
    const unbounded = new Set<string>();
    const published = new Set<string>();
    for (const token of inSpace) {
      if (roleBySyntax.get(token.id) !== "binder") continue;
      if (!options.scopes.hasUnmatchedIntroduction(token.scopes)) continue;
      // A binder binds with the scopes its contract declared it with, or --
      // as the expander records it -- with the call site's scopes where
      // `#capture` published it there, and its own scopes otherwise.
      const scopes =
        options.declaredScopes?.(token) ??
        options.scopes.publishedTo(token.scopes);
      const key = `${token.raw} ${String(scopes)}`;
      if (publicBinderSyntax.has(token.id) || isExported(token)) {
        published.add(key);
        continue;
      }
      const region = regionBySyntax.get(token.id);
      if (region === undefined) unbounded.add(key);
      else {
        const regions = classRegions.get(key);
        if (regions === undefined) classRegions.set(key, [region]);
        else regions.push(region);
      }
      if (!classes.has(key))
        classes.set(key, {
          spelling: token.raw,
          scopes,
          declaration: token.origin,
        });
    }
    // One published binder holds the whole class in place; the rest of the
    // class is the same name.
    for (const key of published) classes.delete(key);
    for (const key of unbounded) classRegions.delete(key);
    for (const key of [...classRegions.keys()])
      if (!classes.has(key)) classRegions.delete(key);
    /** Whether `token` stands where a class with these regions binds. */
    const standsIn = (
      token: TokenSyntax,
      regions: readonly Region[] | undefined,
    ): boolean => {
      if (regions === undefined) return true;
      const at = printedAt.get(token.id);
      return (
        at !== undefined &&
        regions.some((region) => at >= region.start && at < region.end)
      );
    };

    // A name a template writes and does not bind there is free in it, and
    // never means a local of the function or block its invocation stands
    // in: `Math.abs($e)` means the global, whatever `Math` the caller
    // declares around the call. Printed as written, such a local captured
    // it, so the local is renamed instead, and its own uses with it -- unless
    // the reference is in its scopes, as a name a contract binds is. What a
    // module declares at its top is left alone: a template that writes
    // `add($a)` where its own module declares no `add` means the one the
    // module using it declares or imports.
    const introducedClasses = new ScopedIndex<{
      readonly key: string;
      readonly scopes: ScopeSetId;
    }>(options.scopes);
    for (const [key, candidate] of classes)
      introducedClasses.add(candidate.spelling, {
        key,
        scopes: candidate.scopes,
      });
    const freeBySpelling = new Map<string, TokenSyntax[]>();
    for (const token of inSpace) {
      if (roleBySyntax.get(token.id) === "property") continue;
      if (roleBySyntax.get(token.id) === "binder") continue;
      if (!options.scopes.hasUnmatchedIntroduction(token.scopes)) continue;
      if (
        introducedClasses
          .reaching(token)
          .some(({ key }) => standsIn(token, classRegions.get(key)))
      )
        continue;
      const spelled = freeBySpelling.get(token.raw);
      if (spelled === undefined) freeBySpelling.set(token.raw, [token]);
      else spelled.push(token);
    }
    // Each spelling's free names in the order they are printed, so a
    // binder's region is asked of the ones in it, not of every one.
    const freeAt = new Map<string, { at: number; reference: TokenSyntax }[]>();
    for (const [spelling, references] of freeBySpelling)
      freeAt.set(
        spelling,
        references
          .flatMap((reference) => {
            const at = printedAt.get(reference.id);
            return at === undefined ? [] : [{ at, reference }];
          })
          .sort((left, right) => left.at - right.at),
      );
    for (const token of inSpace) {
      const free = freeAt.get(token.raw);
      if (free === undefined) continue;
      if (roleBySyntax.get(token.id) !== "binder") continue;
      if (options.scopes.hasUnmatchedIntroduction(token.scopes)) continue;
      if (publicBinderSyntax.has(token.id) || isExported(token)) continue;
      const region = regionBySyntax.get(token.id);
      if (region === undefined) continue;
      let captures = false;
      for (
        let index = firstAtOrAfter(free, region.start);
        index < free.length && free[index]!.at < region.end && !captures;
        index += 1
      )
        captures = !options.scopes.subset(
          token.scopes,
          free[index]!.reference.scopes,
        );
      if (!captures) continue;
      // A binder the call site declares carries the scopes of the code
      // around it, which an import or a binder of another function may
      // carry as well, so what it binds is told by where it binds too: its
      // class is renamed only over the regions its binders scope.
      const key = `${token.raw} ${String(token.scopes)}`;
      const regions = classRegions.get(key);
      if (regions !== undefined) regions.push(region);
      else {
        classRegions.set(key, [region]);
        classes.set(key, {
          spelling: token.raw,
          scopes: token.scopes,
          declaration: token.origin,
        });
      }
    }
    if (classes.size === 0) return undefined;

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

    // A token belongs to a class when it is spelled as the class is and
    // carries every one of its scopes: when the class's binding applies to it.
    const classResolver = new BindingResolver(
      environments,
      environment,
      options.scopes,
    );
    const belongsToClass = (token: TokenSyntax): boolean =>
      classResolver.applies({
        spelling: token.raw,
        scopes: token.scopes,
        phase: options.phase,
        space,
        position: token.span.start,
      });

    const boundedClasses = new ScopedIndex<{
      readonly scopes: ScopeSetId;
      readonly regions: readonly Region[];
    }>(options.scopes);
    for (const [key, regions] of classRegions) {
      const bounded = classes.get(key)!;
      boundedClasses.add(bounded.spelling, { scopes: bounded.scopes, regions });
    }
    /**
     * Whether a token a class bounded to regions would reach by its scopes
     * stands where that class binds; a token no such class reaches does
     * wherever it stands.
     */
    const withinItsClass = (token: TokenSyntax): boolean => {
      const reached = boundedClasses.reaching(token);
      return (
        reached.length === 0 ||
        reached.some(({ regions }) => standsIn(token, regions))
      );
    };

    // A token no class renames keeps its spelling, which no class may then
    // be renamed to.
    const unavailable = new Set(options.reservedNames ?? []);
    for (const token of inSpace) {
      if (roleBySyntax.get(token.id) === "property") continue;
      if (!belongsToClass(token) || !withinItsClass(token))
        unavailable.add(token.raw);
    }

    const takesPart = (token: TokenSyntax): boolean =>
      spaceOf(token) === space &&
      roleBySyntax.get(token.id) !== "property" &&
      withinItsClass(token);

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

/** The index of the first of `sorted`, in printed order, at or after `at`. */
function firstAtOrAfter(
  sorted: readonly { readonly at: number }[],
  at: number,
): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]!.at < at) low = middle + 1;
    else high = middle;
  }
  return low;
}
