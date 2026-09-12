import {
  createBindingContract,
  hygieneDiagnosticRegistry,
  incompatibleBindingAlignmentCode,
  incompatibleBindingSpaceCode,
  invalidBindingPathCode,
  malformedBindingContractCode,
  type BindingContract,
  type BindingContractKind,
  type BindingContractRegion,
  type SyntaxSpace,
} from "@sweetener/hygiene";
import {
  createCapturePath,
  createSequenceShape,
  inferCaptureShapes,
  parseIdentifierJoinArguments,
  type CapturePath,
  type CaptureShape,
  type LeafShape,
  type SyntaxClassRegistry,
} from "@sweetener/pattern";
import type {
  CardinalityGroupId,
  CaptureId,
  Diagnostic,
  OriginId,
  RuleId,
  SourceId,
} from "@sweetener/shared";
import type {
  Span,
  GroupSyntax,
  Syntax,
  SyntaxCategory,
  TokenSyntax,
} from "@sweetener/syntax";
import type {
  MacroDefinition,
  ParseMacroDefinitionsResult,
} from "./parser/index.js";

export interface CompileParsedBindingContractsOptions {
  readonly sourceId: SourceId;
  readonly spanForOrigin: (origin: OriginId) => Span;
  readonly syntaxClasses: SyntaxClassRegistry;
}

export interface CompiledRuleBindingContracts {
  readonly rule: RuleId;
  readonly contracts: readonly BindingContract[];
}

export interface CompileParsedBindingContractsResult {
  readonly rules: readonly CompiledRuleBindingContracts[];
  readonly diagnostics: readonly Diagnostic[];
}

interface ResolvedPath {
  readonly path: CapturePath;
  readonly shape: CaptureShape;
  readonly next: number;
}

function token(node: Syntax | undefined, raw?: string): node is TokenSyntax {
  return node?.tag === "token" && (raw === undefined || node.raw === raw);
}

function group(
  node: Syntax | undefined,
  delimiter?: GroupSyntax["delimiter"],
): node is GroupSyntax {
  return (
    node?.tag === "group" &&
    (delimiter === undefined || node.delimiter === delimiter)
  );
}

function baseLeaf(shape: CaptureShape): LeafShape {
  let current = shape;
  while (current.kind === "sequence") current = current.element;
  return current;
}

function projectFieldShape(
  container: CaptureShape,
  field: CaptureShape,
): CaptureShape {
  if (container.kind === "leaf") return field;
  return createSequenceShape({
    element: projectFieldShape(container.element, field),
    cardinalityGroup: container.cardinalityGroup,
    minimum: container.minimum,
    maximum: container.maximum,
  });
}

function cardinalityGroups(shape: CaptureShape): readonly CardinalityGroupId[] {
  const groups: CardinalityGroupId[] = [];
  let current = shape;
  while (current.kind === "sequence") {
    groups.push(current.cardinalityGroup);
    current = current.element;
  }
  return groups;
}

function categoryAllowsSpace(
  category: SyntaxCategory | undefined,
  space: SyntaxSpace,
): boolean {
  if (category === undefined || category === "item" || category === "tt") {
    return true;
  }
  switch (category) {
    case "expr":
      return space === "value";
    case "stmt":
      return space === "value" || space === "label";
    case "type":
      return space === "type" || space === "namespace";
    case "binding":
      return space === "value";
    case "classElement":
      return space === "value" || space === "type";
    // An interface member names nothing a lexical scope can see, so what a
    // type-member macro may introduce is type-side only.
    case "typeMember":
      return space === "type";
    case "jsxChild":
      return space === "value";
    case "token":
      return false;
  }
}

function definitionCategory(
  definition: MacroDefinition,
): SyntaxCategory | undefined {
  return definition.kind === "syntax-class" ? undefined : definition.category;
}

export function compileParsedBindingContracts(
  parsed: ParseMacroDefinitionsResult,
  options: CompileParsedBindingContractsOptions,
): CompileParsedBindingContractsResult {
  const diagnostics: Diagnostic[] = [];
  const rules: CompiledRuleBindingContracts[] = [];
  const bindingClass = parsed.classBindings.find(
    (binding) => binding.name === "binding",
  )?.classId;
  const identifierClass = parsed.classBindings.find(
    (binding) => binding.name === "ident",
  )?.classId;
  if (bindingClass === undefined) {
    throw new Error("Parser result is missing the binding syntax class");
  }

  const diagnostic = (
    code:
      | typeof malformedBindingContractCode
      | typeof invalidBindingPathCode
      | typeof incompatibleBindingAlignmentCode
      | typeof incompatibleBindingSpaceCode,
    origin: OriginId,
    argument?: string,
  ): void => {
    const span = options.spanForOrigin(origin);
    diagnostics.push(
      hygieneDiagnosticRegistry.create(code, {
        primaryOrigin: {
          sourceId: options.sourceId,
          start: span.start,
          end: span.end,
          originId: origin,
        },
        messageArguments: argument === undefined ? [] : [argument],
      }),
    );
  };

  for (const definition of parsed.definitions) {
    for (const rule of definition.rules) {
      const inference = inferCaptureShapes(rule.pattern, {
        sourceId: options.sourceId,
        spanForOrigin: options.spanForOrigin,
        fieldsForClass: (classId) =>
          options.syntaxClasses.shapeForClass(classId),
      });
      diagnostics.push(...inference.diagnostics);
      const bindings = new Map(
        inference.bindings.map((binding) => [binding.name, binding]),
      );
      const nodes = rule.clauses.flatMap((clause) =>
        clause.kind === "binding" ? [...clause.syntax] : [],
      );
      const contracts: BindingContract[] = [];
      const resolvePath = (
        start: number,
        source: readonly Syntax[] = nodes,
      ): ResolvedPath | undefined => {
        const rootToken = source[start];
        if (!token(rootToken) || !rootToken.raw.startsWith("$"))
          return undefined;
        const rootName = rootToken.raw.slice(1);
        const root = bindings.get(rootName);
        if (root === undefined) return undefined;
        let shape = root.shape;
        const fields: { readonly name: string; readonly capture: CaptureId }[] =
          [];
        let next = start + 1;
        while (token(source[next], ".") && token(source[next + 1])) {
          const fieldToken = source[next + 1] as TokenSyntax;
          const leaf = baseLeaf(shape);
          const field = options.syntaxClasses
            .get(leaf.classId)
            ?.fields.find((candidate) => candidate.name === fieldToken.raw);
          const fieldShape =
            field === undefined ? undefined : leaf.fields.get(field.capture);
          if (field === undefined || fieldShape === undefined) return undefined;
          fields.push({ name: field.name, capture: field.capture });
          shape = projectFieldShape(shape, fieldShape);
          next += 2;
        }
        return {
          path: createCapturePath(rootName, root.capture, fields),
          shape,
          next,
        };
      };

      let index = 0;
      while (index < nodes.length) {
        if (!token(nodes[index], "bind")) {
          index += 1;
          continue;
        }
        const origin = nodes[index]!.origin;
        const joinGroup =
          group(nodes[index + 2], "parenthesis") &&
          token(nodes[index + 1], "#join")
            ? (nodes[index + 2] as GroupSyntax)
            : undefined;
        const joined =
          joinGroup === undefined
            ? undefined
            : parseIdentifierJoinArguments(joinGroup.children, (start) =>
                resolvePath(start, joinGroup.children),
              );
        const binder: ResolvedPath | undefined =
          joined === undefined
            ? resolvePath(index + 1)
            : {
                path: joined.path,
                shape: joined.shape,
                next: index + 3,
              };
        const inIndex = binder?.next;
        let region: BindingContractRegion | undefined;
        let regionShape: CaptureShape | undefined;
        let next = inIndex === undefined ? index + 1 : inIndex + 1;
        if (inIndex !== undefined && token(nodes[inIndex], "in")) {
          if (token(nodes[next], "following")) {
            region = { kind: "following" };
            next += 1;
          } else {
            const resolvedRegion = resolvePath(next);
            if (resolvedRegion !== undefined) {
              region = { kind: "capture", path: resolvedRegion.path };
              regionShape = resolvedRegion.shape;
              next = resolvedRegion.next;
            }
          }
        }
        const kindToken = token(nodes[next], "as")
          ? nodes[next + 1]
          : undefined;
        const spaceToken = token(nodes[next], "as")
          ? nodes[next + 2]
          : undefined;
        const kind =
          token(kindToken) &&
          ["lexical", "recursive", "sequential"].includes(kindToken.raw)
            ? (kindToken.raw as BindingContractKind)
            : undefined;
        const space =
          token(spaceToken) &&
          ["value", "type", "namespace", "label"].includes(spaceToken.raw)
            ? (spaceToken.raw as SyntaxSpace)
            : undefined;
        if (
          binder === undefined ||
          region === undefined ||
          kind === undefined ||
          space === undefined
        ) {
          diagnostic(malformedBindingContractCode, origin);
          index = Math.max(index + 1, next + 3);
          continue;
        }
        const binderLeaf = baseLeaf(binder.shape);
        const directBinder =
          binderLeaf.classId === bindingClass ||
          binderLeaf.classId === identifierClass;
        const expandedBinders: ResolvedPath[] = directBinder
          ? [binder]
          : (
              options.syntaxClasses.get(binderLeaf.classId)?.fields ?? []
            ).flatMap((field) => {
              const fieldShape = binderLeaf.fields.get(field.capture);
              if (fieldShape === undefined) return [];
              const fieldLeaf = baseLeaf(fieldShape);
              if (
                fieldLeaf.classId !== bindingClass &&
                fieldLeaf.classId !== identifierClass
              ) {
                return [];
              }
              return [
                {
                  path: createCapturePath(
                    binder.path.rootName,
                    binder.path.root,
                    [
                      ...binder.path.fields,
                      { name: field.name, capture: field.capture },
                    ],
                  ),
                  shape: projectFieldShape(binder.shape, fieldShape),
                  next: binder.next,
                },
              ];
            });
        if (expandedBinders.length === 0) {
          diagnostic(
            invalidBindingPathCode,
            origin,
            `$${binder.path.rootName}`,
          );
          index = next + 3;
          continue;
        }
        if (!categoryAllowsSpace(definitionCategory(definition), space)) {
          diagnostic(incompatibleBindingSpaceCode, origin, space);
          index = next + 3;
          continue;
        }
        if (kind === "sequential") {
          const regionGroups =
            regionShape === undefined ? [] : cardinalityGroups(regionShape);
          if (
            expandedBinders.some((expanded) =>
              cardinalityGroups(expanded.shape).every(
                (group) => !regionGroups.includes(group),
              ),
            )
          ) {
            diagnostic(incompatibleBindingAlignmentCode, origin);
            index = next + 3;
            continue;
          }
        }
        for (const expanded of expandedBinders) {
          contracts.push(
            createBindingContract({
              origin,
              binders: expanded.path,
              region,
              kind,
              space,
              generatedName:
                joined === undefined
                  ? undefined
                  : {
                      prefix: joined.prefix,
                      suffix: joined.suffix,
                      casing: joined.casing,
                    },
            }),
          );
        }
        index = next + 3;
      }
      if (contracts.length > 0) {
        rules.push(
          Object.freeze({ rule: rule.id, contracts: Object.freeze(contracts) }),
        );
      }
    }
  }
  return Object.freeze({
    rules: Object.freeze(rules),
    diagnostics: Object.freeze(diagnostics),
  });
}
