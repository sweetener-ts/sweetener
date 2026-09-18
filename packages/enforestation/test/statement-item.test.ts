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

  /**
   * Where a variable statement written without a semicolon ends.
   *
   * The declarator loop read whatever followed the initializer as loose tokens
   * until a `;`, so `const h = async` and the arrow written under it were one
   * statement -- and the arrow, swallowed, was never read as the plain arrow it
   * is. TypeScript ends the declaration at the line break, because nothing on
   * the next line can continue the initializer.
   *
   * The boundary is the line break, not the shape of what follows it: an
   * initializer that genuinely continues on the next line -- an operator
   * carried over, an unclosed group -- has been read by the expression parse
   * before this is asked, so what is left after it starts a statement of its
   * own.
   */
  test.each([
    // The `async` of a restricted production: with a line break after it, it
    // is an ordinary name and the arrow under it is its own statement.
    ["const h = async\nv => f();", "const h = async"],
    ["const h = async\nfunction () { return 1; };", "const h = async"],
    // Any other initializer the next line cannot continue ends the same way.
    ["const x = a\nb;", "const x = a"],
    ["const x = a\n++b;", "const x = a"],
    ["var x = 1\nx++;", "var x = 1"],
    ["const { a } = b\nc();", "const { a } = b"],
    ["using r = acquire()\nuse(r);", "using r = acquire()"],
    [
      "const f = function ()\n{ return 1; }\ng();",
      "const f = function ()\n{ return 1; }",
    ],
    ["const x = class\n{}\ng();", "const x = class\n{}"],
    // An initializer that does continue on the next line is one statement, and
    // so is a declarator list broken across lines.
    ["const x = a +\nb;", "const x = a +\nb;"],
    ["const x = {\n a: 1\n};", "const x = {\n a: 1\n};"],
    ["const x = f(\n1\n);", "const x = f(\n1\n);"],
    ["const x = a\n(b);", "const x = a\n(b);"],
    ["const x = a\n[b];", "const x = a\n[b];"],
    ["const x = a\n.b;", "const x = a\n.b;"],
    ["const x = a\n? b : c;", "const x = a\n? b : c;"],
    ["const x = a\n&& b;", "const x = a\n&& b;"],
    ["const x = a\n`t`;", "const x = a\n`t`;"],
    ["const x = a\ninstanceof B;", "const x = a\ninstanceof B;"],
    ["const x = a\n, y = b;", "const x = a\n, y = b;"],
    ["const a = 1,\nb = 2;", "const a = 1,\nb = 2;"],
    ["let x\n= 1;", "let x\n= 1;"],
    ["const x: number\n= 1;", "const x: number\n= 1;"],
    ["let x: Array<\nnumber\n> = [];", "let x: Array<\nnumber\n> = [];"],
    // A declarator's head ends at a line break by the same rule its
    // initializer does: a head is a binder, a `!`, and a `: type`, and nothing
    // else may stand in one.
    ["let x\nfoo();", "let x"],
    ["let x, y\nfoo();", "let x, y"],
    ["let x: A\nfoo();", "let x: A"],
    ["let x: A[]\nfoo();", "let x: A[]"],
    ["let x!: A\nfoo();", "let x!: A"],
    ["let x: { a: number }\nfoo();", "let x: { a: number }"],
    ["let x: A\n[b] = c;", "let x: A"],
    ["const x = async v\n=> v;", "const x = async v"],
    ["let x\n: A = 1;", "let x\n: A = 1;"],
    ["let x: A |\nB = c;", "let x: A |\nB = c;"],
    ["let x: A\n| B = c;", "let x: A\n| B = c;"],
    // `yield` and `await` are words before they are operators, and neither
    // reaches the next line here: `yield` never takes an operand across a line
    // break, and outside an async function `await` is an ordinary name.
    ["const x = yield\nv;", "const x = yield"],
    ["const x = await\nload();", "const x = await"],
    // TypeScript applies `[no LineTerminator here]` before the `=>` of the
    // async arrow written without parentheses, and to no other arrow.
    ["const x = v\n=> v;", "const x = v\n=> v;"],
    ["const x = (v)\n=> v;", "const x = (v)\n=> v;"],
    ["const x = async (v)\n=> v;", "const x = async (v)\n=> v;"],
    ["const x = async <T,>(v: T)\n=> v;", "const x = async <T,>(v: T)\n=> v;"],
    // A `(x)` at the head of a conditional's consequent is the consequent
    // itself where the arrow after the `:` is the alternate, and a parameter
    // list where the arrow it heads ends at the conditional's own `:`.
    ["const r = c ? (x) : (y) => y;", "const r = c ? (x) : (y) => y;"],
    // A concise arrow body is an expression, and ends at a line break where
    // nothing carries it on -- the same rule the initializer around it ends
    // by, read one expression further in.
    ["const h = () => a\nb;", "const h = () => a"],
    ["const h = () => a\n++b;", "const h = () => a"],
    ["const h = () => f\n{ }", "const h = () => f"],
    ["const h = () => f\nlabel: g()", "const h = () => f"],
    ["const h = () => a +\nb;", "const h = () => a +\nb;"],
    ["const h = () => a\n.b;", "const h = () => a\n.b;"],
    ["const h = () => a\n(b);", "const h = () => a\n(b);"],
    ["const h = () => a\n[b];", "const h = () => a\n[b];"],
    ["const h = () => a\n`t`;", "const h = () => a\n`t`;"],
    ["const h = () => a\n, b;", "const h = () => a\n, b;"],
    ["const h = () => c\n? 1 : 2;", "const h = () => c\n? 1 : 2;"],
    ["const h = () => a\ninstanceof B;", "const h = () => a\ninstanceof B;"],
    ["const r = c ? (x): T => x : y;", "const r = c ? (x): T => x : y;"],
    ["const f = (x): T => x;", "const f = (x): T => x;"],
    // `await` and `yield` with no operand of their own are the names they
    // also are, whatever stands after them: TypeScript reads one as an
    // operator only where the next token on its line can be nothing but its
    // operand, and an operator, a punctuator or a group is never that.
    ["const x = await;", "const x = await;"],
    ["const x = yield;", "const x = yield;"],
    ["const x = yield * 2;", "const x = yield * 2;"],
    ["const x = await ? 1 : 2;", "const x = await ? 1 : 2;"],
    ["const x = await + 1;", "const x = await + 1;"],
    ["const x = await - 1;", "const x = await - 1;"],
    ["const x = await * 2;", "const x = await * 2;"],
    ["const x = await (v);", "const x = await (v);"],
    ["const x = await [v];", "const x = await [v];"],
    ["const x = yield + 1;", "const x = yield + 1;"],
    ["const x = yield ? 1 : 2;", "const x = yield ? 1 : 2;"],
  ])("ends the statement of %j at %j, as TypeScript does", (source, extent) => {
    const whole = `${source}\nafter();`;
    const { result } = parse(whole, "stmt");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a variable statement");
    expect(printLosslessSequence(result.syntax.children)).toBe(extent);
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
  });

  /**
   * `async v` and the `=>` written under it are not an async arrow.
   *
   * TypeScript applies `[no LineTerminator here]` before the `=>` of the async
   * arrow written without parentheses, and to no other arrow: `(v)\n=> v` and
   * `async (v)\n=> v` both reach their bodies, which the table above holds it
   * to. What is left here is not a program TypeScript accepts, so it is held
   * to what TypeScript read rather than to where its recovery ended.
   */
  test("reads no async arrow across the line break before its '=>'", () => {
    const whole = "const x = async v\n=> v;\nafter();";
    const { result } = parse(whole, "stmt");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a variable statement");
    expect(
      result.syntax.children.some(
        (child) => child.tag === "protected" && child.form === "arrow",
      ),
    ).toBe(false);
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe("const x = async v");
  });

  /**
   * One declaration, read the same way at statement level and at item level.
   *
   * A declarator's head ends at a line break by one rule, and the two readers
   * had two answers for it. The statement reader walks the head and asks
   * `headContinues` at each break; the item reader handed the annotation
   * straight to the type consumer, which reads a type wherever it is written
   * and so read on past the break. `let x: A` and the `foo();` under it were
   * refused outright at item level -- and a module whose item list refuses is
   * walked as raw tokens, so every macro written in the file is left
   * unexpanded and nothing is reported.
   *
   * The question the two now share is asked of the type grammar when it is
   * asked inside an annotation: a line cannot end after `keyof`, `infer`,
   * `unique`, `readonly`, `extends` or the `import` of `import("m").A` any
   * more than it can after `|`.
   */
  test.each([
    // A head is a binder and a `: type`, and nothing else stands in one.
    ["let x\nfoo();", "let x"],
    ["let x, y\nfoo();", "let x, y"],
    ["let x: A\nfoo();", "let x: A"],
    ["let x: A[]\nfoo();", "let x: A[]"],
    ["let x: { a: number }\nfoo();", "let x: { a: number }"],
    // An array type's `[` is written on the type's own line, so the `[b]`
    // under this annotation begins a statement rather than indexing `A`.
    ["let x: A\n[b] = c;", "let x: A"],
    // An annotation that genuinely carries on across the break is one head,
    // whether the operator ends the line before or begins the line after.
    ["let x: A |\nB = c;", "let x: A |\nB = c;"],
    ["let x: A\n| B = c;", "let x: A\n| B = c;"],
    ["let x: A &\nB = c;", "let x: A &\nB = c;"],
    ["let x: A\n& B = c;", "let x: A\n& B = c;"],
    ["let x: A.\nB = 1;", "let x: A.\nB = 1;"],
    ["let x: A\n.B = 1;", "let x: A\n.B = 1;"],
    ["let x: (a: A)\n=> B = f;", "let x: (a: A)\n=> B = f;"],
    ["let x: Array<\nnumber\n> = [];", "let x: Array<\nnumber\n> = [];"],
    ["let x: A<B>\n= 1;", "let x: A<B>\n= 1;"],
    ["let x: A[\n0] = 1;", "let x: A[\n0] = 1;"],
    // A `>` closes type arguments, and closing them finishes the type they
    // belong to. Read from the expression table, where `>` compares two
    // operands, it held the annotation open across the break and took the
    // statement written under it into the declaration -- which the type
    // reader then refused, leaving the whole module to a raw token walk.
    ["let x: Array<string>\nfoo();", "let x: Array<string>"],
    [
      "let x: Map<string, Array<number>>\nfoo();",
      "let x: Map<string, Array<number>>",
    ],
    ["let x: A.B<C>\nfoo();", "let x: A.B<C>"],
    ["let x: Array<\nnumber\n>\nfoo();", "let x: Array<\nnumber\n>"],
    // An array type's `[` is written on the type's own line here too.
    ["let x: Array<string>\n[0];", "let x: Array<string>"],
    ["let x: A<B>\n| C = 1;", "let x: A<B>\n| C = 1;"],
    ["let x: A<B> |\nC = 1;", "let x: A<B> |\nC = 1;"],
    // A declarator list still ends at its own comma, and only at that one.
    ["let x: Map<A, B>, y: C;", "let x: Map<A, B>, y: C;"],
    ["let x: Map<A, B> = m, y = 2;", "let x: Map<A, B> = m, y = 2;"],
    ["let x = a < b, y = 2;", "let x = a < b, y = 2;"],
    ["let x: Map<A, B>\nfoo();", "let x: Map<A, B>"],
    // `void` is a whole type, not the prefix operator the expression grammar
    // writes with the same word.
    ["let x: void\nfoo();", "let x: void"],
    ["let x: () => void\nfoo();", "let x: () => void"],
    ["let x: new () => void\nfoo();", "let x: new () => void"],
    ["let x: void = undefined\nfoo();", "let x: void = undefined"],
    ["let x: void |\nA = 1;", "let x: void |\nA = 1;"],
    ["let x: A\n| void = 1;", "let x: A\n| void = 1;"],
    ["let x: {\na: number\n} = y;", "let x: {\na: number\n} = y;"],
    ["let x\n: A = 1;", "let x\n: A = 1;"],
    ["const x: number\n= 1;", "const x: number\n= 1;"],
    // The words the type grammar writes a type after: a line cannot end
    // between one and the type it takes.
    ["let x: typeof\nfoo = 1;", "let x: typeof\nfoo = 1;"],
    ["let x: keyof\nA = 1;", "let x: keyof\nA = 1;"],
    ["let x: readonly\nA[] = [];", "let x: readonly\nA[] = [];"],
    ["let x: unique\nsymbol = 1;", "let x: unique\nsymbol = 1;"],
    ["let x: infer\nA = 1;", "let x: infer\nA = 1;"],
    ["let x: A extends\nB ? C : D = e;", "let x: A extends\nB ? C : D = e;"],
    ['let x: import\n("m").A = 1;', 'let x: import\n("m").A = 1;'],
    // A conditional type is written `CheckType [no LineTerminator here]
    // extends`, so an `extends` that begins a line is not the one that carries
    // the annotation on: `let x: A` and the `extends B ? C : D = e;` under it
    // are two statements. The constraint `extends` of a type parameter stands
    // inside the `<` the head holds open, where no line break ends anything.
    ["let x: A\nextends B ? C : D = e;", "let x: A"],
    [
      "let f: <T\nextends A>(v: T) => T = g;",
      "let f: <T\nextends A>(v: T) => T = g;",
    ],
    // A definite assignment's `!` stands in a head, and TypeScript writes it
    // `BindingIdentifier [no LineTerminator here] !`.
    ["let x!: A;", "let x!: A;"],
    ["let x!: A = 1;", "let x!: A = 1;"],
    ["let x!: A\nfoo();", "let x!: A"],
    ["let x!;", "let x!;"],
    ["let x!: A, y!: B;", "let x!: A, y!: B;"],
    ["let x!\n: A = 1;", "let x!\n: A = 1;"],
    ["let x\n!: A = 1;", "let x"],
    // `const enum` is an enum declaration; the `const` of one opens no
    // declarator, so nothing here reads a binder after it.
    ["const enum E { A }", "const enum E { A }"],
    // A declarator list that ends at its comma is what TypeScript reads too,
    // and the trailing comma it disallows is reported against that reading.
    ["let a = 1,;", "let a = 1,;"],
    // An initializer ends by the same rule, and both readers already agreed
    // about that.
    ["const x = 1\nfoo();", "const x = 1"],
    ["const x = a +\nb;", "const x = a +\nb;"],
    ["let x: A = 1, y: B = 2;", "let x: A = 1, y: B = 2;"],
  ])(
    "reads %j as %j at statement level and at item level",
    (source, extent) => {
      const whole = `${source}\nafter();`;
      for (const category of ["stmt", "item"] as const) {
        const { result } = parse(whole, category);
        expect(result.matched, `${category}: ${source}`).toBe(true);
        if (!result.matched) throw new Error("expected a declaration");
        expect(
          printLosslessSequence(result.syntax.children),
          `${category}: ${source}`,
        ).toBe(extent);
      }
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  test("ends an exported declaration's head at the same line break", () => {
    // Only the item reader sees `export`, so the shape that made the bug
    // visible in a real module has no statement-level twin.
    const whole = "export let x: A\nfoo();";
    const { result } = parse(whole, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected an exported declaration");
    expect(printLosslessSequence(result.syntax.children)).toBe(
      "export let x: A",
    );
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe("export let x: A");
  });

  /**
   * The declarations only a module writes, read the same way.
   *
   * `export` and `declare` stand in front of a declaration at item level and
   * nowhere else, so these have no statement-level twin -- but the declarator
   * under them is the same declarator, and the item reader had been reading a
   * different one: a head with a definite assignment's `!` in it was refused
   * outright, and a `const enum` was read as a `const` whose binder was the
   * word `enum`.
   */
  test.each([
    ["export let x!: A;", "export let x!: A;"],
    ["declare let x!: A;", "declare let x!: A;"],
    ["export let x!: A\nfoo();", "export let x!: A"],
    ["declare const enum E { A }", "declare const enum E { A }"],
    ["export const enum E { A }", "export const enum E { A }"],
  ])("reads the module declaration %j as %j", (source, extent) => {
    const whole = `${source}\nafter();`;
    const { result } = parse(whole, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a module declaration");
    expect(printLosslessSequence(result.syntax.children)).toBe(extent);
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
  });

  /**
   * A type alias's body is a type, and it ends where the type grammar says a
   * line break ends one.
   *
   * The walk that reads a declaration whose head is scanned knows nothing of
   * types, so it read `type T = A` and the `extends B ? C : D;` written under
   * it as one item -- where TypeScript, which writes
   * `CheckType [no LineTerminator here] extends`, reads two. The question is
   * the one a declarator's annotation already asks, so the body after the `=`
   * asks it too.
   *
   * The `extends` of a class's or an interface's heritage is written in a
   * declaration's header rather than in a type, and TypeScript does carry it
   * across a line break. Nothing here may change that, so both are held.
   */
  test.each([
    // A conditional type's `extends` may not begin a line.
    ["type T = A\nextends B ? C : D;", "type T = A"],
    ["export type T = A\nextends B ? C : D;", "export type T = A"],
    ["declare type T = A\nextends B ? C : D;", "declare type T = A"],
    // The `=` that opens the body is the one outside the type parameters, so
    // a parameter's default does not open it early.
    ["type T<A = B> = A\nextends C ? D : E;", "type T<A = B> = A"],
    // An array type's `[` and a type argument's `<` may not begin a line
    // either, and `keyof` takes the type after it rather than the one before.
    ["type T = A\n[];", "type T = A"],
    ["type T = A\n<B>;", "type T = A"],
    ["type T = A\nkeyof B;", "type T = A"],
    // A body that genuinely carries on across the break is one item, whether
    // the operator ends the line before or begins the line after.
    ["type T = A extends\nB ? C : D;", "type T = A extends\nB ? C : D;"],
    ["type T =\nA;", "type T =\nA;"],
    ["type T = A |\nB;", "type T = A |\nB;"],
    ["type T = A\n| B;", "type T = A\n| B;"],
    ["type T = A\n& B;", "type T = A\n& B;"],
    ["type T = A.\nB;", "type T = A.\nB;"],
    ["type T = A\n.B;", "type T = A\n.B;"],
    ["type T = { a: A }\n& B;", "type T = { a: A }\n& B;"],
    ["type T = (a: A)\n=> B;", "type T = (a: A)\n=> B;"],
    ["type T = A\n;", "type T = A\n;"],
    // A `<` still open encloses whatever is written under it.
    ["type T = Array<\nA\n>;", "type T = Array<\nA\n>;"],
    // The `>` that closes the type arguments finishes the body, and `void` is
    // a whole type: neither carries the alias on across the break.
    ["type T = Map<A, B>\nconst x = 1;", "type T = Map<A, B>"],
    ["type T = A<B>\nfoo();", "type T = A<B>"],
    ["type T = void\nfoo();", "type T = void"],
    ["type T = A<B>\n| C;", "type T = A<B>\n| C;"],
    ["type T = void |\nA;", "type T = void |\nA;"],
    // A heritage clause is not a type, and TypeScript carries it across the
    // break in both directions.
    ["class C extends A\n{ }", "class C extends A\n{ }"],
    ["class C\nextends A { }", "class C\nextends A { }"],
    ["interface I extends A\n{ }", "interface I extends A\n{ }"],
    ["interface I\nextends A { }", "interface I\nextends A { }"],
    // `type` is also written where it declares nothing, and no `=` opens a
    // body there.
    ['export type { A } from "m";', 'export type { A } from "m";'],
    ['import type { A } from "m";', 'import type { A } from "m";'],
  ])("reads the module item %j as %j", (source, extent) => {
    const whole = `${source}\nafter();`;
    const { result } = parse(whole, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a module item");
    expect(printLosslessSequence(result.syntax.children)).toBe(extent);
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
  });

  /**
   * `declare` marks the declaration after it ambient, and TypeScript reads an
   * ambient declaration wherever a declaration stands -- inside a function
   * body as well as at a module's top level.
   *
   * Only the item reader had taken it. At statement level the `declare` of
   * `declare let x: A;` was a reference to a name spelled `declare`, and the
   * declaration written after it left that reference with nothing terminating
   * it, so the statement was refused for want of a `;`.
   *
   * It is a modifier only where it is written on the declaration's own line:
   * TypeScript writes `declare [no LineTerminator here] Declaration`, and
   * reads `declare` and the `let x = 1;` under it as two statements. The item
   * reader had been taking that `declare` too.
   */
  test.each([
    ["declare let x: A;", "declare let x: A;"],
    ["declare const x: A;", "declare const x: A;"],
    ["declare var x: A;", "declare var x: A;"],
    ["declare let x: A, y: B;", "declare let x: A, y: B;"],
    ["declare let x!: A;", "declare let x!: A;"],
    ["declare function f(): void;", "declare function f(): void;"],
    ["declare class C {}", "declare class C {}"],
    ["declare enum E { A }", "declare enum E { A }"],
    ["declare const enum E { A }", "declare const enum E { A }"],
    ["declare namespace N { }", "declare namespace N { }"],
    ["declare let x: A\nfoo();", "declare let x: A"],
    // A name spelled `declare` is a name wherever no declaration follows it on
    // the same line.
    ["declare;", "declare;"],
    ["declare = 1;", "declare = 1;"],
    ["declare(1);", "declare(1);"],
    ["declare: foo();", "declare: foo();"],
    ["declare\nlet x = 1;", "declare"],
  ])(
    "reads the ambient declaration %j as %j at statement level and at item level",
    (source, extent) => {
      const whole = `${source}\nafter();`;
      for (const category of ["stmt", "item"] as const) {
        const { result } = parse(whole, category);
        expect(result.matched, `${category}: ${source}`).toBe(true);
        if (!result.matched) throw new Error("expected a declaration");
        expect(
          printLosslessSequence(result.syntax.children),
          `${category}: ${source}`,
        ).toBe(extent);
      }
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  /**
   * The same boundary inside the function that admits each word as an
   * operator.
   *
   * A generator's `yield` takes no operand across a line break -- the grammar
   * writes `yield [no LineTerminator here] AssignmentExpression` -- so the
   * declaration ends at the break there as readily as it does outside a
   * generator. `await` carries no such restriction, and an async function's
   * reaches the next line.
   */
  test.each([
    [
      "function* g() {",
      { allowYield: true, allowAwait: false },
      "const x = yield\nv;",
      "const x = yield",
    ],
    [
      "function* g() {",
      { allowYield: true, allowAwait: false },
      "const x = yield v;",
      "const x = yield v;",
    ],
    [
      "async function h() {",
      { allowYield: false, allowAwait: true },
      "const x = await\nload();",
      "const x = await\nload();",
    ],
    [
      "async function h() {",
      { allowYield: false, allowAwait: true },
      "const x = await load();",
      "const x = await load();",
    ],
  ])(
    "ends %s %j at %j, as TypeScript does",
    (header, contexts, source, extent) => {
      const body = `${source}\nafter();`;
      const { result } = parse(body, "stmt", undefined, contexts);
      expect(result.matched).toBe(true);
      if (!result.matched) throw new Error("expected a variable statement");
      expect(printLosslessSequence(result.syntax.children)).toBe(extent);
      const whole = `${header} ${body} }`;
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const declaration = parsed.statements[0];
      if (
        !ts.isFunctionDeclaration(declaration!) ||
        declaration.body === undefined
      )
        throw new Error("expected a function declaration");
      expect(declaration.body.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  /**
   * A global augmentation is a module declaration, and it ends at its body.
   *
   * `global` stood in neither keyword set, so the walk that scans a
   * declaration's head never saw the brace after it as a body: it ran past the
   * closing brace to the next `;` and took whatever was written under the
   * augmentation into the same item. Nothing was refused and nothing was
   * reported -- the item simply held one statement too many, and that
   * statement was never read as one, so a macro invoked there was never
   * expanded.
   *
   * TypeScript reads `global` and the block after it as a module declaration
   * wherever a declaration stands, and carries no line-break restriction with
   * it: `global` and a block written under it are one declaration. Written in
   * front of anything else the word is a name, and `global.x = 1` is an
   * assignment -- so it is the body that makes the declaration, not the word.
   */
  test.each([
    [
      "declare global { interface Window {} }",
      "declare global { interface Window {} }",
    ],
    ["global { interface Window {} }", "global { interface Window {} }"],
    ["global { }", "global { }"],
    ["global\n{ }", "global\n{ }"],
    // The rest of the family already ended at its body, and must go on doing
    // so -- including a `global` written inside one.
    [
      'declare module "x" { export const a: number; }',
      'declare module "x" { export const a: number; }',
    ],
    [
      "declare namespace N { const a: number; }",
      "declare namespace N { const a: number; }",
    ],
    ["namespace N { const a = 1; }", "namespace N { const a = 1; }"],
    ["module N { const a = 1; }", "module N { const a = 1; }"],
    [
      'declare module "x" { global { interface Window {} } }',
      'declare module "x" { global { interface Window {} } }',
    ],
    ["namespace N { global { } }", "namespace N { global { } }"],
    // A name spelled `global` is a name wherever no body follows it.
    ["global;", "global;"],
    ["global = 1;", "global = 1;"],
    ["global(1);", "global(1);"],
    ["global.x = 1;", "global.x = 1;"],
    ["global\n.x = 1;", "global\n.x = 1;"],
  ])(
    "reads the global augmentation %j as %j at statement level and at item level",
    (source, extent) => {
      const whole = `${source}\nafter();`;
      for (const category of ["stmt", "item"] as const) {
        const { result } = parse(whole, category);
        expect(result.matched, `${category}: ${source}`).toBe(true);
        if (!result.matched) throw new Error("expected a declaration");
        expect(
          printLosslessSequence(result.syntax.children),
          `${category}: ${source}`,
        ).toBe(extent);
      }
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  test("reads an exported global augmentation as one module item", () => {
    // Only the item reader sees `export`, so this shape has no
    // statement-level twin.
    const whole = "export declare global { }\nafter();";
    const { result } = parse(whole, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a module declaration");
    expect(printLosslessSequence(result.syntax.children)).toBe(
      "export declare global { }",
    );
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe(
      "export declare global { }",
    );
  });

  /**
   * The declarations TypeScript reads inside a function body, read there too.
   *
   * A type alias, an abstract class and a global augmentation all stand in a
   * function body, and the statement reader refused every one of them: `type`
   * and `abstract` were never dispatched to the walk that scans a
   * declaration's head, so they fell to the expression path and failed for
   * want of a terminator. A refused statement costs the block that holds it
   * its structure -- the whole block falls back to a raw token walk -- so a
   * single type alias anywhere in a function silently took the statements
   * around it with it.
   *
   * `import` and `export` are the two TypeScript reads there and rejects
   * afterwards, and they stay refused; see the note on the statement reader's
   * declaration dispatch.
   */
  test.each([
    ["type T = A;", "type T = A;"],
    ["type T<A> = A;", "type T<A> = A;"],
    ["type T = { a: number };", "type T = { a: number };"],
    ["declare type T = A;", "declare type T = A;"],
    ["abstract class C {}", "abstract class C {}"],
    ["declare abstract class C {}", "declare abstract class C {}"],
    [
      "declare global { interface Window {} }",
      "declare global { interface Window {} }",
    ],
    // An alias's body is a type, and it ends where the type grammar ends one.
    // The item reader already asked that question; the statement reader asks
    // the same one.
    ["type T = A\nextends B ? C : D;", "type T = A"],
    ["type T = A\n[];", "type T = A"],
    ["type T = A\n<B>;", "type T = A"],
    ["type T = A\nkeyof B;", "type T = A"],
    ["type T<A = B> = A\nextends C ? D : E;", "type T<A = B> = A"],
    ["type T =\nA;", "type T =\nA;"],
    ["type T = A |\nB;", "type T = A |\nB;"],
    ["type T = A\n| B;", "type T = A\n| B;"],
    ["type T = Array<\nA\n>;", "type T = Array<\nA\n>;"],
    ["type T = A<B>\nfoo();", "type T = A<B>"],
    ["type T = void\nfoo();", "type T = void"],
    ["type T = A<B>\n| C;", "type T = A<B>\n| C;"],
    // A name spelled `type` or `abstract` is a name.
    ["type;", "type;"],
    ["type = 1;", "type = 1;"],
    ["abstract;", "abstract;"],
    ["abstract = 1;", "abstract = 1;"],
  ])(
    "reads %j as %j in a function body, as TypeScript does",
    (source, extent) => {
      const body = `${source}\nafter();`;
      const { result } = parse(body, "stmt");
      expect(result.matched, source).toBe(true);
      if (!result.matched) throw new Error("expected a statement");
      expect(printLosslessSequence(result.syntax.children), source).toBe(
        extent,
      );
      const whole = `function enclosing() {\n${body}\n}`;
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const declaration = parsed.statements[0];
      if (
        !ts.isFunctionDeclaration(declaration!) ||
        declaration.body === undefined
      )
        throw new Error("expected a function declaration");
      expect(declaration.body.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  /**
   * A contextual keyword heads a declaration only where the name it declares
   * is written on its own line.
   *
   * `type`, `interface`, `namespace` and `module` are names as readily as they
   * are keywords, and TypeScript writes each of them
   * `keyword [no LineTerminator here] Identifier`: `type` and the `T = A;`
   * under it are two statements, the first of them a reference to a name.
   * Both readers had been taking the word for a keyword wherever it stood and
   * swallowing the statement under it -- the same silent mis-parse the missing
   * `global` caused, arrived at from the other side.
   *
   * The reserved words carry no such restriction, and `class` and the `C { }`
   * written under it are one declaration however the lines fall. `global` is
   * contextual and carries none either, because what follows it is a body
   * rather than a name. Both are held here.
   */
  test.each([
    ["type\nT = A;", "type"],
    ["namespace\nN { }", "namespace"],
    ["module\nN { }", "module"],
    ["declare\nlet x = 1;", "declare"],
    ["abstract\nclass C { }", "abstract"],
    // Must not change: a reserved word needs nothing on its own line.
    ["class\nC { }", "class\nC { }"],
    ["enum\nE { }", "enum\nE { }"],
    ["function\nf() { }", "function\nf() { }"],
    ["let\nx = 1;", "let\nx = 1;"],
    ["const\nx = 1;", "const\nx = 1;"],
    ["var\nx = 1;", "var\nx = 1;"],
    ["global\n{ }", "global\n{ }"],
  ])(
    "reads %j as %j at statement level and at item level, as TypeScript does",
    (source, extent) => {
      const whole = `${source}\nafter();`;
      for (const category of ["stmt", "item"] as const) {
        const { result } = parse(whole, category);
        expect(result.matched, `${category}: ${source}`).toBe(true);
        if (!result.matched) throw new Error("expected a statement");
        expect(
          printLosslessSequence(result.syntax.children),
          `${category}: ${source}`,
        ).toBe(extent);
      }
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  /**
   * `interface` obeys the same rule, and what is left of it cannot be read.
   *
   * TypeScript reads `interface` and the `I { }` written under it as two
   * statements, the first of them a reference to a name -- but `interface` is
   * reserved under strict mode, and every module is strict, so that name is
   * one it only recovers to and reports. There is no reading of it here to
   * hold, and the declaration is refused instead of swallowing the `I { }`
   * under it.
   */
  test.each(["stmt", "item"] as const)(
    "refuses an interface whose name is written on the next line: %s",
    (category) => {
      const { result } = parse("interface\nI { }\nafter();", category);
      expect(result.matched).toBe(false);
    },
  );

  /**
   * A prefix type assertion is an operand, and `<A>y` is one.
   *
   * It was refused at both levels, and the declaration around it with it, so a
   * `.sts` file with one `<A>y` in it lost the structure of whatever block or
   * module held it and every macro written there went unexpanded.
   *
   * TypeScript reads the assertion only where JSX is off, and the reader has
   * already settled that: in `.stsx` it groups the same text into a
   * `jsx-element`, so a `<` still standing here as a token was read from a
   * `.sts` file. The row below with the arrow in it is the ambiguity
   * TypeScript resolves in the arrow's favour, and it is held unchanged.
   */
  test.each([
    ["let x = <A>y;", "let x = <A>y;"],
    ["let x = <const>y;", "let x = <const>y;"],
    ["let x = <A[]>y;", "let x = <A[]>y;"],
    ["let x = <A<B>>y;", "let x = <A<B>>y;"],
    ["let x = <{ a: number }>y;", "let x = <{ a: number }>y;"],
    // `TypeAssertion: < Type > UnaryExpression`, so the assertion takes what
    // `!` would: the member access, and not the sum.
    ["let x = <A>y.z;", "let x = <A>y.z;"],
    ["let x = <A>y + 1;", "let x = <A>y + 1;"],
    ["let x = <A><B>y;", "let x = <A><B>y;"],
    ["f(<A>y);", "f(<A>y);"],
    ["const x = <A>y;", "const x = <A>y;"],
    // An assertion is a unary expression, so it stands to the left of `**`
    // only in parentheses -- the rule the reader already applies to `-x ** 2`.
    ["let x = (<A>y) ** 2;", "let x = (<A>y) ** 2;"],
    // Must not change: a generic arrow is written with the same `<...>`, and
    // TypeScript reads the arrow.
    ["let x = <A>(v) => v;", "let x = <A>(v) => v;"],
    ["let x = <A, B>(v) => v;", "let x = <A, B>(v) => v;"],
    ["let x = a < b;", "let x = a < b;"],
    ["let x = a < b > c;", "let x = a < b > c;"],
  ])(
    "reads %j as %j at statement level and at item level, as TypeScript does",
    (source, extent) => {
      const whole = `${source}\nafter();`;
      for (const category of ["stmt", "item"] as const) {
        const { result } = parse(whole, category);
        expect(result.matched, `${category}: ${source}`).toBe(true);
        if (!result.matched) throw new Error("expected a statement");
        expect(
          printLosslessSequence(result.syntax.children),
          `${category}: ${source}`,
        ).toBe(extent);
      }
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements[0]?.getText(parsed)).toBe(extent);
    },
  );

  test.each(["stmt", "item"] as const)(
    "refuses an unparenthesized type assertion before '**': %s",
    (category) => {
      // TypeScript reports "A type assertion expression is not allowed in the
      // left-hand side of an exponentiation expression" for this, and the rule
      // it comes from is the one the reader already applies to `-x ** 2`.
      const { result } = parse("const x = <A>y ** 2;", category);
      expect(result.matched).toBe(false);
    },
  );

  test.each(["stmt", "item"] as const)(
    "refuses an optional chain with no member rather than reading past it: %s",
    (category) => {
      // `a?.` has nothing after it that can be a member, and the primary
      // consumer reports that with the cursor already past the `?.`. The `<`
      // it then stands at begins no operand, and reading a type assertion
      // from there dropped the `a?.` in front of it out of the declaration
      // without a word.
      const { result } = parse("const x = a?.<A>b;", category);
      expect(result.matched).toBe(false);
    },
  );

  test("leaves a prefix type assertion to the reader in a jsx source", () => {
    // Nothing here refuses the assertion in a `.stsx` file, because nothing
    // here ever sees one: the reader groups `<A>y` into a jsx-element and
    // reports it, exactly as TypeScript's `.tsx` parser does. That grouping is
    // what keeps the rule above from firing where JSX is on, so it is held.
    const origins = new OriginStore();
    const read = readSyntax("let x = <A>y;", {
      sourceId,
      scopes: 0 as ScopeSetId,
      originStore: origins,
      variant: "jsx",
    });
    expect(read.diagnostics.length).toBeGreaterThan(0);
    const grouped = read.root.children.find(
      (node) => node.tag === "group" && node.delimiter === "jsx-element",
    );
    expect(grouped).toBeDefined();
    const parsed = ts.createSourceFile(
      "fixture.tsx",
      "let x = <A>y;",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const diagnostics = (
      parsed as ts.SourceFile & {
        readonly parseDiagnostics: readonly ts.Diagnostic[];
      }
    ).parseDiagnostics;
    expect(diagnostics.length).toBeGreaterThan(0);
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

  /**
   * A binder is named by any word TypeScript does not reserve.
   *
   * The reader labels `type`, `from`, `of` and every other contextual keyword
   * a keyword token, as TypeScript's own scanner does, and the binding
   * consumer had asked for the `identifier` label instead. So `let type = 1;`
   * was refused at item level -- and an item the reader refuses drops the
   * whole module to a raw token walk, where a macro at statement head is
   * silently not expanded. The statement reader scans its head rather than
   * parsing a binder, so it had always read these; the two now agree.
   *
   * What TypeScript reserves is the list `isIdentifierToken` already holds,
   * strict-mode reservations included: every module is strict, and
   * `let interface = 1;` is "Identifier expected. 'interface' is a reserved
   * word in strict mode. Modules are automatically in strict mode." So the
   * rule is written once, where that list is, rather than per binder position.
   */
  test.each([
    "type",
    "from",
    "of",
    "global",
    "module",
    "namespace",
    "declare",
    "abstract",
    "asserts",
    "as",
    "is",
    "any",
    "unknown",
    "never",
    "undefined",
    "object",
    "string",
    "number",
    "boolean",
    "bigint",
    "symbol",
    "satisfies",
    "keyof",
    "infer",
    "readonly",
    "unique",
    "out",
    "override",
    "accessor",
    "async",
    "get",
    "set",
    "require",
    "intrinsic",
    "constructor",
    "assert",
    "using",
    "defer",
  ])("binds a declarator named %s at both levels", (word) => {
    const source = `let ${word} = 1;`;
    const whole = `${source}\nafter();`;
    for (const category of ["stmt", "item"] as const) {
      const { result } = parse(whole, category);
      expect(result.matched, `${category}: ${source}`).toBe(true);
      if (!result.matched) throw new Error("expected a declaration");
      expect(
        printLosslessSequence(result.syntax.children),
        `${category}: ${source}`,
      ).toBe(source);
    }
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe(source);
    expect(
      (
        parsed as ts.SourceFile & {
          readonly parseDiagnostics: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics,
    ).toEqual([]);
  });

  /**
   * The same word in every binder position a declarator writes, so the rule is
   * asked once rather than per shape.
   */
  test.each([
    "let type: number = 1;",
    "const { type } = source;",
    "const { source: type } = source;",
    "const { ...type } = source;",
    "const [type] = source;",
    "const [, type = 1] = source;",
    "let type = 1, from = 2;",
    "let { type, from } = source;",
    "declare let namespace: number;",
    "export let module: number;",
  ])("binds %j at item level", (source) => {
    const whole = `${source}\nafter();`;
    const { result } = parse(whole, "item");
    expect(result.matched, source).toBe(true);
    if (!result.matched) throw new Error("expected a declaration");
    expect(printLosslessSequence(result.syntax.children)).toBe(source);
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed)).toBe(source);
  });

  /**
   * A reserved word names nothing, and the item reader must go on refusing it.
   * TypeScript refuses each of these too -- the ones reserved only in strict
   * mode are refused because a module is strict, which the reader takes as
   * given for every file it reads.
   */
  test.each([
    "let in = 1;",
    "let class = 1;",
    "let function = 1;",
    "let this = 1;",
    "let typeof = 1;",
    "let null = 1;",
    "let true = 1;",
    "let interface = 1;",
    "let package = 1;",
    "let private = 1;",
    "let static = 1;",
    "let implements = 1;",
    "let yield = 1;",
  ])("refuses the reserved binder %j at item level", (source) => {
    const { result } = parse(`${source}\nafter();`, "item");
    expect(result.matched, source).toBe(false);
  });

  /**
   * An import or export declaration ends at the line break TypeScript ends it
   * at.
   *
   * The item walk broke at a leading line break only in front of a word that
   * begins an item, and what follows a module's imports is usually a call. So
   * `import a from "m"` written without a `;` took the statement under it into
   * the same item: nothing refused, nothing reported, and the macro that
   * statement invoked was never reached -- the shape every silent reader bug
   * found this week has.
   *
   * The rule is TypeScript's own: the declaration carries on across a line
   * break only where what stands in front of the break expects more, or what
   * stands after it continues what was written. Both halves are asked of every
   * import and export form rather than of the one that showed the bug.
   */
  test.each([
    ['import a from "m"', 'import a from "m"'],
    ['import global from "m"', 'import global from "m"'],
    ['import "m"', 'import "m"'],
    ['import * as ns from "m"', 'import * as ns from "m"'],
    ['import { a } from "m"', 'import { a } from "m"'],
    ['import a, { b } from "m"', 'import a, { b } from "m"'],
    ['import type { a } from "m"', 'import type { a } from "m"'],
    ['import a = require("m")', 'import a = require("m")'],
    ['export * from "m"', 'export * from "m"'],
    ['export { a } from "m"', 'export { a } from "m"'],
    ["export { a }", "export { a }"],
    ["export default a", "export default a"],
    ["export = a", "export = a"],
    ["export as namespace N", "export as namespace N"],
    // What a line break may stand inside must not change: TypeScript reads
    // every one of these as a single declaration.
    ['import a\nfrom "m";', 'import a\nfrom "m";'],
    ['import a from\n"m";', 'import a from\n"m";'],
    ['import\na from "m";', 'import\na from "m";'],
    ['import a,\n{ b } from "m";', 'import a,\n{ b } from "m";'],
    ['import *\nas ns from "m";', 'import *\nas ns from "m";'],
    ['import a =\nrequire("m");', 'import a =\nrequire("m");'],
    [
      'import "m"\nwith { type: "json" };',
      'import "m"\nwith { type: "json" };',
    ],
    ['export { a }\nfrom "m";', 'export { a }\nfrom "m";'],
    ['export *\nfrom "m";', 'export *\nfrom "m";'],
    ["export default a\n+ 1;", "export default a\n+ 1;"],
    ["export = a\n+ 1;", "export = a\n+ 1;"],
    ["export as\nnamespace N;", "export as\nnamespace N;"],
    // `namespace` written after `export as` marks a UMD global rather than
    // declaring a name, and TypeScript carries it across the break.
    ["export as namespace\nN;", "export as namespace\nN;"],
    // The `type` of a type-only import or export stands in front of a `{` or
    // a `*` rather than a name, and carries no line-break restriction either.
    ['export type\n{ A } from "m";', 'export type\n{ A } from "m";'],
    ['import type\n{ A } from "m";', 'import type\n{ A } from "m";'],
    ['export type { A }\nfrom "m";', 'export type { A }\nfrom "m";'],
    // A `;` terminates the declaration wherever it is written, line break or
    // no line break.
    ['import a from "m"\n;', 'import a from "m"\n;'],
  ])("reads the module declaration %j as %j", (source, extent) => {
    const whole = `${source}\nafter();`;
    const { result } = parse(whole, "item");
    expect(result.matched, source).toBe(true);
    if (!result.matched) throw new Error("expected a module declaration");
    expect(printLosslessSequence(result.syntax.children), source).toBe(extent);
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed), source).toBe(extent);
    expect(
      (
        parsed as ts.SourceFile & {
          readonly parseDiagnostics: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics,
      source,
    ).toEqual([]);
  });

  /**
   * A contextual keyword written behind `export` is a keyword only where what
   * it declares is written on its own line.
   *
   * `declarationHead` was asked of an item's first word alone, so the `type`
   * of `export type` and the `namespace` of `export namespace` were never
   * asked at all. TypeScript reads each of those words alone -- it writes
   * `type [no LineTerminator here] Identifier` -- and reads what stands under
   * it as a statement of its own. Read as one item, that statement was
   * swallowed, and a macro invoked there never ran.
   *
   * TypeScript recovers from the stray `export` by dropping it, so its first
   * statement is the word alone; what both readers must agree about is where
   * the item ends, which is what the second statement shows.
   */
  test.each([
    ["export type\nT = A;", "export type", ["type", "T = A;", "after();"]],
    [
      "export namespace\nN { }",
      "export namespace",
      ["namespace", "N", "{ }", "after();"],
    ],
    [
      "export interface\nI { }",
      "export interface",
      ["interface", "I", "{ }", "after();"],
    ],
    [
      "export module\nM { }",
      "export module",
      ["module", "M", "{ }", "after();"],
    ],
    [
      "export declare\nlet x = 1;",
      "export declare",
      ["declare", "let x = 1;", "after();"],
    ],
    [
      "export abstract\nclass C { }",
      "export abstract",
      ["abstract", "class C { }", "after();"],
    ],
  ])(
    "ends %j at the contextual keyword's own line",
    (source, extent, statements) => {
      const whole = `${source}\nafter();`;
      const { result } = parse(whole, "item");
      expect(result.matched, source).toBe(true);
      if (!result.matched) throw new Error("expected a module item");
      expect(printLosslessSequence(result.syntax.children), source).toBe(
        extent,
      );
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements.map((node) => node.getText(parsed))).toEqual(
        statements,
      );
    },
  );

  /**
   * A `;` written after a declaration's body is an empty statement, not part
   * of the declaration.
   *
   * The statement reader already read it that way and the item reader did
   * not, so the same `namespace N { };` was two nodes inside a function body
   * and one at a module's top level. TypeScript reads two wherever it is
   * written, and reports nothing about either.
   */
  test.each([
    ["namespace N { };", "namespace N { }"],
    ["module M { };", "module M { }"],
    ["class C {};", "class C {}"],
    ["enum E {};", "enum E {}"],
    ["interface I {};", "interface I {}"],
    ["function f() {};", "function f() {}"],
    ["declare global { };", "declare global { }"],
    ["export class C {};", "export class C {}"],
  ])("reads %j as %j at both levels", (source, extent) => {
    const whole = `${source}\nafter();`;
    for (const category of ["stmt", "item"] as const) {
      // `export` stands only at item level, so the exported row is asked
      // there alone.
      if (category === "stmt" && source.startsWith("export")) continue;
      const { result } = parse(whole, category);
      expect(result.matched, `${category}: ${source}`).toBe(true);
      if (!result.matched) throw new Error("expected a declaration");
      expect(
        printLosslessSequence(result.syntax.children),
        `${category}: ${source}`,
      ).toBe(extent);
    }
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed), source).toBe(extent);
    expect(parsed.statements[1]?.getText(parsed), source).toBe(";");
    expect(
      (
        parsed as ts.SourceFile & {
          readonly parseDiagnostics: readonly ts.Diagnostic[];
        }
      ).parseDiagnostics,
      source,
    ).toEqual([]);
  });

  /**
   * `export` carries the declaration written after it, and a `;` is an empty
   * statement rather than a declaration. TypeScript reports the `export`
   * where it stands and reads the `;` as a statement of its own.
   */
  test("does not take an empty statement into an export that exports nothing", () => {
    const whole = "export;\nafter();";
    const { result } = parse(whole, "item");
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("expected a module item");
    expect(printLosslessSequence(result.syntax.children)).toBe("export");
    const parsed = ts.createSourceFile(
      "fixture.ts",
      whole,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements.map((node) => node.getText(parsed))).toEqual([
      ";",
      "after();",
    ]);
  });

  /**
   * A module declaration and a global augmentation begin a statement, and a
   * declaration whose head has not closed ends in front of one.
   *
   * The statement reader dispatches on `module` and on the `global` of an
   * augmentation -- both stand wherever a declaration does, inside a function
   * body as readily as at a module's top level -- but the walk that scans a
   * declaration's head knew neither. So it read straight past the line break
   * and took the whole declaration written under it into the one above:
   * `function f()` and the `module M { }` under it were one statement, where
   * TypeScript reads two. Both walks now ask the one question the dispatch
   * asks.
   */
  test.each([
    "function f()\nmodule M { }",
    "function f()\nglobal { }",
    "namespace N\nmodule M { }",
    "interface I\nglobal { }",
    "type T\nmodule M { }",
    "enum E\nmodule M { }",
    "class C\nglobal { }",
  ])("does not read %j as one statement", (source) => {
    const statement = parse(source, "stmt").result;
    const item = parse(source, "item").result;
    const read = (result: typeof statement) =>
      result.matched
        ? printLosslessSequence(result.syntax.children)
        : undefined;
    // Whatever either reader makes of a declaration left without a body, it
    // is not the two declarations together -- and both make the same of it.
    expect(read(statement), source).not.toBe(source);
    expect(read(item), source).toBe(read(statement));
    // TypeScript reads what is written under the break as its own statement.
    const parsed = ts.createSourceFile(
      "fixture.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements.length, source).toBeGreaterThan(1);
  });

  /**
   * `global` and `module` name things as readily as they declare them, and
   * neither reader may take one for a declaration where no body stands after
   * it.
   */
  test.each([
    ["global.value = 1;", "global.value = 1;"],
    ["let x = 1\nglobal.value = 2;", "let x = 1"],
  ])("reads %j as %j at both levels", (source, extent) => {
    for (const category of ["stmt", "item"] as const) {
      const { result } = parse(source, category);
      expect(result.matched, `${category}: ${source}`).toBe(true);
      if (!result.matched) throw new Error("expected a statement");
      expect(
        printLosslessSequence(result.syntax.children),
        `${category}: ${source}`,
      ).toBe(extent);
    }
    const parsed = ts.createSourceFile(
      "fixture.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(parsed.statements[0]?.getText(parsed), source).toBe(extent);
  });

  /**
   * An instantiation expression -- `y<string>`, a generic value with its type
   * arguments supplied and no call after them -- is an expression TypeScript
   * reads, and both readers had refused it.
   *
   * A `<...>` after an operand was taken for type arguments only where a call
   * or a tagged template followed, and read as a comparison otherwise. So
   * `const f = y<string>;` was refused, which drops the module holding it to a
   * raw token walk and leaves every macro in it unexpanded.
   *
   * TypeScript settles the ambiguity by what stands after the `>`: a `(` or a
   * template makes it a call, a `<`, `>`, `+` or `-` makes it a comparison,
   * and otherwise it is the type arguments wherever a line break, a binary
   * operator, or something that cannot begin an operand follows them.
   */
  test.each([
    ["const f = y<string>;", "const f = y<string>;"],
    ["const g = y<A, B>;", "const g = y<A, B>;"],
    ["y<A>;", "y<A>;"],
    ["y<A>.b;", "y<A>.b;"],
    ["f(y<A>);", "f(y<A>);"],
    ["const k = [y<A>];", "const k = [y<A>];"],
    // Nothing else may change: a call, a tagged template and a comparison are
    // what TypeScript reads them as still.
    ["y<A>(x);", "y<A>(x);"],
    ["y<A>`t`;", "y<A>`t`;"],
    ["a < b > c;", "a < b > c;"],
    ["const h = y<A> + 1;", "const h = y<A> + 1;"],
    ["const i = y<A> - 1;", "const i = y<A> - 1;"],
    // A line break after the type arguments settles it for the instantiation,
    // and the name written under it is a statement of its own.
    ["y<A>", "y<A>"],
  ])(
    "reads the instantiation expression %j as %j at both levels",
    (source, extent) => {
      const whole = `${source}\nafter();`;
      for (const category of ["stmt", "item"] as const) {
        const { result } = parse(whole, category);
        expect(result.matched, `${category}: ${source}`).toBe(true);
        if (!result.matched) throw new Error("expected a statement");
        expect(
          printLosslessSequence(result.syntax.children),
          `${category}: ${source}`,
        ).toBe(extent);
      }
      const parsed = ts.createSourceFile(
        "fixture.ts",
        whole,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(parsed.statements[0]?.getText(parsed), source).toBe(extent);
    },
  );
});
