import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSyntax } from "@sweetener/reader";
import {
  compileMatcherProgram,
  createSyntaxClassConsumer,
  executeMatcher,
  inferCaptureShapes,
  serializeMatcherProgram,
} from "@sweetener/pattern";
import type { ScopeSetId, SourceId } from "@sweetener/shared";
import { createSyntaxCursor } from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  compileParsedBindingContracts,
  compileParsedTemplates,
  compileParsedSyntaxClasses,
  parseMacroDefinitions,
} from "../src/index.js";

const sourceId = 41 as SourceId;
const scopes = 0 as ScopeSetId;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function parse(source: string) {
  const read = readSyntax(source, { sourceId, scopes });
  expect(read.diagnostics).toEqual([]);
  return parseMacroDefinitions(read.root, { sourceId });
}

describe("macro-definition parser", () => {
  it("recognizes captures in JSX tag and attribute-name positions", () => {
    const read = readSyntax(
      `export syntax jsx:expr {
        rule { jsx(<$component:token $prop:token={$value:expr} />) }
        => { <$component $prop={$value} /> }
      }`,
      { sourceId, scopes, variant: "jsx" },
    );
    expect(read.diagnostics).toEqual([]);
    const result = parseMacroDefinitions(read.root, { sourceId });

    expect(result.diagnostics).toEqual([]);
    expect(result.unparsed).toEqual([]);
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0]).toMatchObject({
      kind: "syntax",
      rules: [{ pattern: { kind: "sequence" } }],
    });
  });

  it("parses syntax parameters with and without rules", () => {
    const result = parse(`
      export syntax parameter (%):expr;
      syntax parameter it:expr { rule { it } => { 1 } }
      syntax parameter:expr { rule { parameter } => { 2 } }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.unparsed).toEqual([]);
    expect(result.definitions).toMatchObject([
      { kind: "syntax", parameter: true, name: "%", exported: true, rules: [] },
      { kind: "syntax", parameter: true, name: "it", rules: [{}] },
      { kind: "syntax", parameter: false, name: "parameter", rules: [{}] },
    ]);
    expect(result.definitions[0]).toMatchObject({ body: undefined });
  });

  it("parses syntax classes, fields, recursive macros, clauses, and templates", () => {
    const result = parse(`
      export syntax class BindClause {
        fields { name: binding; source: expr; }
        rule { $name:binding <- $source:expr; }
      }
      export rec syntax doSteps:expr shadows core {
        fallback rule { doSteps($monad:expr) { $($rest:tt),+ } }
        bind $monad in $rest as lexical value
        => { expand($monad, $($rest),+) }
      }
    `);

    expect(result.diagnostics).toEqual([]);
    expect(result.unparsed).toEqual([]);
    expect(result.definitions).toHaveLength(2);
    expect(result.definitions[0]).toMatchObject({
      kind: "syntax-class",
      exported: true,
      name: "BindClause",
      fields: [
        { name: "name", className: "binding", repeated: false },
        { name: "source", className: "expr", repeated: false },
      ],
      rules: [{ pattern: { kind: "sequence" } }],
    });
    expect(result.definitions[1]).toMatchObject({
      kind: "syntax",
      exported: true,
      recursive: true,
      name: "doSteps",
      category: "expr",
      shadowsCore: true,
      rules: [
        {
          fallback: true,
          clauses: [{ kind: "binding" }],
          template: { tag: "group", delimiter: "brace" },
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.definitions)).toBe(true);
  });

  it("lowers captures, literal groups, separated repetition, optionals, and choices", () => {
    const result = parse(`
      syntax example:expr {
        rule { head($first:expr) $($rest:tt),+ $($tail:tt)? left | right }
        => { output }
      }
    `);
    const definition = result.definitions[0];
    if (definition?.kind !== "syntax")
      throw new Error("expected syntax definition");
    const pattern = definition.rules[0]?.pattern;
    expect(pattern).toMatchObject({
      kind: "choice",
      alternatives: [
        {
          kind: "sequence",
          elements: [
            { kind: "literal", literal: { raw: "head" } },
            {
              kind: "group",
              delimiter: "parenthesis",
              body: {
                elements: [{ kind: "capture", name: "first" }],
              },
            },
            {
              kind: "repeat",
              minimum: 1,
              depth: 1,
              separator: { kind: "literal", literal: { raw: "," } },
            },
            { kind: "optional", depth: 1 },
            { kind: "literal", literal: { raw: "left" } },
          ],
        },
        {
          kind: "sequence",
          elements: [{ kind: "literal", literal: { raw: "right" } }],
        },
      ],
    });
  });

  it("parses operator headers and properties without interpreting them", () => {
    const result = parse(`
      export operator (==):expr shadows core {
        fixity infix;
        associativity none;
        precedence 30;
        rule { $left:expr == $right:expr } => { same($left, $right) }
      }
    `);
    expect(result.definitions[0]).toMatchObject({
      kind: "operator",
      spelling: "==",
      category: "expr",
      shadowsCore: true,
      clauses: [
        { kind: "property", keyword: "fixity" },
        { kind: "property", keyword: "associativity" },
        { kind: "property", keyword: "precedence" },
      ],
      rules: [{ pattern: { kind: "sequence" } }],
    });
  });

  it("parses explicitly grouped punctuation syntax names", () => {
    const result = parse(`
      export rec syntax (->>):expr {
        rule { ->> $value:expr } => { $value }
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.definitions[0]).toMatchObject({
      kind: "syntax",
      name: "->>",
      category: "expr",
      exported: true,
      recursive: true,
    });
  });

  it("recovers at definition and rule boundaries with structured diagnostics", () => {
    const result = parse(`
      export syntax broken
      syntax good:expr {
        rule nope
        rule { $bad }
        rule { good($value:expr) } => { $value }
      }
    `);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2001",
      "SWR2001",
      "SWR2002",
    ]);
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0]).toMatchObject({ name: "good" });
    if (result.definitions[0]?.kind !== "syntax")
      throw new Error("expected syntax");
    expect(result.definitions[0].rules).toHaveLength(2);
  });

  it("parses every declarative acceptance file", async () => {
    const playgroundRoot = path.join(
      repositoryRoot,
      "fixtures/acceptance/playground",
    );
    const directories = await readdir(playgroundRoot, { withFileTypes: true });
    let definitionCount = 0;
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const file = path.join(playgroundRoot, directory.name, "declarative.sts");
      const source = await readFile(file, "utf8");
      const read = readSyntax(source, { sourceId, scopes });
      expect(
        read.diagnostics.map((diagnostic) => diagnostic.code),
        directory.name,
      ).toEqual([]);
      const result = parseMacroDefinitions(read.root, { sourceId });
      expect(result.diagnostics, directory.name).toEqual([]);
      const compiledClasses = compileParsedSyntaxClasses(result, {
        sourceId,
        spanForOrigin: (origin) =>
          read.origins.selectPrimarySource(origin)?.span ?? {
            start: 0,
            end: 0,
          },
      });
      expect(compiledClasses.diagnostics, `${directory.name}:classes`).toEqual(
        [],
      );
      const compiledContracts = compileParsedBindingContracts(result, {
        sourceId,
        syntaxClasses: compiledClasses.registry,
        spanForOrigin: (origin) =>
          read.origins.selectPrimarySource(origin)?.span ?? {
            start: 0,
            end: 0,
          },
      });
      expect(
        compiledContracts.diagnostics,
        `${directory.name}:binding-contracts`,
      ).toEqual([]);
      expect(result.definitions.length, directory.name).toBeGreaterThan(0);
      expect(
        result.unparsed.every(
          (entry) =>
            directory.name === "rewritten-if" &&
            source.slice(entry.syntax.span.start, entry.syntax.span.end).trim()
              .length > 0,
        ),
        directory.name,
      ).toBe(true);
      const origins = read.origins;
      for (const definition of result.definitions) {
        for (const rule of definition.rules) {
          const inferred = inferCaptureShapes(rule.pattern, {
            sourceId,
            spanForOrigin: (origin) =>
              origins.selectPrimarySource(origin)?.span ?? {
                start: 0,
                end: 0,
              },
          });
          expect(
            inferred.diagnostics,
            `${directory.name}:${definition.kind}`,
          ).toEqual([]);
          const firstProgram = compileMatcherProgram(rule.pattern, {
            rule: rule.id,
            inference: inferred,
          });
          const secondProgram = compileMatcherProgram(rule.pattern, {
            rule: rule.id,
            inference: inferred,
          });
          expect(serializeMatcherProgram(firstProgram)).toBe(
            serializeMatcherProgram(secondProgram),
          );
        }
      }
      definitionCount += result.definitions.length;
    }
    expect(definitionCount).toBeGreaterThanOrEqual(20);
  });

  it("executes a compiled acceptance rule against reader syntax", async () => {
    const source = await readFile(
      path.join(
        repositoryRoot,
        "fixtures/acceptance/playground/threading/declarative.sts",
      ),
      "utf8",
    );
    const definitionRead = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(definitionRead.root, { sourceId });
    const definition = parsed.definitions.find(
      (candidate) => candidate.kind === "syntax" && candidate.name === "->",
    );
    if (definition?.kind !== "syntax") throw new Error("missing -> macro");
    const rule = definition.rules[0];
    if (rule === undefined) throw new Error("missing thread base rule");
    const inference = inferCaptureShapes(rule.pattern, {
      sourceId,
      spanForOrigin: (origin) =>
        definitionRead.origins.selectPrimarySource(origin)?.span ?? {
          start: 0,
          end: 0,
        },
    });
    const program = compileMatcherProgram(rule.pattern, {
      rule: rule.id,
      inference,
    });
    const invocation = readSyntax("(-> seed)", { sourceId, scopes });
    const input = invocation.root.children.filter(
      (syntax) => syntax.tag !== "token" || syntax.kind !== "end-of-file",
    );
    const result = executeMatcher(program, input, {
      consumeClass: (_classId, cursor) => {
        const syntax = cursor.consume();
        return syntax === undefined
          ? undefined
          : {
              cursor,
              syntax: Object.freeze([syntax]),
              origin: syntax.origin,
            };
      },
    });
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("thread rule did not match");
    expect(result.cursor.atEnd).toBe(true);
    expect(result.captures.size).toBe(1);
  });

  it("compiles and executes an acceptance syntax class with public fields", async () => {
    const source = await readFile(
      path.join(
        repositoryRoot,
        "fixtures/acceptance/playground/do-notation/declarative.sts",
      ),
      "utf8",
    );
    const definitionRead = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(definitionRead.root, { sourceId });
    const compiled = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin: (origin) =>
        definitionRead.origins.selectPrimarySource(origin)?.span ?? {
          start: 0,
          end: 0,
        },
    });
    expect(compiled.diagnostics).toEqual([]);
    const bindings = new Map(
      parsed.classBindings.map((binding) => [binding.name, binding.classId]),
    );
    const tokenClass = bindings.get("token");
    const ttClass = bindings.get("tt");
    const identClass = bindings.get("ident");
    const bindClauseClass = bindings.get("Bind");
    if (
      tokenClass === undefined ||
      ttClass === undefined ||
      identClass === undefined ||
      bindClauseClass === undefined
    ) {
      throw new Error("missing syntax-class bindings");
    }
    const consumer = createSyntaxClassConsumer(compiled.registry, {
      builtins: { token: tokenClass, tt: ttClass, ident: identClass },
      externalConsumer: (_classId, cursor) => {
        const syntax = cursor.consume();
        return syntax === undefined
          ? undefined
          : {
              cursor,
              syntax: Object.freeze([syntax]),
              origin: syntax.origin,
            };
      },
    });
    const invocation = readSyntax("name <- source;", { sourceId, scopes });
    const input = invocation.root.children.filter(
      (syntax) => syntax.tag !== "token" || syntax.kind !== "end-of-file",
    );
    const result = consumer(bindClauseClass, createSyntaxCursor(input));
    expect(result?.cursor.atEnd).toBe(true);
    const definition = parsed.definitions.find(
      (candidate) =>
        candidate.kind === "syntax-class" && candidate.name === "Bind",
    );
    if (definition?.kind !== "syntax-class")
      throw new Error("missing Bind definition");
    expect(result?.fields?.get(definition.fields[0]!.capture)).toMatchObject({
      kind: "leaf",
      syntax: [{ raw: "name" }],
    });
    expect(result?.fields?.get(definition.fields[1]!.capture)).toMatchObject({
      kind: "leaf",
      syntax: [{ raw: "source" }],
    });
  });

  it("lowers the acceptance refinement spelling to fixed IR", () => {
    const source = `
      syntax class LowerName {
        fields { name: ident; }
        rule { $name:ident }
        refine $name spelling starts-with-lowercase
      }
    `;
    const read = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    const compiled = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin: (origin) =>
        read.origins.selectPrimarySource(origin)?.span ?? {
          start: 0,
          end: 0,
        },
    });
    expect(compiled.diagnostics).toEqual([]);
    const classId = parsed.classBindings.find(
      (binding) => binding.name === "LowerName",
    )?.classId;
    if (classId === undefined) throw new Error("missing LowerName class");
    expect(compiled.registry.get(classId)?.rules[0]?.refinements).toEqual([
      {
        target: expect.any(Number),
        predicate: { kind: "starts-with-lowercase" },
      },
    ]);
  });

  it("compiles rule templates against inferred captures and class fields", () => {
    const source = `
      syntax class Piece {
        fields { name: ident; }
        rule { $name:ident }
      }
      syntax collect:expr {
        rule { collect($($parts:Piece),+) }
        => { make($($parts.name),+) }
      }
    `;
    const read = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    const spanForOrigin = (
      origin: Parameters<typeof read.origins.selectPrimarySource>[0],
    ) => read.origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 };
    const classes = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin,
    });
    const templates = compileParsedTemplates(parsed, {
      sourceId,
      spanForOrigin,
      syntaxClasses: classes.registry,
    });
    expect(classes.diagnostics).toEqual([]);
    expect(templates.diagnostics).toEqual([]);
    expect(templates.templates).toHaveLength(1);
    expect(templates.templates[0]?.template).toMatchObject({
      elements: [
        { kind: "literal", syntax: { raw: "make" } },
        {
          kind: "group",
          body: {
            elements: [
              {
                kind: "repeat",
                depth: 1,
                body: {
                  elements: [
                    {
                      kind: "capture",
                      path: {
                        rootName: "parts",
                        fields: [{ name: "name" }],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it("compiles do-style field binding contracts to typed paths", async () => {
    const source = await readFile(
      path.join(
        repositoryRoot,
        "fixtures/acceptance/playground/do-notation/declarative.sts",
      ),
      "utf8",
    );
    const read = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    const spanForOrigin = (
      origin: Parameters<typeof read.origins.selectPrimarySource>[0],
    ) => read.origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 };
    const classes = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin,
    });
    const compiled = compileParsedBindingContracts(parsed, {
      sourceId,
      spanForOrigin,
      syntaxClasses: classes.registry,
    });
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.rules).toHaveLength(2);
    expect(compiled.rules[1]?.contracts).toMatchObject([
      {
        binders: {
          rootName: "step",
          fields: [{ name: "name" }],
        },
        region: {
          kind: "capture",
          path: { rootName: "rest" },
        },
        kind: "lexical",
        space: "value",
      },
    ]);
  });

  it("reports invalid binding paths, alignments, spaces, and syntax", () => {
    const source = `
      syntax invalid:expr {
        rule { $bad:expr $name:binding $body:tt }
        bind $bad in $body as lexical value
        bind $name in $body as sequential value
        bind $name in following as recursive type
        bind nope
        => { $body }
      }
    `;
    const read = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    const spanForOrigin = (
      origin: Parameters<typeof read.origins.selectPrimarySource>[0],
    ) => read.origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 };
    const classes = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin,
    });
    const compiled = compileParsedBindingContracts(parsed, {
      sourceId,
      spanForOrigin,
      syntaxClasses: classes.registry,
    });
    expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR3003",
      "SWR3004",
      "SWR3005",
      "SWR3002",
    ]);
  });

  it("expands a syntax-class binder into its declared binding fields", () => {
    const source = `
      syntax class PairBindings {
        fields { left: binding; right: binding; }
        rule { $left:binding, $right:binding }
      }
      syntax pairLet:expr {
        rule { pairLet $names:PairBindings in $body:expr }
        bind $names in $body as lexical value
        => { $body }
      }
    `;
    const read = readSyntax(source, { sourceId, scopes });
    const parsed = parseMacroDefinitions(read.root, { sourceId });
    const spanForOrigin = (
      origin: Parameters<typeof read.origins.selectPrimarySource>[0],
    ) => read.origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 };
    const classes = compileParsedSyntaxClasses(parsed, {
      sourceId,
      spanForOrigin,
    });
    const compiled = compileParsedBindingContracts(parsed, {
      sourceId,
      spanForOrigin,
      syntaxClasses: classes.registry,
    });
    expect(classes.diagnostics).toEqual([]);
    expect(compiled.diagnostics).toEqual([]);
    expect(
      compiled.rules[0]?.contracts.map((contract) =>
        contract.binders.fields.map((field) => field.name),
      ),
    ).toEqual([["left"], ["right"]]);
  });
});
