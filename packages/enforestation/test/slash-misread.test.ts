import { createPhase } from "@sweetener/hygiene";
import { readSyntax } from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type EnvironmentEpoch,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  angleReading,
  createSyntaxCursor,
  OriginStore,
  type TokenReading,
  type TokenReadings,
  type Syntax,
  type TokenSyntax,
} from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { createConsumerSuite } from "../src/index.js";

const sourceId = 131 as SourceId;

type Category = "item" | "classElement";

/**
 * The source split into what `category` reads one after another, read with
 * `readings`; the slashes the consumers said only reading the source again
 * reads as the grammar does; and the tokens of what they read.
 */
function splitOnce(
  source: string,
  category: Category,
  readings: TokenReadings,
  variant: "standard" | "jsx" = "standard",
): {
  readonly parts: readonly string[];
  readonly misread: TokenReadings;
  readonly tokens: readonly string[];
} {
  const origins = new OriginStore();
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
    readings,
    variant,
  });
  let syntax: readonly Syntax[] = read.root.children.filter(
    (node) => node.tag !== "token" || node.kind !== "end-of-file",
  );
  if (category === "classElement") {
    const body = syntax.find(
      (node) => node.tag === "group" && node.delimiter === "brace",
    );
    if (body?.tag !== "group") throw new Error("expected a class body");
    syntax = body.children;
  }
  const ids = createIdAllocator<SyntaxId>(30_000);
  const { registry } = createConsumerSuite({
    origins,
    allocateSyntaxId: ids.allocate,
  });
  const misread = new Map<number, TokenReading>();
  let cursor = createSyntaxCursor(syntax);
  const parts: string[] = [];
  const tokens: string[] = [];
  while (cursor.remainingLength > 0) {
    const result = registry.consume(category, {
      cursor,
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: false,
      allowAwait: true,
      misread: (slash, reading) => misread.set(slash.span.start, reading),
      readsElement: variant === "jsx" ? () => true : undefined,
    });
    if (!result.matched) break;
    parts.push(source.slice(result.syntax.span.start, result.syntax.span.end));
    tokens.push(...tokensOf(result.syntax));
    cursor = result.cursor;
  }
  return { parts, misread, tokens };
}

/** The tokens of `syntax`, with a regular expression marked as one. */
function tokensOf(syntax: Syntax): readonly string[] {
  const token = (node: TokenSyntax) =>
    node.kind === "regular-expression-literal" ? `re:${node.raw}` : node.raw;
  switch (syntax.tag) {
    case "token":
      return [token(syntax)];
    case "group":
      return [
        token(syntax.open),
        ...syntax.children.flatMap(tokensOf),
        ...(syntax.close.tag === "token" ? [token(syntax.close)] : []),
      ];
    case "protected":
    case "root":
      return syntax.children.flatMap(tokensOf);
  }
}

/**
 * Read and split again, with every slash the consumers found read as they
 * found it, until they find none: what the project expansion does. These are
 * not JSX sources, so a `<` said to open an element opens nothing, and the
 * project expansion ignores it too.
 */
function split(source: string, category: Category): readonly string[] {
  let readings: TokenReadings = new Map();
  for (let read = 1; ; read += 1) {
    const { parts, misread } = splitOnce(source, category, readings);
    const found = [...misread].filter(([, reading]) => !angleReading(reading));
    if (found.length === 0) return parts;
    expect(read, source).toBeLessThan(4);
    readings = new Map([...readings, ...found]);
  }
}

/** What TypeScript reads, as a module, which every Sweetener source is. */
function typescript(source: string, category: Category): readonly string[] {
  const file = ts.createSourceFile(
    "fixture.ts",
    source,
    {
      languageVersion: ts.ScriptTarget.Latest,
      setExternalModuleIndicator: (sourceFile) => {
        (
          sourceFile as { externalModuleIndicator?: unknown }
        ).externalModuleIndicator = true;
      },
    },
    true,
    ts.ScriptKind.TS,
  ) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] };
  expect(file.parseDiagnostics, source).toEqual([]);
  if (category === "item") return file.statements.map((s) => s.getText(file));
  const declaration = file.statements[0];
  if (declaration === undefined || !ts.isClassDeclaration(declaration))
    throw new Error("expected a class");
  return declaration.members.map((member) => member.getText(file));
}

/**
 * A slash is a regular expression where an operand begins and a division
 * where an operator stands, whatever the reader judged from the token before
 * it. The consumers read it as the grammar does where only the tokens of the
 * one expression change, and say so where reading it so changes more; the
 * source read again with their answer splits where TypeScript splits it.
 */
describe("slashes read the other way from the grammar", () => {
  test.each([
    "if (c) /re/.test(s);\nrun();",
    "while (c) /re/.test(s);\nrun();",
    "function f()\n/re/.test(s);\nrun();",
    "declare function f(): string\n/re/.test(s);\nrun();",
    "let x: Foo\n/re/.test(s);\nrun();",
    "type A = B[]\n/re/.test(s);\nrun();",
    "{}\n/re/.test(s);\nrun();",
    // Holding a group's delimiter or a quote, read as a division the
    // expression left the read unbalanced.
    "if (c) /(/.test(s);\nrun();",
    "if (c) /[/]/.test(s);\nrun();",
    "if (c) /'/.test(s);\nrun();",
    "function f()\n/=x/.test(s);\nrun();",
    "let x: Foo\n/[(]/.test(s);\nrun();",
    "let x: Foo\n/[(]/.test(s);\nlet y: Foo\n/'/.test(s);\nrun();",
    // A name spelled like a keyword divided: read as a regular expression,
    // the line break under `x = of` ended the statement there.
    "x = of / 2 / 3;\nrun();",
    "x = undefined\n/ 2 /g;\nrun();",
    "x = a!\n/ 2 /g;\nrun();",
    "x = y as const / 2 / 1;\nrun();",
    "x = y as const\n/ 2 /g;\nrun();",
    "for (let i = of / 2 / 1;;) run();\nrun();",
    // Several in one source.
    "if (a) /x/.test(s);\nif (b) /(/.test(s);\nif (c) /y/.test(s);\nrun();",
  ])("splits %j as TypeScript does", (source) => {
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  // The reader reads these as the grammar does from the groups around them,
  // or the parser reads them again where they stand: nothing is read again.
  test.each([
    ["if (c) /(/.test(s);", "re:/(/"],
    ["for (const x of /a/g.exec(s)) run();", "re:/a/g"],
    ["let x: Foo\n/a  b/.test(s);", "re:/a  b/"],
    ["function f()\n/=x/g.test(s);", "re:/=x/g"],
    ["x = y as const / 2 /g;", "g"],
  ])("reads %j in one read", (source, token) => {
    const { misread, tokens } = splitOnce(source, "item", new Map());
    expect(misread.size).toBe(0);
    expect(tokens).toContain(token);
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  // Read the other way, the slash changes the groups or the tokens after the
  // expression: a bracket or a quote inside, the `=` of a `/=`.
  test.each([
    ["let w = a\n  + 1, x: Foo\n/[(]/.test(s);", 24],
    ["let w = a\n  + 1, x: Foo\n/'/.test(s);", 24],
    ["let w = a\n  + 1, x: Foo\n/a/=b;", 24],
  ])("asks for %j to be read again", (source, offset) => {
    expect(splitOnce(source, "item", new Map()).misread).toEqual(
      new Map([[offset, "regular-expression"]]),
    );
  });

  test.each([
    "x = a / 2 / b;",
    "x = /re/g;",
    "x = {}\n/ 2 /g;",
    "x = a\n/ 2 / b;",
    "x = a ** of / 2 / 1;",
  ])("finds nothing misread in %j", (source) => {
    expect(splitOnce(source, "item", new Map()).misread.size).toBe(0);
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  // A regular expression read where an operator stands is split where the
  // division it is would be taken, and the expression reads on over its
  // tokens in every operand open around it.
  test.each([
    "x = a * (y as const) / 2, 3 / g;",
    "x = y as const / 2, 3 / g;",
    "x = a < y as const / 2 / g;",
  ])("reads %j on over a split literal", (source) => {
    const { misread, tokens } = splitOnce(source, "item", new Map());
    expect(misread.size).toBe(0);
    expect(tokens.some((token) => token.startsWith("re:"))).toBe(false);
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  // TypeScript takes no operator but a comma after an arrow function, whose
  // body ended it, and none after an assignment whose right operand is one.
  test.each([
    "() => {}\n/re/.test(s);",
    "x = () => {}\n/re/.test(s);",
    "() => {}\n/=x/.test(s);",
    "x = () => {}\n[0].map(g);",
  ])("ends %j after the arrow's block", (source) => {
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  // TypeScript writes `UnaryExpression [no LineTerminator here] as Type`, and
  // an arrow's body is an expression like any other.
  test.each([
    "x = a\nas;",
    "x = a\nsatisfies;",
    "f = (a) => a\nas = 1;",
    "const f = (a) => a\nsatisfies = 1;",
    "f = async (a) => a\nas = 1;",
  ])("reads %j as two statements", (source) => {
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });
});

/**
 * A class field's initializer is read by the expression consumer, which knows
 * where an expression ends; scanned as tokens, the member walk took a bracket
 * under an asserted type for an index into it.
 */
describe("class field initializers", () => {
  test.each([
    "class C {\nx = a as B\n[k] = 1;\n}",
    "class C {\nx = a satisfies B\n[k]() {}\n}",
    "class C {\nx = a\n[k];\ny = 1;\n}",
    "class C {\nx = a +\nb\ny = 1;\n}",
    "class C {\nx = await\nb = 1;\n}",
    "class C {\nx: T = () => {}\n[k] = 1;\n}",
    "abstract class C {\n  x = (a) => a\n  as = 1\n}",
    "abstract class C {\n  x = async (a) => a\n  satisfies = 1\n}",
    "abstract class C {\n  x = <T>(v: T) => v\n  as = 1\n}",
    "abstract class C {\n  x = () =>\n1\n  as = 1\n}",
  ])("splits %j as TypeScript does", (source) => {
    expect(split(source, "classElement")).toEqual(
      typescript(source, "classElement"),
    );
  });
});

describe("a bare `<T>` read the other way from the grammar", () => {
  /**
   * The reader judges a `<` after an operand's end to compare. After an
   * initializer that goes on across a line it reads `, x: T` as an
   * expression's, where a declarator ends and a statement begins under it,
   * with an operand: TypeScript reads an element there.
   */
  test("is an element where an operand begins", () => {
    const source = "let w = a\n  + 1, x: T\n<b>(note): x</b>;\n";
    const { misread } = splitOnce(source, "item", new Map(), "jsx");
    expect([...misread]).toEqual([[source.indexOf("<b>"), "element"]]);
  });

  test("is an element, not an assertion, where JSX is read", () => {
    // The reader judges a `<` after a name to compare; after a macro's name
    // an operand begins there. Read as an assertion, `<div className="a">`
    // let a rule read the element's tags and text as code.
    for (const source of [
      'let w = a\n  + 1, x: T\n<div className="a">{x}</div>;\n',
      "let w = a\n  + 1, x: T\n<b>{x}</b>;\n",
    ]) {
      const { misread } = splitOnce(source, "item", new Map(), "jsx");
      expect([...misread], source).toEqual([
        [source.indexOf("<", source.indexOf("\n")), "element"],
      ]);
    }
  });

  test("is an assertion where JSX is not read", () => {
    const source = "let w = a\n  + 1, x: T\n<number>y;\n";
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  test("is not reported where type parameters are written", () => {
    for (const source of [
      "const f = <T,>(v: T) => v;\n",
      "const g: <T>(v: T) => T = (v) => v;\n",
      "interface I { <T>(v: T): T; }\n",
    ]) {
      const { misread } = splitOnce(source, "item", new Map(), "jsx");
      expect([...misread], source).toEqual([]);
    }
  });
});
