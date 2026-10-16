import {
  BindingResolver,
  type Binding,
  type BindingEnvironment,
  type EnvironmentStore,
  type Phase,
  type ScopeStore,
  type SyntaxSpace,
} from "@sweetener/hygiene";
import type { BindingId } from "@sweetener/shared";
import type { Syntax, TokenSyntax } from "@sweetener/syntax";
import {
  assignPrintedNames,
  type NameAssignmentPlan,
  type NameOccurrenceKind,
} from "./name-assignment.js";

export interface CreateHygienicNamePlanOptions {
  readonly syntax: readonly Syntax[];
  readonly bindings: readonly Binding[];
  readonly environments: EnvironmentStore;
  readonly environment: BindingEnvironment;
  readonly scopes: ScopeStore;
  readonly phase: Phase;
  readonly space?: SyntaxSpace | undefined;
  readonly unavailableNames?: readonly string[] | undefined;
  readonly occurrenceKind?:
    ((token: TokenSyntax) => NameOccurrenceKind) | undefined;
  /**
   * Restricts which identifier tokens count as occurrences. Property names,
   * member accesses, and import specifiers share a spelling and scope set with
   * the bindings around them but must keep their own text.
   */
  readonly includeToken?: ((token: TokenSyntax) => boolean) | undefined;
  readonly propertySpelling?:
    ((token: TokenSyntax) => string | undefined) | undefined;
}

function tokensInTraversalOrder(syntax: readonly Syntax[]): TokenSyntax[] {
  const output: TokenSyntax[] = [];
  const pending = [...syntax].reverse();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.tag === "token") {
      output.push(current);
      continue;
    }
    if (current.tag === "group") {
      for (let index = current.children.length - 1; index >= 0; index -= 1)
        pending.push(current.children[index]!);
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1)
      pending.push(current.children[index]!);
  }
  return output;
}

/** Resolves expanded identifiers and derives the deterministic printer plan. */
export function createHygienicNamePlan(
  options: CreateHygienicNamePlanOptions,
): NameAssignmentPlan {
  const bindingById = new Map(
    options.bindings.map((binding) => [binding.id, binding]),
  );
  if (bindingById.size !== options.bindings.length)
    throw new RangeError(
      "Duplicate binding supplied to hygienic name planning",
    );
  const resolver = new BindingResolver(
    options.environments,
    options.environment,
    options.scopes,
  );
  const occurrences = tokensInTraversalOrder(options.syntax).flatMap(
    (token) => {
      if (token.kind !== "identifier") return [];
      if (options.includeToken?.(token) === false) return [];
      const resolution = resolver.resolve({
        spelling: token.raw,
        scopes: token.scopes,
        phase: options.phase,
        space: options.space ?? "value",
        position: token.span.start,
      });
      if (
        resolution.kind !== "resolved" ||
        !bindingById.has(resolution.binding.id)
      )
        return [];
      const kind = options.occurrenceKind?.(token) ?? ("identifier" as const);
      return [
        Object.freeze({
          syntax: token.id,
          binding: resolution.binding.id,
          kind,
          ...(kind === "identifier"
            ? {}
            : {
                propertySpelling:
                  options.propertySpelling?.(token) ?? token.raw,
              }),
        }),
      ];
    },
  );
  const used = new Set<BindingId>(occurrences.map(({ binding }) => binding));
  const bindings = options.bindings.filter(({ id }) => used.has(id));
  // Any two of these bindings are taken to be visible together once hygiene
  // is erased.
  return assignPrintedNames({
    declarations: bindings.map((binding) =>
      Object.freeze({
        binding: binding.id,
        preferredName: binding.spelling,
      }),
    ),
    everyDeclarationConflicts: true,
    occurrences,
    unavailableNames: options.unavailableNames,
  });
}
