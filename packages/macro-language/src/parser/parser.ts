import {
  createCapturePattern,
  createChoicePattern,
  createGroupPattern,
  createLiteralPattern,
  createOptionalPattern,
  createRepeatPattern,
  createSequencePattern,
  createTokenLiteralKey,
  type PatternNode,
} from "@sweetener/pattern";
import {
  createIdAllocator,
  type CaptureId,
  type CardinalityGroupId,
  type DefinitionId,
  type Diagnostic,
  type OriginId,
  type RepetitionId,
  type RuleId,
  type SourceId,
  type SyntaxClassId,
} from "@sweetener/shared";
import type {
  GroupSyntax,
  RootSyntax,
  Syntax,
  SyntaxCategory,
  TokenSyntax,
} from "@sweetener/syntax";
import type {
  DefinitionClause,
  DefinitionField,
  MacroDefinition,
  MacroRule,
  OperatorDefinition,
  SyntaxClassDefinition,
  SyntaxDefinition,
  UnparsedTopLevel,
} from "./ast.js";
import { freezeSequence } from "./ast.js";
import {
  expectedDefinitionPartCode,
  macroLanguageDiagnosticRegistry,
  malformedPatternCode,
  unknownSyntaxCategoryCode,
} from "./diagnostics.js";

export interface ParseMacroDefinitionsOptions {
  readonly sourceId: SourceId;
}

export interface ParseMacroDefinitionsResult {
  readonly definitions: readonly MacroDefinition[];
  readonly classBindings: readonly {
    readonly name: string;
    readonly classId: SyntaxClassId;
  }[];
  readonly unparsed: readonly UnparsedTopLevel[];
  readonly diagnostics: readonly Diagnostic[];
}

const categories = new Set<SyntaxCategory>([
  "item",
  "stmt",
  "expr",
  "type",
  "binding",
  "classElement",
  "typeMember",
  "jsxChild",
  "token",
  "tt",
]);

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

function word(node: Syntax | undefined): node is TokenSyntax {
  return (
    token(node) &&
    (node.kind === "identifier" ||
      node.kind === "keyword" ||
      node.kind === "jsx-identifier")
  );
}

function frozen<T>(value: T): T {
  return Object.freeze(value);
}

/** Words that introduce a clause, and so end the clause written before them. */
const clauseKeywords: ReadonlySet<string> = new Set([
  "bind",
  "refine",
  "expect",
  "fixity",
  "associativity",
  "precedence",
  "literal",
  "context",
]);

class Parser {
  readonly #sourceId: SourceId;
  readonly #diagnostics: Diagnostic[] = [];
  readonly #definitions: MacroDefinition[] = [];
  readonly #unparsed: UnparsedTopLevel[] = [];
  readonly #definitionIds = createIdAllocator<DefinitionId>();
  readonly #ruleIds = createIdAllocator<RuleId>();
  readonly #captureIds = createIdAllocator<CaptureId>();
  readonly #classIds = createIdAllocator<SyntaxClassId>();
  readonly #repetitionIds = createIdAllocator<RepetitionId>();
  readonly #cardinalityIds = createIdAllocator<CardinalityGroupId>();
  readonly #classes = new Map<string, SyntaxClassId>();

  constructor(options: ParseMacroDefinitionsOptions) {
    this.#sourceId = options.sourceId;
    for (const name of [
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
    ]) {
      this.#classId(name);
    }
  }

  parse(root: RootSyntax): ParseMacroDefinitionsResult {
    const nodes = root.children;
    let index = 0;
    while (index < nodes.length) {
      const current = nodes[index];
      if (token(current) && current.kind === "end-of-file") break;
      const start = index;
      if (token(current, "import")) {
        this.#unparsed.push(
          frozen({ origin: current.origin, syntax: current }),
        );
        while (index < nodes.length) {
          const imported = nodes[index++];
          if (
            (imported?.tag === "token" && imported.raw === ";") ||
            (imported?.tag === "token" && imported.kind === "end-of-file")
          )
            break;
        }
        continue;
      }
      let exported = false;
      if (token(nodes[index], "export")) {
        exported = true;
        index += 1;
      }
      let recursive = false;
      if (token(nodes[index], "rec")) {
        recursive = true;
        index += 1;
      }
      const keyword = nodes[index];
      let attemptedDefinition = false;
      if (token(keyword, "syntax")) {
        attemptedDefinition = true;
        const result = this.#parseSyntax(nodes, index + 1, exported, recursive);
        if (result !== undefined) {
          this.#definitions.push(result.definition);
          index = result.next;
          continue;
        }
      } else if (token(keyword, "operator")) {
        attemptedDefinition = true;
        const result = this.#parseOperator(nodes, index + 1, exported);
        if (result !== undefined) {
          this.#definitions.push(result.definition);
          index = result.next;
          continue;
        }
      }
      const syntax = nodes[start];
      if (syntax !== undefined) {
        this.#unparsed.push(frozen({ origin: syntax.origin, syntax }));
      }
      index = attemptedDefinition
        ? this.#nextDefinitionStart(nodes, index + 1)
        : start + 1;
    }
    return frozen({
      definitions: Object.freeze([...this.#definitions]),
      classBindings: Object.freeze(
        [...this.#classes.entries()]
          .sort(([, left], [, right]) => left - right)
          .map(([name, classId]) => Object.freeze({ name, classId })),
      ),
      unparsed: Object.freeze([...this.#unparsed]),
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  #nextDefinitionStart(nodes: readonly Syntax[], start: number): number {
    for (let index = start; index < nodes.length; index += 1) {
      if (
        token(nodes[index], "export") ||
        token(nodes[index], "syntax") ||
        token(nodes[index], "operator")
      )
        return index;
    }
    return nodes.length;
  }

  #parseSyntax(
    nodes: readonly Syntax[],
    start: number,
    exported: boolean,
    recursive: boolean,
  ):
    | { definition: SyntaxDefinition | SyntaxClassDefinition; next: number }
    | undefined {
    let index = start;
    if (token(nodes[index], "class")) {
      const name = nodes[index + 1];
      const body = nodes[index + 2];
      if (!word(name) || !group(body, "brace")) {
        this.#expected(nodes[index] ?? name, "syntax class name and body");
        return undefined;
      }
      const parsed = this.#parseBody(body, true);
      return {
        definition: frozen({
          kind: "syntax-class",
          id: this.#definitionIds.allocate(),
          classId: this.#classId(name.raw),
          origin: nodes[start - 1]?.origin ?? name.origin,
          exported,
          recursive,
          name: name.raw,
          fields: parsed.fields,
          rules: parsed.rules,
          clauses: parsed.clauses,
          body,
        }),
        next: index + 3,
      };
    }
    const nameSyntax = nodes[index];
    const nameGroup = group(nameSyntax, "parenthesis") ? nameSyntax : undefined;
    const nameIsWord = word(nameSyntax);
    const colon = nodes[index + 1];
    const categoryNode = nodes[index + 2];
    if (
      (nameGroup === undefined && !nameIsWord) ||
      !token(colon, ":") ||
      !token(categoryNode)
    ) {
      this.#expected(nameSyntax, "macro name and category");
      return undefined;
    }
    const name =
      nameGroup !== undefined
        ? nameGroup.children
            .filter((child): child is TokenSyntax => child.tag === "token")
            .map((child) => child.raw)
            .join("")
        : (nameSyntax as TokenSyntax).raw;
    if (name.length === 0) {
      this.#expected(nameSyntax, "nonempty macro name");
      return undefined;
    }
    const category = this.#category(categoryNode);
    index += 3;
    const shadowsCore =
      token(nodes[index], "shadows") && token(nodes[index + 1], "core");
    if (shadowsCore) index += 2;
    const body = nodes[index];
    if (!group(body, "brace")) {
      this.#expected(body ?? categoryNode, "macro definition body");
      return undefined;
    }
    const parsed = this.#parseBody(body, false);
    return {
      definition: frozen({
        kind: "syntax",
        id: this.#definitionIds.allocate(),
        origin: nodes[start - 1]?.origin ?? (nameSyntax as Syntax).origin,
        exported,
        recursive,
        name,
        category,
        shadowsCore,
        rules: parsed.rules,
        clauses: parsed.clauses,
        body,
      }),
      next: index + 1,
    };
  }

  #parseOperator(
    nodes: readonly Syntax[],
    start: number,
    exported: boolean,
  ): { definition: OperatorDefinition; next: number } | undefined {
    const spellingSyntax = nodes[start];
    const spellingGroup = group(spellingSyntax, "parenthesis")
      ? spellingSyntax
      : undefined;
    const spellingIsWord = word(spellingSyntax);
    const colon = nodes[start + 1];
    const categoryNode = nodes[start + 2];
    if (
      (spellingGroup === undefined && !spellingIsWord) ||
      !token(colon, ":") ||
      !token(categoryNode)
    ) {
      this.#expected(spellingSyntax, "operator spelling and category");
      return undefined;
    }
    const category = this.#category(categoryNode);
    let index = start + 3;
    const shadowsCore =
      token(nodes[index], "shadows") && token(nodes[index + 1], "core");
    if (shadowsCore) index += 2;
    const body = nodes[index];
    if (!group(body, "brace")) {
      this.#expected(body ?? categoryNode, "operator definition body");
      return undefined;
    }
    const parsed = this.#parseBody(body, false);
    const spelling =
      spellingGroup !== undefined
        ? spellingGroup.children
            .filter((child): child is TokenSyntax => child.tag === "token")
            .map((child) => child.raw)
            .join("")
        : (spellingSyntax as TokenSyntax).raw;
    return {
      definition: frozen({
        kind: "operator",
        id: this.#definitionIds.allocate(),
        origin: nodes[start - 1]?.origin ?? (spellingSyntax as Syntax).origin,
        exported,
        spelling,
        category,
        shadowsCore,
        rules: parsed.rules,
        clauses: parsed.clauses,
        body,
      }),
      next: index + 1,
    };
  }

  #parseBody(
    body: GroupSyntax,
    allowFields: boolean,
  ): {
    fields: readonly DefinitionField[];
    rules: readonly MacroRule[];
    clauses: readonly DefinitionClause[];
  } {
    const fields: DefinitionField[] = [];
    const rules: MacroRule[] = [];
    const clauses: DefinitionClause[] = [];
    const nodes = body.children;
    let index = 0;
    while (index < nodes.length) {
      const possibleFields = nodes[index + 1];
      if (
        allowFields &&
        token(nodes[index], "fields") &&
        group(possibleFields, "brace")
      ) {
        fields.push(...this.#parseFields(possibleFields));
        index += 2;
        continue;
      }
      const fallback =
        token(nodes[index], "fallback") && token(nodes[index + 1], "rule");
      if (fallback) index += 1;
      if (token(nodes[index], "rule")) {
        const patternGroup = nodes[index + 1];
        if (!group(patternGroup, "brace")) {
          this.#expected(patternGroup ?? nodes[index], "rule pattern group");
          index += 1;
          continue;
        }
        index += 2;
        const tailStart = index;
        while (
          index < nodes.length &&
          !token(nodes[index], "rule") &&
          !(token(nodes[index], "fallback") && token(nodes[index + 1], "rule"))
        )
          index += 1;
        const tail = nodes.slice(tailStart, index);
        let arrow = tail.findIndex((node) => token(node, "=>"));
        if (arrow < 0) arrow = tail.length;
        const possibleTemplate = tail[arrow + 1];
        const template = group(possibleTemplate, "brace")
          ? possibleTemplate
          : undefined;
        rules.push(
          frozen({
            id: this.#ruleIds.allocate(),
            origin: patternGroup.origin,
            fallback,
            patternGroup,
            pattern: this.#parsePatternSequence(
              patternGroup.children,
              0,
              new Map(),
            ),
            clauses: this.#parseClauses(tail.slice(0, arrow)),
            template,
          }),
        );
        continue;
      }
      const next = this.#nextBodyBoundary(nodes, index + 1);
      clauses.push(...this.#parseClauses(nodes.slice(index, next)));
      index = next;
    }
    return {
      fields: Object.freeze(fields),
      rules: Object.freeze(rules),
      clauses: Object.freeze(clauses),
    };
  }

  #nextBodyBoundary(nodes: readonly Syntax[], start: number): number {
    let index = start;
    while (index < nodes.length) {
      if (
        token(nodes[index], "rule") ||
        (token(nodes[index], "fallback") && token(nodes[index + 1], "rule"))
      )
        break;
      index += 1;
    }
    return index;
  }

  #parseFields(body: GroupSyntax): readonly DefinitionField[] {
    const fields: DefinitionField[] = [];
    const nodes = body.children;
    let index = 0;
    while (index < nodes.length) {
      const name = nodes[index];
      const colon = nodes[index + 1];
      const className = nodes[index + 2];
      if (
        !token(name) ||
        name.kind !== "identifier" ||
        !token(colon, ":") ||
        !token(className)
      ) {
        this.#expected(name, "field declaration");
        index += 1;
        continue;
      }
      let end = index + 3;
      const repeated = token(nodes[end], "*");
      if (repeated) end += 1;
      const optional = !repeated && token(nodes[end], "?");
      if (optional) end += 1;
      if (token(nodes[end], ";")) end += 1;
      fields.push(
        frozen({
          origin: name.origin,
          capture: this.#captureIds.allocate(),
          name: name.raw,
          classId: this.#classId(className.raw),
          className: className.raw,
          repeated,
          optional,
          syntax: freezeSequence(nodes.slice(index, end)),
        }),
      );
      index = end;
    }
    return Object.freeze(fields);
  }

  #parseClauses(nodes: readonly Syntax[]): readonly DefinitionClause[] {
    const segments: Syntax[][] = [[]];
    for (const node of nodes) {
      // A clause ends at its `;`, and also where the next one begins. Splitting
      // on `;` alone folded a clause that followed an unterminated one into it:
      //
      //   rule { matchBind($subject:expr, $name:binding); }
      //   refine $name spelling starts-with-lowercase
      //   bind $name in following as lexical value;
      //
      // read as a single refinement whose predicate ran on past
      // `starts-with-lowercase`, so it parsed as neither clause -- the rule
      // matched anything it was refined to exclude, and the binding contract
      // was dropped, with nothing said about either.
      //
      // A keyword only begins a clause where a clause could begin. One spelled
      // inside a clause stands in a group or a string, neither of which is a
      // token here.
      if (
        segments.at(-1)!.length > 0 &&
        token(node) &&
        clauseKeywords.has(node.raw)
      )
        segments.push([]);
      segments.at(-1)!.push(node);
      if (token(node, ";")) segments.push([]);
    }
    return Object.freeze(
      segments.flatMap((syntax) => {
        const first = syntax[0];
        if (first === undefined) return [];
        const keyword = token(first) ? first.raw : "";
        const kind: DefinitionClause["kind"] =
          keyword === "bind"
            ? "binding"
            : keyword === "refine"
              ? "refinement"
              : keyword === "expect"
                ? "diagnostic"
                : [
                      "fixity",
                      "associativity",
                      "precedence",
                      "literal",
                      "context",
                    ].includes(keyword)
                  ? "property"
                  : "unknown";
        return [
          frozen({
            origin: first.origin,
            kind,
            keyword,
            syntax: freezeSequence(syntax),
          }),
        ];
      }),
    );
  }

  #parsePatternSequence(
    nodes: readonly Syntax[],
    depth: number,
    captures: Map<string, CaptureId>,
  ): PatternNode {
    const alternatives: PatternNode[][] = [[]];
    let index = 0;
    while (index < nodes.length) {
      const current = nodes[index];
      // A `|` between alternatives is written with space on either side of it,
      // which is what tells it from a `|` the pattern matches literally --
      // `$name |= ...` matches an assignment operator. Only the space after it
      // was asked about, so the rule read backwards for one of the two
      // one-sided spellings: `$x:tt| $y:tt` was a choice and `$x:tt |$y:tt` was
      // a literal, neither of which anyone writes on purpose.
      const previous = nodes[index - 1];
      if (
        token(current, "|") &&
        alternatives.at(-1)?.length &&
        previous !== undefined &&
        current.span.start > previous.span.end &&
        nodes[index + 1] !== undefined &&
        nodes[index + 1]!.span.start > current.span.end
      ) {
        alternatives.push([]);
        index += 1;
        continue;
      }
      if (token(current, "$") && group(nodes[index + 1], "parenthesis")) {
        const repeatedGroup = nodes[index + 1] as GroupSyntax;
        let quantifierIndex = index + 2;
        let separator: PatternNode | undefined;
        if (
          !token(nodes[quantifierIndex], "*") &&
          !token(nodes[quantifierIndex], "+") &&
          !token(nodes[quantifierIndex], "?")
        ) {
          const separatorSyntax = nodes[quantifierIndex];
          if (separatorSyntax !== undefined) {
            separator = this.#parsePatternAtom(
              separatorSyntax,
              depth,
              captures,
            );
            quantifierIndex += 1;
          }
        }
        const quantifier = nodes[quantifierIndex];
        if (!token(quantifier) || !["*", "+", "?"].includes(quantifier.raw)) {
          this.#malformed(current, "repetition requires *, +, or ?");
          alternatives
            .at(-1)
            ?.push(this.#parsePatternAtom(current, depth, captures));
          index += 1;
          continue;
        }
        const body = this.#parsePatternSequence(
          repeatedGroup.children,
          depth + 1,
          captures,
        );
        const cardinalityGroup = this.#cardinalityIds.allocate();
        const repeated =
          quantifier.raw === "?"
            ? createOptionalPattern({
                origin: current.origin,
                repetition: this.#repetitionIds.allocate(),
                body,
                depth: depth + 1,
                cardinalityGroup,
              })
            : createRepeatPattern({
                origin: current.origin,
                repetition: this.#repetitionIds.allocate(),
                body,
                separator,
                minimum: quantifier.raw === "+" ? 1 : 0,
                depth: depth + 1,
                cardinalityGroup,
              });
        alternatives.at(-1)?.push(repeated);
        index = quantifierIndex + 1;
        continue;
      }
      if (
        token(current) &&
        (current.kind === "identifier" || current.kind === "jsx-identifier") &&
        current.raw.startsWith("$")
      ) {
        // TypeScript scans a JSX namespace-shaped name such as
        // `$component:ident` as one JSX identifier, while ordinary macro
        // captures arrive as the three tokens `$component`, `:`, `ident`.
        const inlineColon =
          current.kind === "jsx-identifier" ? current.raw.indexOf(":") : -1;
        const possibleClassName = nodes[index + 2];
        let captureName: string;
        let className: string;
        let captureWidth: number;
        if (inlineColon > 1 && inlineColon < current.raw.length - 1) {
          captureName = current.raw.slice(1, inlineColon);
          className = current.raw.slice(inlineColon + 1);
          captureWidth = 1;
        } else {
          if (
            current.raw.length === 1 ||
            !token(nodes[index + 1], ":") ||
            !word(possibleClassName)
          ) {
            this.#malformed(current, "capture requires $name:class");
            alternatives
              .at(-1)
              ?.push(this.#parsePatternAtom(current, depth, captures));
            index += 1;
            continue;
          }
          captureName = current.raw.slice(1);
          className = possibleClassName.raw;
          captureWidth = 3;
        }
        let capture = captures.get(captureName);
        if (capture === undefined) {
          capture = this.#captureIds.allocate();
          captures.set(captureName, capture);
        }
        alternatives.at(-1)?.push(
          createCapturePattern({
            origin: current.origin,
            capture,
            name: captureName,
            classId: this.#classId(className),
          }),
        );
        index += captureWidth;
        continue;
      }
      if (current !== undefined)
        alternatives
          .at(-1)
          ?.push(this.#parsePatternAtom(current, depth, captures));
      index += 1;
    }
    const origin = nodes[0]?.origin ?? (0 as OriginId);
    const sequences = alternatives.map((elements) =>
      createSequencePattern(origin, elements),
    );
    return sequences.length === 1
      ? sequences[0]!
      : createChoicePattern(origin, sequences);
  }

  #parsePatternAtom(
    node: Syntax,
    depth: number,
    captures: Map<string, CaptureId>,
  ): PatternNode {
    if (group(node)) {
      const body = this.#parsePatternSequence(node.children, depth, captures);
      const sequence =
        body.kind === "sequence"
          ? body
          : createSequencePattern(node.origin, [body]);
      return createGroupPattern(node.origin, node.delimiter, sequence);
    }
    if (node.tag === "token") {
      return createLiteralPattern(
        node.origin,
        createTokenLiteralKey(node.kind, node.raw),
      );
    }
    return createSequencePattern(node.origin, []);
  }

  #classId(name: string): SyntaxClassId {
    const existing = this.#classes.get(name);
    if (existing !== undefined) return existing;
    const created = this.#classIds.allocate();
    this.#classes.set(name, created);
    return created;
  }

  #category(node: TokenSyntax): SyntaxCategory {
    if (categories.has(node.raw as SyntaxCategory))
      return node.raw as SyntaxCategory;
    this.#diagnostics.push(
      macroLanguageDiagnosticRegistry.create(unknownSyntaxCategoryCode, {
        primaryOrigin: this.#origin(node),
        messageArguments: [node.raw],
      }),
    );
    return "tt";
  }

  #expected(node: Syntax | undefined, expected: string): void {
    this.#diagnostics.push(
      macroLanguageDiagnosticRegistry.create(expectedDefinitionPartCode, {
        primaryOrigin: this.#origin(node),
        messageArguments: [expected],
      }),
    );
  }

  #malformed(node: Syntax, reason: string): void {
    this.#diagnostics.push(
      macroLanguageDiagnosticRegistry.create(malformedPatternCode, {
        primaryOrigin: this.#origin(node),
        messageArguments: [reason],
      }),
    );
  }

  #origin(node: Syntax | undefined): {
    sourceId: SourceId;
    start: number;
    end: number;
    originId?: OriginId;
  } {
    return node === undefined
      ? { sourceId: this.#sourceId, start: 0, end: 0 }
      : {
          sourceId: this.#sourceId,
          start: node.span.start,
          end: node.span.end,
          originId: node.origin,
        };
  }
}

export function parseMacroDefinitions(
  root: RootSyntax,
  options: ParseMacroDefinitionsOptions,
): ParseMacroDefinitionsResult {
  return new Parser(options).parse(root);
}
