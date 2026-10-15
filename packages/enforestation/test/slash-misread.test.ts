import { createPhase } from "@sweetener/hygiene";
import { nextSlashReadings, readSyntax } from "@sweetener/reader";
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
  createSyntaxCursor,
  OriginStore,
  type SlashReading,
  type SlashReadings,
  type Syntax,
} from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { createConsumerSuite } from "../src/index.js";

const sourceId = 131 as SourceId;

type Category = "item" | "classElement";

/**
 * The source split into what `category` reads one after another, read with
 * `readings`, and the slashes the consumers said were read the other way.
 */
function splitOnce(
  source: string,
  category: Category,
  readings: SlashReadings,
): { readonly parts: readonly string[]; readonly misread: SlashReadings } {
  const origins = new OriginStore();
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
    slashReadings: readings,
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
  const misread = new Map<number, SlashReading>();
  let cursor = createSyntaxCursor(syntax);
  const parts: string[] = [];
  while (cursor.remainingLength > 0) {
    const result = registry.consume(category, {
      cursor,
      phase: createPhase(0),
      environmentEpoch: 0 as EnvironmentEpoch,
      tracker: new ResourceTracker(createResourceBudget()),
      allowYield: false,
      allowAwait: true,
      slashMisread: (slash, reading) => misread.set(slash.span.start, reading),
    });
    if (!result.matched) break;
    parts.push(source.slice(result.syntax.span.start, result.syntax.span.end));
    cursor = result.cursor;
  }
  return { parts, misread };
}

/** Read and split again until the consumers find no slash misread. */
function split(source: string, category: Category): readonly string[] {
  let readings: SlashReadings = new Map();
  for (;;) {
    const { parts, misread } = splitOnce(source, category, readings);
    if (misread.size === 0) return parts;
    readings = nextSlashReadings(source, "standard", readings, misread);
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
 * it. The consumers say where it judged wrong, and the source read again with
 * their answer splits where TypeScript splits it.
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
    // A name spelled like a keyword divided: read as a regular expression,
    // the line break under `x = of` ended the statement there.
    "x = of / 2 / 3;\nrun();",
    "x = undefined\n/ 2 /g;\nrun();",
    "x = a!\n/ 2 /g;\nrun();",
    // Several in one source, read again together where each changes only
    // itself.
    "if (a) /x/.test(s);\nif (b) /(/.test(s);\nif (c) /y/.test(s);\nrun();",
  ])("splits %j as TypeScript does", (source) => {
    expect(split(source, "item")).toEqual(typescript(source, "item"));
  });

  test.each([
    "x = a / 2 / b;",
    "x = /re/g;",
    "x = {}\n/ 2 /g;",
    "x = a\n/ 2 / b;",
  ])("finds nothing misread in %j", (source) => {
    expect(splitOnce(source, "item", new Map()).misread.size).toBe(0);
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
