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
