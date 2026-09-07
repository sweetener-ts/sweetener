import {
  captureShapeDepth,
  createCapturePath,
  createSequenceShape,
  identifierAffixesAreValid,
  isIdentifierText,
  parseIdentifierJoinArguments,
  type CaptureShape,
  type CaptureShapeBinding,
  type LeafShape,
} from "@sweetener/pattern";
import type {
  CaptureId,
  CardinalityGroupId,
  Diagnostic,
  OriginId,
  SourceId,
  SyntaxClassId,
} from "@sweetener/shared";
import type { GroupSyntax, Span, Syntax, TokenSyntax } from "@sweetener/syntax";
import {
  createCaptureTemplate,
  createConditionalTemplate,
  createFoldTemplate,
  createGroupTemplate,
  createHygieneOperationTemplate,
  createLiteralTemplate,
  createLocalTemplate,
  createRepeatTemplate,
  createSequenceTemplate,
  type CaptureTemplate,
  type SequenceTemplate,
  type TemplateNode,
} from "./ast.js";
import {
  incompatibleTemplateDriversCode,
  invalidTemplateOperationCode,
  malformedTemplateCode,
  missingTemplateDriverCode,
  templateCaptureDepthCode,
  templateDiagnosticRegistry,
  unknownTemplateCaptureCode,
  unknownTemplateFieldCode,
  unknownTemplateOperationCode,
} from "./diagnostics.js";

export interface TemplateField {
  readonly name: string;
  readonly capture: CaptureId;
}

export interface ParseTemplateOptions {
  readonly sourceId: SourceId;
  readonly captures: readonly CaptureShapeBinding[];
  readonly spanForOrigin: (origin: OriginId) => Span;
  readonly fieldsForClass?:
    | ((classId: SyntaxClassId) => readonly TemplateField[] | undefined)
    | undefined;
  readonly identifierClassIds?: readonly SyntaxClassId[] | undefined;
}

export interface ParseTemplateResult {
  readonly template: SequenceTemplate;
  readonly diagnostics: readonly Diagnostic[];
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

/**
 * The shape a `#count` of this one leaves standing.
 *
 * Counting collapses the innermost dimension to a single number and leaves
 * every dimension outside it alone, so a `#count` written inside a repetition
 * counts a different run on each turn of that repetition and drives it. It was
 * given no shape at all, on the reading that a count drives nothing -- true
 * only of the dimension it collapses. A repetition whose content was a count
 * was then refused as having no driving capture.
 */
function shapeWithoutInnermost(shape: CaptureShape): CaptureShape {
  if (shape.kind !== "sequence") return shape;
  if (shape.element.kind !== "sequence") return shape.element;
  return createSequenceShape({
    element: shapeWithoutInnermost(shape.element),
    cardinalityGroup: shape.cardinalityGroup,
    minimum: shape.minimum,
    maximum: shape.maximum,
  });
}

function cardinalityAtDepth(
  shape: CaptureShape,
  depth: number,
): CardinalityGroupId | undefined {
  let current = shape;
  let currentDepth = 1;
  while (current.kind === "sequence" && currentDepth < depth) {
    current = current.element;
    currentDepth += 1;
  }
  return current.kind === "sequence" ? current.cardinalityGroup : undefined;
}

function elementShapeAtDepth(
  shape: CaptureShape,
  dimensions: number,
): CaptureShape | undefined {
  let current = shape;
  for (let index = 0; index < dimensions; index += 1) {
    if (current.kind !== "sequence") return undefined;
    current = current.element;
  }
  return current;
}

interface FoldParserContext {
  readonly elementShape: CaptureShape;
}

/**
 * Every `#`-form the template language has.
 *
 * `#core` is not read here: it is carried through to the expander, which
 * re-reads its contents as core syntax rather than as a macro invocation.
 */
const templateOperations: ReadonlySet<string> = new Set([
  "callsite",
  "capture",
  "core",
  "count",
  "definition",
  "else",
  "fold",
  "fresh",
  "if",
  "index",
  "join",
  "metavar",
  "syntax",
  "text",
  "trim",
]);

class TemplateParser {
  readonly #options: ParseTemplateOptions;
  readonly #captures: ReadonlyMap<string, CaptureShapeBinding>;
  readonly #diagnostics: Diagnostic[] = [];

  constructor(options: ParseTemplateOptions) {
    this.#options = options;
    const captures = new Map<string, CaptureShapeBinding>();
    for (const capture of options.captures) {
      const previous = captures.get(capture.name);
      if (previous !== undefined && previous.capture !== capture.capture) {
        throw new RangeError(`Conflicting capture name ${capture.name}`);
      }
      captures.set(capture.name, capture);
    }
    this.#captures = captures;
  }

  parse(groupSyntax: GroupSyntax): ParseTemplateResult {
    const template = this.#sequence(
      groupSyntax.children,
      0,
      groupSyntax.origin,
      undefined,
    );
    return Object.freeze({
      template,
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  /**
   * Whether a `#name` stands where TypeScript writes a private identifier
   * rather than where the template language writes an operation.
   *
   * `#` is TypeScript's own syntax as well as the template language's, and the
   * two collide on the names the operations use. A class in a template that
   * declares `#count(value: number)` or calls `this.#count(1)` was read as the
   * `#count` operation, which then reported that its argument was invalid and
   * left the class unexpanded. Where a private identifier is what TypeScript
   * would read there -- after a `.`, or naming a member the class declares --
   * it is left alone.
   */
  #privateIdentifierPosition(nodes: readonly Syntax[], index: number): boolean {
    const previous = nodes[index - 1];
    if (token(previous, ".") || token(previous, "?.")) return true;
    // `#name(parameters) { body }` declares a method. No operation is written
    // with a block after its arguments: `#fold` and `#syntax`, the two that
    // take one, are read before this.
    return (
      group(nodes[index + 1], "parenthesis") && group(nodes[index + 2], "brace")
    );
  }

  #sequence(
    nodes: readonly Syntax[],
    depth: number,
    origin: OriginId,
    fold: FoldParserContext | undefined,
    quoted = false,
  ): SequenceTemplate {
    const elements: TemplateNode[] = [];
    let index = 0;
    while (index < nodes.length) {
      const current = nodes[index]!;
      const operationName =
        token(current) && current.raw.startsWith("#")
          ? current.raw.slice(1)
          : undefined;
      const memberAccess =
        token(nodes[index - 1], ".") || token(nodes[index - 1], "?.");
      const compactSyntaxQuote =
        !memberAccess &&
        operationName === "syntax" &&
        group(nodes[index + 1], "brace");
      const splitSyntaxQuote =
        token(current, "#") &&
        token(nodes[index + 1], "syntax") &&
        group(nodes[index + 2], "brace");
      if (compactSyntaxQuote || splitSyntaxQuote) {
        const body = nodes[index + (compactSyntaxQuote ? 1 : 2)] as GroupSyntax;
        elements.push(createLiteralTemplate(current));
        if (splitSyntaxQuote)
          elements.push(createLiteralTemplate(nodes[index + 1]!));
        elements.push(
          createGroupTemplate(
            body.origin,
            body.delimiter,
            this.#sequence(body.children, depth, body.origin, fold, true),
            body.open,
            body.close,
            body.scopes,
          ),
        );
        index += compactSyntaxQuote ? 2 : 3;
        continue;
      }
      if (
        !memberAccess &&
        operationName === "fold" &&
        group(nodes[index + 1], "parenthesis") &&
        group(nodes[index + 2], "brace")
      ) {
        const argumentsGroup = nodes[index + 1] as GroupSyntax;
        const foldGroup = nodes[index + 2] as GroupSyntax;
        const resolved = this.#resolveConditionalPath(
          argumentsGroup.children,
          0,
        );
        const tail =
          resolved === undefined
            ? []
            : argumentsGroup.children.slice(resolved.next);
        const initialGroup = tail[3];
        const parameters = foldGroup.children[0];
        const arrow = foldGroup.children[1];
        const bodyGroup = foldGroup.children[2];
        const parameterRaws = group(parameters, "parenthesis")
          ? parameters.children
              .filter((child): child is TokenSyntax => token(child))
              .map((child) => child.raw)
          : [];
        const elementShape =
          resolved === undefined
            ? undefined
            : elementShapeAtDepth(resolved.shape, depth + 1);
        const valid =
          resolved !== undefined &&
          elementShape !== undefined &&
          token(tail[0], ",") &&
          token(tail[1], "init") &&
          token(tail[2], ":") &&
          group(initialGroup, "brace") &&
          parameterRaws.join("") === "$acc,$item,$index" &&
          token(arrow, "=>") &&
          group(bodyGroup, "brace");
        if (!valid) {
          this.#diagnostic(
            invalidTemplateOperationCode,
            current.origin,
            operationName,
          );
        } else {
          elements.push(
            createFoldTemplate({
              origin: current.origin,
              driver: resolved.path,
              initial: this.#sequence(
                (initialGroup as GroupSyntax).children,
                depth,
                (initialGroup as GroupSyntax).origin,
                fold,
              ),
              body: this.#sequence(
                (bodyGroup as GroupSyntax).children,
                depth,
                (bodyGroup as GroupSyntax).origin,
                { elementShape },
              ),
            }),
          );
        }
        index += 3;
        continue;
      }
      if (
        operationName !== undefined &&
        [
          "fresh",
          "metavar",
          "callsite",
          "definition",
          "capture",
          "text",
          "trim",
          "count",
          "join",
          "index",
        ].includes(operationName) &&
        group(nodes[index + 1], "parenthesis") &&
        !this.#privateIdentifierPosition(nodes, index)
      ) {
        const argumentsGroup = nodes[index + 1] as GroupSyntax;
        if (operationName === "join") {
          const resolved = parseIdentifierJoinArguments(
            argumentsGroup.children,
            (start) =>
              this.#resolveConditionalPath(argumentsGroup.children, start),
          );
          const allowedClasses = this.#options.identifierClassIds;
          const valid =
            resolved !== undefined &&
            captureShapeDepth(resolved.shape) <= depth &&
            identifierAffixesAreValid(resolved.prefix, resolved.suffix) &&
            (allowedClasses === undefined ||
              allowedClasses.includes(baseLeaf(resolved.shape).classId));
          if (!valid) {
            this.#diagnostic(
              invalidTemplateOperationCode,
              current.origin,
              operationName,
            );
          } else {
            elements.push(
              createHygieneOperationTemplate(
                current.origin,
                {
                  kind: "join",
                  spec: {
                    path: resolved.path,
                    prefix: resolved.prefix,
                    suffix: resolved.suffix,
                    casing: resolved.casing,
                  },
                },
                resolved.shape,
                current as TokenSyntax,
              ),
            );
          }
        } else if (operationName === "metavar") {
          const hint = argumentsGroup.children[0];
          const resolved = this.#resolveConditionalPath(
            argumentsGroup.children,
            2,
          );
          const valid =
            token(hint) &&
            hint.kind === "string-literal" &&
            typeof hint.value === "string" &&
            isIdentifierText(hint.value) &&
            token(argumentsGroup.children[1], ",") &&
            resolved !== undefined &&
            resolved.next === argumentsGroup.children.length;
          if (!valid) {
            this.#diagnostic(
              invalidTemplateOperationCode,
              current.origin,
              operationName,
            );
          } else {
            elements.push(
              createHygieneOperationTemplate(
                current.origin,
                {
                  kind: "metavar",
                  hint: hint.value as string,
                  path: resolved.path,
                },
                resolved.shape,
                current as TokenSyntax,
              ),
            );
          }
        } else if (operationName === "fresh") {
          const hint = argumentsGroup.children[0];
          if (
            !token(hint) ||
            hint.kind !== "string-literal" ||
            typeof hint.value !== "string" ||
            // The hint becomes the introduced name, so it has to be one. Only
            // its emptiness was checked, and `#fresh("has space")` printed a
            // name that was two -- reported by TypeScript as a syntax error in
            // generated code rather than against the template that wrote it.
            !isIdentifierText(hint.value) ||
            argumentsGroup.children.length !== 1
          ) {
            this.#diagnostic(
              invalidTemplateOperationCode,
              current.origin,
              operationName,
            );
          } else {
            elements.push(
              createHygieneOperationTemplate(
                current.origin,
                { kind: "fresh", hint: hint.value },
                undefined,
                current as TokenSyntax,
              ),
            );
          }
        } else if (operationName === "index") {
          if (argumentsGroup.children.length !== 0 || depth === 0) {
            this.#diagnostic(
              invalidTemplateOperationCode,
              current.origin,
              operationName,
            );
          } else {
            elements.push(
              createHygieneOperationTemplate(
                current.origin,
                { kind: "index" },
                undefined,
                current as TokenSyntax,
              ),
            );
          }
        } else {
          const resolved = this.#resolveConditionalPath(
            argumentsGroup.children,
            0,
          );
          const identifierOnly = !["text", "trim", "count"].includes(
            operationName,
          );
          const allowedClasses = this.#options.identifierClassIds;
          const valid =
            resolved !== undefined &&
            resolved.next === argumentsGroup.children.length &&
            (operationName === "count" ||
              captureShapeDepth(resolved.shape) <= depth) &&
            (!identifierOnly ||
              allowedClasses === undefined ||
              allowedClasses.includes(baseLeaf(resolved.shape).classId));
          if (!valid) {
            this.#diagnostic(
              invalidTemplateOperationCode,
              current.origin,
              operationName,
            );
          } else {
            elements.push(
              createHygieneOperationTemplate(
                current.origin,
                {
                  kind: operationName as
                    | "callsite"
                    | "definition"
                    | "capture"
                    | "text"
                    | "trim"
                    | "count",
                  path: resolved.path,
                },
                // `#count` collapses the innermost dimension, and drives the
                // repetitions outside it. The rest select the element being
                // repeated and so drive the repetition around them.
                operationName === "count"
                  ? shapeWithoutInnermost(resolved.shape)
                  : resolved.shape,
                current as TokenSyntax,
              ),
            );
          }
        }
        index += 2;
        continue;
      }
      const compactIf = !memberAccess && token(current, "#if");
      const splitIf =
        !memberAccess && token(current, "#") && token(nodes[index + 1], "if");
      const predicateIndex = index + (compactIf ? 1 : 2);
      if (
        (compactIf || splitIf) &&
        group(nodes[predicateIndex], "parenthesis") &&
        group(nodes[predicateIndex + 1], "brace")
      ) {
        const predicateGroup = nodes[predicateIndex] as GroupSyntax;
        const consequentGroup = nodes[predicateIndex + 1] as GroupSyntax;
        const predicateKind = predicateGroup.children[0];
        const predicateCapture = predicateGroup.children[1];
        const resolved = this.#resolveConditionalPath(
          predicateGroup.children,
          1,
        );
        // `alternative` was a second predicate, asking which of a pattern's
        // choices a capture took. Nothing on the matching side ever recorded
        // that, so it was always answered no and the `#else` branch was taken
        // for every input. A syntax class with a rule per shape and an optional
        // field for each answers the same question and does work, so the
        // predicate that did not is gone rather than kept beside it.
        const unsupportedAlternative =
          token(predicateKind) && predicateKind.raw === "alternative";
        if (
          resolved === undefined ||
          !token(predicateKind) ||
          predicateKind.raw !== "present" ||
          // The predicate is the whole of the group. Reading a capture path and
          // stopping there left whatever followed it unexamined, so
          // `#if(present $value and then some)` was accepted as
          // `#if(present $value)` and the rest silently discarded.
          resolved.next !== predicateGroup.children.length
        ) {
          this.#diagnostic(
            malformedTemplateCode,
            predicateCapture?.origin ?? predicateGroup.origin,
            unsupportedAlternative
              ? "conditional requires present $capture; to branch on which shape a capture matched, give a syntax class one rule per shape and test an optional field of it"
              : "conditional requires present $capture",
          );
          elements.push(createLiteralTemplate(current));
          index = predicateIndex + 2;
          continue;
        }
        const predicate = Object.freeze({
          kind: "present" as const,
          path: resolved.path,
        });
        let next = predicateIndex + 2;
        let alternate: SequenceTemplate | undefined;
        const compactElse = token(nodes[next], "#else");
        const splitElse =
          token(nodes[next], "#") && token(nodes[next + 1], "else");
        const alternateIndex = next + (compactElse ? 1 : 2);
        if (
          (compactElse || splitElse) &&
          group(nodes[alternateIndex], "brace")
        ) {
          const alternateGroup = nodes[alternateIndex] as GroupSyntax;
          alternate = this.#sequence(
            alternateGroup.children,
            depth,
            alternateGroup.origin,
            fold,
          );
          next = alternateIndex + 1;
        }
        elements.push(
          createConditionalTemplate({
            origin: current.origin,
            predicate,
            consequent: this.#sequence(
              consequentGroup.children,
              depth,
              consequentGroup.origin,
              fold,
            ),
            alternate,
          }),
        );
        index = next;
        continue;
      }
      if (token(current, "$") && group(nodes[index + 1], "parenthesis")) {
        const repeatedGroup = nodes[index + 1] as GroupSyntax;
        let quantifierIndex = index + 2;
        let separator: TemplateNode | undefined;
        if (
          !token(nodes[quantifierIndex], "*") &&
          !token(nodes[quantifierIndex], "+")
        ) {
          const separatorSyntax = nodes[quantifierIndex];
          if (separatorSyntax !== undefined) {
            separator = this.#atom(separatorSyntax, depth, fold, quoted);
            quantifierIndex += 1;
          }
        }
        if (
          !token(nodes[quantifierIndex], "*") &&
          !token(nodes[quantifierIndex], "+")
        ) {
          this.#diagnostic(
            malformedTemplateCode,
            current.origin,
            "repetition requires * or +",
          );
          elements.push(createLiteralTemplate(current));
          index += 1;
          continue;
        }
        const repetitionDepth = depth + 1;
        const body = this.#sequence(
          repeatedGroup.children,
          repetitionDepth,
          repeatedGroup.origin,
          fold,
          quoted,
        );
        const drivers = this.#drivers(body, repetitionDepth);
        const groups = new Set(
          drivers.flatMap((capture) => {
            const cardinality = cardinalityAtDepth(
              capture.shape,
              repetitionDepth,
            );
            return cardinality === undefined ? [] : [cardinality];
          }),
        );
        if (quoted && (drivers.length === 0 || groups.size === 0)) {
          elements.push(createLiteralTemplate(current));
          elements.push(
            createGroupTemplate(
              repeatedGroup.origin,
              repeatedGroup.delimiter,
              body,
              repeatedGroup.open,
              repeatedGroup.close,
              repeatedGroup.scopes,
            ),
          );
          if (separator !== undefined) elements.push(separator);
          elements.push(createLiteralTemplate(nodes[quantifierIndex]!));
          index = quantifierIndex + 1;
          continue;
        }
        if (drivers.length === 0 || groups.size === 0) {
          this.#diagnostic(
            missingTemplateDriverCode,
            current.origin,
            repetitionDepth,
          );
        } else if (groups.size > 1) {
          this.#diagnostic(
            incompatibleTemplateDriversCode,
            current.origin,
            repetitionDepth,
          );
        }
        elements.push(
          createRepeatTemplate({
            origin: current.origin,
            body,
            separator,
            depth: repetitionDepth,
            cardinalityGroup:
              groups.size === 1 ? groups.values().next().value : undefined,
            drivers: drivers.map((capture) => capture.path),
          }),
        );
        index = quantifierIndex + 1;
        continue;
      }
      if (
        fold !== undefined &&
        token(current) &&
        ["$acc", "$item", "$index"].includes(current.raw)
      ) {
        if (current.raw === "$item") {
          let shape = fold.elementShape;
          const fields: {
            readonly name: string;
            readonly capture: CaptureId;
          }[] = [];
          let next = index + 1;
          while (token(nodes[next], ".") && token(nodes[next + 1])) {
            const fieldToken = nodes[next + 1] as TokenSyntax;
            const leaf = baseLeaf(shape);
            const field = this.#options
              .fieldsForClass?.(leaf.classId)
              ?.find((candidate) => candidate.name === fieldToken.raw);
            const fieldShape =
              field === undefined ? undefined : leaf.fields.get(field.capture);
            if (field === undefined || fieldShape === undefined) {
              this.#diagnostic(
                unknownTemplateFieldCode,
                fieldToken.origin,
                fieldToken.raw,
              );
              break;
            }
            fields.push(
              Object.freeze({ name: field.name, capture: field.capture }),
            );
            shape = projectFieldShape(shape, fieldShape);
            next += 2;
          }
          if (captureShapeDepth(shape) > 0) {
            this.#diagnostic(
              invalidTemplateOperationCode,
              current.origin,
              "fold",
            );
          }
          elements.push(
            createLocalTemplate({
              origin: current.origin,
              local: "element",
              fields,
              leadingTrivia: current.leadingTrivia,
            }),
          );
          index = next;
        } else {
          elements.push(
            createLocalTemplate({
              origin: current.origin,
              local: current.raw === "$acc" ? "accumulator" : "index",
              leadingTrivia: current.leadingTrivia,
            }),
          );
          index += 1;
        }
        continue;
      }
      if (
        token(current) &&
        (current.kind === "identifier" || current.kind === "jsx-identifier") &&
        current.raw.startsWith("$") &&
        current.raw.length > 1
      ) {
        const captureName = current.raw.slice(1);
        const binding = this.#captures.get(captureName);
        if (binding === undefined) {
          if (!quoted)
            this.#diagnostic(
              unknownTemplateCaptureCode,
              current.origin,
              captureName,
            );
          elements.push(createLiteralTemplate(current));
          index += 1;
          continue;
        }
        let shape = binding.shape;
        const fields: { readonly name: string; readonly capture: CaptureId }[] =
          [];
        let next = index + 1;
        while (token(nodes[next], ".") && token(nodes[next + 1])) {
          const fieldToken = nodes[next + 1] as TokenSyntax;
          const leaf = baseLeaf(shape);
          const declaredFields = this.#options.fieldsForClass?.(leaf.classId);
          // External and built-in syntax classes have no declarative fields.
          // In an ordinary template `$value.property` must therefore splice the
          // capture and preserve `.property` as TypeScript syntax. A known user
          // syntax class, by contrast, makes the dotted form a field path.
          if (declaredFields === undefined) break;
          const field = declaredFields.find(
            (candidate) => candidate.name === fieldToken.raw,
          );
          const fieldShape =
            field === undefined ? undefined : leaf.fields.get(field.capture);
          if (field === undefined || fieldShape === undefined) {
            this.#diagnostic(
              unknownTemplateFieldCode,
              fieldToken.origin,
              fieldToken.raw,
            );
            break;
          }
          fields.push(
            Object.freeze({ name: field.name, capture: field.capture }),
          );
          shape = projectFieldShape(shape, fieldShape);
          next += 2;
        }
        if (captureShapeDepth(shape) > depth) {
          this.#diagnostic(
            templateCaptureDepthCode,
            current.origin,
            captureName,
            captureShapeDepth(shape),
          );
        }
        elements.push(
          createCaptureTemplate(
            current.origin,
            createCapturePath(captureName, binding.capture, fields),
            shape,
            current.leadingTrivia,
          ),
        );
        index = next;
        continue;
      }
      // A `#name(` that reached here names no operation the template language
      // has. It used to be printed into the expansion as written, where `#`
      // is TypeScript's private-identifier syntax -- so a misspelled `#coutn`
      // was reported as "private identifiers are not allowed outside class
      // bodies", pointing at generated code the author never wrote.
      if (
        operationName !== undefined &&
        operationName.length > 0 &&
        !templateOperations.has(operationName) &&
        group(nodes[index + 1], "parenthesis") &&
        !this.#privateIdentifierPosition(nodes, index)
      ) {
        this.#diagnostic(
          unknownTemplateOperationCode,
          current.origin,
          operationName,
        );
      }
      elements.push(this.#atom(current, depth, fold, quoted));
      index += 1;
    }
    return createSequenceTemplate(origin, elements);
  }

  #atom(
    node: Syntax,
    depth: number,
    fold: FoldParserContext | undefined,
    quoted = false,
  ): TemplateNode {
    if (group(node)) {
      return createGroupTemplate(
        node.origin,
        node.delimiter,
        this.#sequence(node.children, depth, node.origin, fold, quoted),
        node.open,
        node.close,
        node.scopes,
      );
    }
    return createLiteralTemplate(node);
  }

  #resolveConditionalPath(
    nodes: readonly Syntax[],
    index: number,
  ):
    | {
        readonly path: ReturnType<typeof createCapturePath>;
        readonly shape: CaptureShape;
        readonly next: number;
      }
    | undefined {
    const current = nodes[index];
    if (
      !token(current) ||
      (current.kind !== "identifier" && current.kind !== "jsx-identifier") ||
      !current.raw.startsWith("$") ||
      current.raw.length < 2
    ) {
      return undefined;
    }
    const captureName = current.raw.slice(1);
    const binding = this.#captures.get(captureName);
    if (binding === undefined) {
      this.#diagnostic(unknownTemplateCaptureCode, current.origin, captureName);
      return undefined;
    }
    let shape = binding.shape;
    const fields: { readonly name: string; readonly capture: CaptureId }[] = [];
    let next = index + 1;
    while (token(nodes[next], ".") && token(nodes[next + 1])) {
      const fieldToken = nodes[next + 1] as TokenSyntax;
      const leaf = baseLeaf(shape);
      const field = this.#options
        .fieldsForClass?.(leaf.classId)
        ?.find((candidate) => candidate.name === fieldToken.raw);
      const fieldShape =
        field === undefined ? undefined : leaf.fields.get(field.capture);
      if (field === undefined || fieldShape === undefined) {
        this.#diagnostic(
          unknownTemplateFieldCode,
          fieldToken.origin,
          fieldToken.raw,
        );
        return undefined;
      }
      fields.push(Object.freeze({ name: field.name, capture: field.capture }));
      shape = projectFieldShape(shape, fieldShape);
      next += 2;
    }
    return Object.freeze({
      path: createCapturePath(captureName, binding.capture, fields),
      shape,
      next,
    });
  }

  #drivers(
    template: TemplateNode,
    depth: number,
  ): readonly Pick<CaptureTemplate, "path" | "shape">[] {
    const captures: Pick<CaptureTemplate, "path" | "shape">[] = [];
    const stack: TemplateNode[] = [template];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.kind === "capture") {
        if (captureShapeDepth(current.shape) >= depth) captures.push(current);
      } else if (
        current.kind === "operation" &&
        current.driverShape !== undefined &&
        captureShapeDepth(current.driverShape) >= depth
      ) {
        const path =
          current.operation.kind === "join"
            ? current.operation.spec.path
            : "path" in current.operation
              ? current.operation.path
              : undefined;
        if (path !== undefined) {
          captures.push({ path, shape: current.driverShape });
        }
      } else if (current.kind === "sequence") {
        stack.push(...[...current.elements].reverse());
      } else if (current.kind === "group") {
        stack.push(current.body);
      } else if (current.kind === "repeat") {
        stack.push(current.body);
      } else if (current.kind === "conditional") {
        if (current.alternate !== undefined) stack.push(current.alternate);
        stack.push(current.consequent);
      }
    }
    return captures;
  }

  #diagnostic(
    code:
      | typeof unknownTemplateCaptureCode
      | typeof unknownTemplateFieldCode
      | typeof templateCaptureDepthCode
      | typeof missingTemplateDriverCode
      | typeof incompatibleTemplateDriversCode
      | typeof malformedTemplateCode
      | typeof invalidTemplateOperationCode,
    origin: OriginId,
    ...messageArguments: readonly (string | number)[]
  ): void {
    const span = this.#options.spanForOrigin(origin);
    this.#diagnostics.push(
      templateDiagnosticRegistry.create(code, {
        primaryOrigin: {
          sourceId: this.#options.sourceId,
          start: span.start,
          end: span.end,
          originId: origin,
        },
        messageArguments,
      }),
    );
  }
}

export function parseTemplate(
  groupSyntax: GroupSyntax,
  options: ParseTemplateOptions,
): ParseTemplateResult {
  return new TemplateParser(options).parse(groupSyntax);
}
