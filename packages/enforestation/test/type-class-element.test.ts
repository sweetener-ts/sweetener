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
  type Syntax,
} from "@sweetener/syntax";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  ConsumerRegistry,
  createClassElementConsumer,
  createTypeConsumer,
  StopSet,
  type TypeClassElementMacroResolver,
} from "../src/index.js";

const sourceId = 113 as SourceId;

function nodes(source: string, origins: OriginStore): readonly Syntax[] {
  const read = readSyntax(source, {
    sourceId,
    scopes: 0 as ScopeSetId,
    originStore: origins,
  });
  expect(read.diagnostics).toEqual([]);
  return read.root.children.filter(
    (syntax) => syntax.tag !== "token" || syntax.kind !== "end-of-file",
  );
}

function consume(
  source: string,
  category: "type" | "classElement",
  resolveMacro?: TypeClassElementMacroResolver,
  stopSet?: StopSet,
) {
  const origins = new OriginStore();
  const ids = createIdAllocator<SyntaxId>(60_000);
  let syntax: readonly Syntax[];
  if (category === "classElement") {
    const outer = nodes(`class Fixture { ${source} }`, origins);
    const body = outer.find(
      (item): item is GroupSyntax =>
        item.tag === "group" && item.delimiter === "brace",
    );
    if (body === undefined) throw new Error("missing class body");
    syntax = body.children;
  } else {
    syntax = nodes(source, origins);
  }
  const options = { origins, allocateSyntaxId: ids.allocate, resolveMacro };
  const registry = new ConsumerRegistry([
    { category: "type", consumer: createTypeConsumer(options) },
    {
      category: "classElement",
      consumer: createClassElementConsumer(options),
    },
  ]);
  const cursor = createSyntaxCursor(syntax);
  const result = registry.consume(category, {
    cursor,
    phase: createPhase(0),
    environmentEpoch: 0 as EnvironmentEpoch,
    tracker: new ResourceTracker(createResourceBudget()),
    stopSet,
    allowYield: false,
  });
  return { result, cursor, syntax, ids };
}

function parseDiagnostics(source: string) {
  return (
    ts.createSourceFile(
      "fragment.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
}

/** The text of the first member TypeScript reads in a class body. */
function typescriptFirstMember(body: string) {
  const file = ts.createSourceFile(
    "fragment.ts",
    `class Fixture { ${body} }`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fixture = file.statements[0];
  if (fixture === undefined || !ts.isClassDeclaration(fixture))
    throw new Error("expected a class");
  return fixture.members[0]?.getText(file);
}

describe("type and class-element consumers", () => {
  test.each([
    "string | number",
    "Promise<Result<T, E>>",
    "T extends U ? X : Y",
    "(value: T) => Promise<U>",
    "keyof typeof Namespace.value",
    "readonly [name: string, ...rest: number[]]",
    "{ readonly [K in keyof T]?: T[K] }",
    "`prefix-${string}`",
    "Array<T & { id: string }>",
    "typeof import('module').Value",
    "new <T>(value: T) => Instance<T>",
  ])("consumes TypeScript type %s", (source) => {
    const { result } = consume(source, "type");
    expect(result.matched).toBe(true);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(result.cursor.atEnd).toBe(true);
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(parseDiagnostics(`type Fragment = ${source};`)).toEqual([]);
  });

  test("stops before a caller-owned type separator", () => {
    const { result, syntax } = consume("Promise<T>, next", "type");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected type");
    expect(printLosslessSequence(result.syntax.children)).toBe("Promise<T>");
    expect(result.cursor.remainingRange().toArray()).toEqual(syntax.slice(4));
    expect(result.cursor.peek()).toMatchObject({ raw: "," });
  });

  test.each([
    "(...args: any[]) => infer R",
    "() => void",
    "(value) => value",
    "({ id }: Entity) => string",
    "(this: Window, event: Event) => void",
    "(value?: string) => void",
    "abstract new () => Instance",
    "(value: unknown) => value is string",
    "(string | number)[]",
    "(Result)",
  ])("reads parameter lists and parenthesized types in %s", (source) => {
    const { result } = consume(source, "type");
    expect(result.matched).toBe(true);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(result.cursor.atEnd).toBe(true);
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    expect(parseDiagnostics(`type Fragment = ${source};`)).toEqual([]);
  });

  // A parameter list is only the head of a function type, and `=>` only ever
  // follows one. Accepting either alone emits code TypeScript cannot parse.
  test.each([
    "(...args: any[])",
    "(value: T)",
    "()",
    "<T>(value: T)",
    "infer R => X",
    "string => number",
    "(string | number) => X",
    "(...args: any[]) | undefined",
    "(value: T)[]",
  ])("rejects %s, which is not a complete type", (source) => {
    const { result } = consume(source, "type");
    if (result.matched) {
      expect(result.cursor.atEnd).toBe(false);
      expect(
        parseDiagnostics(
          `type Fragment = ${printLosslessSequence(result.syntax.children)};`,
        ),
      ).toEqual([]);
    }
  });

  test("reads a function type through a caller-owned => separator", () => {
    const { result } = consume(
      "(...args: any[]) => infer R => X",
      "type",
      undefined,
      new StopSet([{ kind: "token", raw: "=>" }]),
    );
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected type");
    expect(printLosslessSequence(result.syntax.children)).toBe(
      "(...args: any[]) => infer R",
    );
    expect(result.cursor.peek()).toMatchObject({ raw: "=>" });
  });

  test("does not end a parameter list at a caller-owned stop", () => {
    const { result, cursor } = consume(
      "(...args: any[])>",
      "type",
      undefined,
      new StopSet([{ kind: "token", raw: ">" }]),
    );
    expect(result.matched).toBe(false);
    expect(cursor.index).toBe(0);
  });

  test("lets a caller-owned => end a parenthesized type", () => {
    const { result } = consume(
      "(Result) => X",
      "type",
      undefined,
      new StopSet([{ kind: "token", raw: "=>" }]),
    );
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected type");
    expect(printLosslessSequence(result.syntax.children)).toBe("(Result)");
    expect(result.cursor.peek()).toMatchObject({ raw: "=>" });
  });

  test.each(["keyof", "T extends U X : Y", "Promise<T"])(
    "rejects malformed type %s",
    (source) => {
      const { result, cursor } = consume(source, "type");
      expect(result.matched).toBe(false);
      expect(cursor.index).toBe(0);
    },
  );

  test.each([
    "value: string;",
    "readonly value = 1;",
    "method<T>(value: T): T { return value; }",
    "get value(): string { return this.current; }",
    "set value(next: string) { this.current = next; }",
    "constructor(public value: string) {}",
    "static { initialize(); }",
    "@sealed() public method(): void {}",
    "@sealed() property: { value: string };",
    "@(logged) value = 1;",
    "@(factory()) method(): void {}",
    "@a.b.c property = 1;",
    "@a.b<T>(value) method(): void {}",
    "@async value = 1;",
    "[key: string]: unknown;",
    "abstract method(): void;",
    "#private = 1;",
  ])("consumes class element %s", (source) => {
    const { result } = consume(source, "classElement");
    expect(result.matched).toBe(true);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(result.cursor.atEnd).toBe(true);
    const output = printLosslessSequence(result.syntax.children).trim();
    expect(output).toBe(source);
    expect(parseDiagnostics(`class Fixture { ${output} }`)).toEqual([]);
  });

  test("stops an ASI field before the next class element", () => {
    const { result } = consume("first = 1\nsecond = 2", "classElement");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected field");
    expect(printLosslessSequence(result.syntax.children).trim()).toBe(
      "first = 1",
    );
    expect(result.cursor.peek()).toMatchObject({ raw: "second" });
  });

  // Each member here is followed, on the next line and with no semicolon
  // between, by syntax TypeScript reads as another member, and the member
  // ends where TypeScript ends it.
  test.each([
    'first = 1\n"quoted"(): number { return 1; }',
    "first = 1\n0(): number { return 1; }",
    "first = 1\n#second = 2;",
    "first = 1\n@(logged) second = 2;",
    "first!: number\n*second(): Generator<number> { yield 1; }",
    "first!: number\n[key](): number { return 1; }",
    "first = 1\nget second(): number { return 1; }",
    "first = 1\nset second(value: number) {}",
    "first = 1\nasync second(): Promise<void> {}",
    "first = 1\nstatic second = 2;",
    "first = 1\naccessor second = 2;",
    "first = 1\ndeclare second: number;",
    "first = 1\nreadonly second = 2;",
    "first = 1\noverride second = 2;",
    "first = 1\nabstract second: number;",
    "first!: Array<number>\nsecond = 2;",
    // Only `static`, `get` and `set` continue onto the next line as modifiers;
    // any other modifier word ending a line is the name of a field.
    "readonly\nsecond = 2;",
    "async\nsecond(): void {}",
    "accessor\nsecond = 2;",
  ])("ends a member where TypeScript does: %s", (source) => {
    expect(parseDiagnostics(`class Fixture { ${source} }`)).toEqual([]);
    const { result } = consume(source, "classElement");
    expect(result.matched).toBe(true);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(printLosslessSequence(result.syntax.children).trim()).toBe(
      typescriptFirstMember(source),
    );
    expect(result.cursor.atEnd).toBe(false);
  });

  // Here the next line continues the member: the line before it cannot end
  // there, or what begins the next line carries the initializer on.
  test.each([
    "first = a +\nb;",
    "first = a\n+ b;",
    "first = a >\nb;",
    "first = a\n[key] = 2;",
    "first = a\n* b;",
    "first = a\ninstanceof B;",
    "first = a\nin b;",
    "first = typeof\na;",
    "first = a satisfies\nT;",
    "first!: keyof\nT;",
    "first!: A |\nB;",
    "first!: A\n| B;",
    "first!: Map<string,\nnumber>;",
    "static\nsecond = 2;",
    "get\nsecond(): number { return 1; }",
    "m(): { a: number } { return { a: 1 }; }",
    "m(): () => { a: number } { return () => ({ a: 1 }); }",
    "m(value: unknown): value is { a: number } { return true; }",
    "m(): { a: number } | { b: string } { return { a: 1 }; }",
    "m<T>(): T extends { a: infer U } ? { u: U } : {} { return null!; }",
    "get m(): { a: number } { return { a: 1 }; }",
  ])("reads one member where TypeScript does: %s", (source) => {
    expect(parseDiagnostics(`class Fixture { ${source} }`)).toEqual([]);
    expect(typescriptFirstMember(source)).toBe(source);
    const { result } = consume(`${source} next = 1;`, "classElement");
    expect(result.matched).toBe(true);
    if (!result.matched)
      throw new Error(result.failure.expectations.join(", "));
    expect(printLosslessSequence(result.syntax.children).trim()).toBe(source);
  });

  test("dispatches type and class-element macro heads", () => {
    const seen: string[] = [];
    const resolver: TypeClassElementMacroResolver = (category, cursor) => {
      const head = cursor.peek();
      if (head?.tag !== "token" || head.raw !== "custom") return undefined;
      seen.push(category);
      cursor.advance();
      return Object.freeze({
        matched: true,
        syntax: createProtectedSyntax({
          id: 99_100 as SyntaxId,
          span: head.span,
          origin: head.origin,
          scopes: head.scopes,
          category,
          children: [head],
        }),
        cursor,
      });
    };
    expect(consume("custom", "type", resolver).result.matched).toBe(true);
    expect(consume("custom", "classElement", resolver).result.matched).toBe(
      true,
    );
    expect(seen).toEqual(["type", "classElement"]);
  });

  test("accepts an empty semicolon class element", () => {
    expect(consume(";", "classElement").result.matched).toBe(true);
  });

  test.each(["@ ;"])("rejects malformed class element %s", (source) => {
    const { result, cursor } = consume(source, "classElement");
    expect(result.matched).toBe(false);
    expect(cursor.index).toBe(0);
  });
});
