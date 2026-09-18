import { createPhase } from "@sweetener/hygiene";
import { printLosslessSequence, readSyntax } from "@sweetener/reader";
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
  createProtectedSyntax,
  createSyntaxCursor,
  OriginStore,
  type GroupSyntax,
  type SyntaxCategory,
} from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  ConsumerRegistry,
  createItemConsumer,
  createStatementConsumer,
  type StatementItemMacroResolver,
} from "../src/index.js";

const sourceId = 103 as SourceId;

function parse(
  source: string,
  category: "stmt" | "item",
  resolveMacro?: StatementItemMacroResolver,
  // Read as though inside a plain function, where neither `yield` nor `await`
  // is an expression; a caller testing where either is one says so for itself.
  contexts: { readonly allowYield: boolean; readonly allowAwait: boolean } = {
    allowYield: false,
    allowAwait: false,
  },
) {
  const origins = new OriginStore();
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
  });
  expect(read.diagnostics).toEqual([]);
  const syntax = read.root.children.filter(
    (node) => node.tag !== "token" || node.kind !== "end-of-file",
  );
  const ids = createIdAllocator<SyntaxId>(30_000);
  const options = {
    origins,
    allocateSyntaxId: ids.allocate,
    resolveMacro,
  };
  const registry = new ConsumerRegistry([
    {
      category,
      consumer:
        category === "stmt"
          ? createStatementConsumer(options)
          : createItemConsumer(options),
    },
  ]);
  const cursor = createSyntaxCursor(syntax);
  const tracker = new ResourceTracker(createResourceBudget());
  const result = registry.consume(category, {
    cursor,
    phase: createPhase(0),
    environmentEpoch: 0 as EnvironmentEpoch,
    tracker,
    allowYield: contexts.allowYield,
    allowAwait: contexts.allowAwait,
  });
  return { result, cursor, syntax, origins, ids, tracker };
}

function output(source: string, category: "stmt" | "item") {
  const { result } = parse(source, category);
  if (!result.matched) throw new Error(result.failure.expectations.join(", "));
  return printLosslessSequence(result.syntax.children);
}

describe("statement and item consumers", () => {
  test("consumes a generic-arrow variable item", () => {
    const source =
      'const Some = <T>(value: T): Option<T> => ({ tag: "Some", value });';
    const { result } = parse(source, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected variable item");
    expect(result.cursor.atEnd).toBe(true);
  });
  test.each([
    ";",
    "{ value(); }",
    "if (ready) run(); else stop();",
    "for (const value of values) { use(value); }",
    "while (ready) tick();",
    "do tick(); while (ready);",
    "switch (value) { case 1: break; default: stop(); }",
    "try { work(); } catch (error) { recover(error); } finally { clean(); }",
    "return value;",
    "throw error;",
    "const value = source + 1;",
    "function run(value) { return value; }",
    "class Box { value = 1; }",
    "outer: for (;;) { break outer; }",
    "@sealed class DecoratedBox { value = 1; }",
    "target.call(value);",
    // A return type may hold an object type, whose braces are not the body.
    "function shape(): { a: number } { return { a: 1 }; }",
    "function check(value: unknown): asserts value is { a: number } {}",
    "function make(): () => { a: number } { return () => ({ a: 1 }); }",
  ])("consumes the complete statement extent: %s", (source) => {
    const { result } = parse(`${source} after();`, "stmt");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected statement");
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(result.cursor.atEnd).toBe(false);
    expect(result.syntax.category).toBe("stmt");
  });

  test("enforests each member of a class body with parenthesized decorators", () => {
    // `@(expr)` is a decorator, so the body is a list of members rather than
    // syntax the member reader gives up on.
    const { result } = parse(
      "class Box { @(logged) value = 1; @(factory()) method(): void {} }",
      "item",
    );
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected class item");
    const body = result.syntax.children.find(
      (syntax) =>
        syntax.tag === "protected" && syntax.category === "classElement",
    );
    const members = body?.tag === "protected" ? body.children[0] : undefined;
    if (members?.tag !== "group") throw new Error("expected a class body");
    expect(
      members.children.map((member) =>
        member.tag === "protected" ? member.category : member.tag,
      ),
    ).toEqual(["classElement", "classElement"]);
  });

  test("enforests statements inside switch clauses", () => {
    const { result } = parse(
      "switch (value) { case 1: work(); break; default: stop(); }",
      "stmt",
    );
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected switch statement");
    const body = result.syntax.children.find(
      (syntax): syntax is GroupSyntax =>
        syntax.tag === "group" && syntax.delimiter === "brace",
    );
    expect(
      body?.children.filter(
        (syntax) => syntax.tag === "protected" && syntax.category === "stmt",
      ),
    ).toHaveLength(3);
  });

  test.each([
    "using resource = acquire();",
    "@sealed class DecoratedBox { value: number; }",
  ])("consumes explicit resource-management statement %s", (source) => {
    const { result } = parse(source, "stmt");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected using declaration");
    expect(result.cursor.atEnd).toBe(true);
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
  });

  // `await using` and the `await` of `for await` suspend the function they are
  // written in exactly as the `await` operator does, so TypeScript allows them
  // only where it allows that -- inside an async function and at the top level
  // of a module. Taken as a statement head without asking, each parsed in a
  // plain function, where TypeScript rejects it.
  const awaiting = [
    "await using resource = acquireAsync();",
    "for await (const value of source) { use(value); }",
  ];

  test.each(awaiting)(
    "consumes %s where `await` is an expression",
    (source) => {
      const { result } = parse(source, "stmt", undefined, {
        allowYield: false,
        allowAwait: true,
      });
      expect(result.matched).toBe(true);
      if (!result.matched) throw new Error("expected an awaiting statement");
      expect(result.cursor.atEnd).toBe(true);
      expect(printLosslessSequence(result.syntax.children)).toBe(source);
    },
  );

  test.each(awaiting)("refuses %s where `await` is not one", (source) => {
    const { result } = parse(source, "stmt");
    expect(result.matched).toBe(false);
    if (result.matched) throw new Error("expected a refusal");
    expect(result.failure.expectations).toContain(
      "await inside an async function",
    );
  });

  test("reads a module-level `await using` by the same rule", () => {
    const source = "await using resource = acquireAsync();";
    const allowed = parse(source, "item", undefined, {
      allowYield: false,
      allowAwait: true,
    }).result;
    expect(allowed.matched).toBe(true);
    if (!allowed.matched) throw new Error("expected a using item");
    expect(printLosslessSequence(allowed.syntax.children)).toBe(source);
    const refused = parse(source, "item").result;
    expect(refused.matched).toBe(false);
    if (refused.matched) throw new Error("expected a refusal");
    expect(refused.failure.expectations).toContain(
      "await inside an async function",
    );
  });

  test.each(["return 1 + ;", "break 1 + ;", "continue 1 + ;"])(
    "does not drop what a restricted statement could not read: %s",
    (source) => {
      // The failed expression attempt has already read `1 +`. If the `;`
      // after it then satisfies the terminator, the statement matches as the
      // keyword alone and the rest of what was written vanishes.
      const { result } = parse(source, "stmt");
      expect(result.matched).toBe(false);
    },
  );

  test("implements restricted-production and automatic-semicolon rules", () => {
    const returned = parse("return\nnext();", "stmt").result;
    expect(returned.matched).toBe(true);
    if (!returned.matched) throw new Error("expected return");
    expect(printLosslessSequence(returned.syntax.children)).toBe("return");

    const declaration = parse(
      "const first = 1\nconst second = 2",
      "stmt",
    ).result;
    expect(declaration.matched).toBe(true);
    if (!declaration.matched) throw new Error("expected declaration");
    expect(printLosslessSequence(declaration.syntax.children)).toBe(
      "const first = 1",
    );

    const thrown = parse("throw\nerror", "stmt").result;
    expect(thrown.matched).toBe(false);
    if (thrown.matched) throw new Error("expected throw failure");
    expect(thrown.failure.expectations).toContain(
      "expression on the same line as 'throw'",
    );

    expect(parse("value next", "stmt").result.matched).toBe(false);
  });

  test.each([
    "import { value } from 'module';",
    "export const value = 1;",
    "export function run() { return 1; }",
    "interface Box { value: number; }",
    "type Value = string | number;",
    "enum Mode { One, Two }",
    "namespace Local { export const value = 1; }",
    "using resource = acquire();",
  ])("consumes the complete module-item extent: %s", (source) => {
    const { result } = parse(`${source}\nconst after = 1;`, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected item");
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(result.cursor.atEnd).toBe(false);
    expect(result.syntax.category).toBe("item");
  });

  test("dispatches category-specific macro heads before built-in syntax", () => {
    const resolver: StatementItemMacroResolver = (category, cursor) => {
      const head = cursor.peek();
      if (head?.tag !== "token" || head.raw !== "unless") return undefined;
      cursor.advance();
      const group = cursor.consume();
      if (group === undefined) return undefined;
      return Object.freeze({
        matched: true,
        syntax: createProtectedSyntax({
          id: 90_000 as SyntaxId,
          span: { start: head.span.start, end: group.span.end },
          origin: head.origin,
          scopes: head.scopes,
          category,
          children: [head, group],
        }),
        cursor,
      });
    };
    const { result } = parse("unless (ready) after", "stmt", resolver);
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected macro statement");
    expect(printLosslessSequence(result.syntax.children)).toBe(
      "unless (ready)",
    );
    expect(result.cursor.atEnd).toBe(false);
  });

  test("returns ranked failures without mutating caller cursors", () => {
    const malformed = [
      "if value;",
      "do work();",
      "function missing()",
      "try {}",
      "switch value {}",
    ];
    for (const source of malformed) {
      const { result, cursor } = parse(source, "stmt");
      expect(result.matched).toBe(false);
      expect(cursor.index).toBe(0);
      if (result.matched) throw new Error("expected malformed statement");
      expect(result.failure.progress).toBeGreaterThan(0);
    }
  });

  test("reconstructed representative extents parse with pinned TypeScript", () => {
    const statements = [
      "if (ready) run(); else stop();",
      "for (const value of values) use(value);",
      "try { work(); } catch { recover(); }",
      "const value = source + 1;",
      "target.call(value);",
    ];
    const items = [
      "import { value } from 'module';",
      "export function run() { return value; }",
      "interface Box { value: number; }",
    ];
    for (const [category, sources] of [
      ["stmt", statements],
      ["item", items],
    ] as const satisfies readonly (readonly [
      SyntaxCategory,
      readonly string[],
    ])[]) {
      for (const source of sources) {
        const reconstructed = output(source, category as "stmt" | "item");
        const parsed = ts.createSourceFile(
          "fixture.ts",
          reconstructed,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        const diagnostics = (
          parsed as ts.SourceFile & {
            readonly parseDiagnostics: readonly ts.Diagnostic[];
          }
        ).parseDiagnostics;
        expect(diagnostics, reconstructed).toEqual([]);
      }
    }
  });
});
