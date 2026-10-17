import type { ScopeSetId, SourceId } from "@sweetener/shared";
import type { SlashReading, Syntax } from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  divisionTokens,
  printLossless,
  readSyntax,
  regularExpressionEnd,
  typescriptReadings,
} from "../src/index.js";

const sourceId = 9 as SourceId;
const scopes = 0 as ScopeSetId;

/** The tokens of a read, with each regular expression marked as one. */
function tokens(
  source: string,
  readings: ReadonlyMap<number, SlashReading> = new Map(),
): string[] {
  const read = readSyntax(source, {
    sourceId,
    scopes,
    readings: readings,
  });
  expect(printLossless(read.root)).toBe(source);
  const out: string[] = [];
  const visit = (node: Syntax): void => {
    if (node.tag === "token") {
      if (node.kind !== "end-of-file")
        out.push(
          node.kind === "regular-expression-literal"
            ? `re:${node.raw}`
            : node.raw,
        );
      return;
    }
    if (node.tag === "group") {
      out.push(node.open.raw);
      node.children.forEach(visit);
      if (node.close.tag === "token") out.push(node.close.raw);
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(read.root);
  return out;
}

/**
 * Which of the two a slash begins is the parser's to say; the reader judges
 * from what stands before it and is told otherwise where the enforester found
 * it wrong.
 */
describe("slash readings", () => {
  it("reads a slash the reader judged a division as a regular expression", () => {
    const source = "f() /re/.test(s);";
    expect(tokens(source)).toContain("/");
    expect(tokens(source, new Map([[4, "regular-expression"]]))).toEqual([
      "f",
      "(",
      ")",
      "re:/re/",
      ".",
      "test",
      "(",
      "s",
      ")",
      ";",
    ]);
  });

  it("reads a regular expression the reader judged one as a division", () => {
    const source = "x = y as const / 2 / 3;";
    expect(tokens(source)).toContain("re:/ 2 /");
    expect(tokens(source, new Map([[15, "division"]]))).toEqual([
      "x",
      "=",
      "y",
      "as",
      "const",
      "/",
      "2",
      "/",
      "3",
      ";",
    ]);
  });

  it("reads the rest of the source from the slash on as the reading asks", () => {
    // Read as a division, the `(` inside the expression opened a group that
    // swallowed what followed it, and the read was reported unbalanced. The
    // reader cannot see where an initializer that goes on across a line
    // ends, and reads `, x: T` as an operand's.
    const source = "let w = a\n  + 1, x: T\n/(/.test(s);\nrun();";
    const slash = source.indexOf("/(/");
    expect(readSyntax(source, { sourceId, scopes }).diagnostics).not.toEqual(
      [],
    );
    const read = readSyntax(source, {
      sourceId,
      scopes,
      readings: new Map([[slash, "regular-expression"]]),
    });
    expect(read.diagnostics).toEqual([]);
    expect([...read.readings]).toEqual([[slash, "regular-expression"]]);
  });

  it("reads an element's tag with the slashes in it read as told", () => {
    // Whether `<div` opens an element is read ahead to the end of its tag.
    // Read as a division there, the slash under `let q: T` opened groups the
    // tag never closes, and the `<` was read as a comparison.
    const source = "const el = <div a={() => { let q: T\n/[(]/.test(s); }} />;";
    const slash = source.indexOf("/[");
    const read = readSyntax(source, {
      sourceId,
      scopes,
      variant: "jsx",
      readings: new Map([[slash, "regular-expression"]]),
    });
    expect(read.diagnostics).toEqual([]);
    expect(
      read.root.children.some(
        (node) => node.tag === "group" && node.delimiter === "jsx-element",
      ),
    ).toBe(true);
  });

  it("leaves out a reading the read stood at no slash for", () => {
    // Read as a regular expression, the first slash takes the second inside
    // it, and the reading found for the second in a read where it stood
    // outside no longer applies.
    const read = readSyntax("f() /a/b/c/;", {
      sourceId,
      scopes,
      readings: new Map([
        [4, "regular-expression"],
        [6, "regular-expression"],
      ]),
    });
    expect([...read.readings]).toEqual([[4, "regular-expression"]]);
  });
});

/**
 * The reader judges a slash from what stands before it: the token, and for a
 * closing delimiter, what its group was opened after. These are the cases
 * where that tells what the grammar reads without the enforester.
 */
describe("what the reader judges a slash by", () => {
  it.each([
    ["the head of an if", "if (c) /re/.test(s);", "re:/re/"],
    ["the head of a while", "while (c) /re/.test(s);", "re:/re/"],
    ["the head of a for", "for (;;) /re/.test(s);", "re:/re/"],
    ["the head of a for await", "for await (x of y) /re/.test(s);", "re:/re/"],
    ["a block after a head", "if (c) {}\n/re/.test(s);", "re:/re/"],
    ["a block after else", "if (c) {} else {}\n/re/.test(s);", "re:/re/"],
    ["a block after finally", "try {} finally {}\n/re/.test(s);", "re:/re/"],
    ["a catch block", "try {} catch (e) {}\n/re/.test(s);", "re:/re/"],
    ["an arrow's block", "f = () => {}\n/re/.test(s);", "re:/re/"],
    ["a `for` head's `of`", "for (const x of /a/g.exec(s));", "re:/a/g"],
    ["`await`", "await /a/g.exec(s);", "re:/a/g"],
    ["a prefix `!`", "a\n!/a/.test(s);", "re:/a/"],
    ["an optional call's `(`", "s?.replace?.(/a/, b);", "re:/a/"],
    ["a function declaration", "function f() {}\n/re/.test(s);", "re:/re/"],
    [
      "a function declaration with an object return type",
      "function f(): { a: 1 } {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "a function declaration with an object in its type parameters",
      "function f<T extends { a: 1 } = {}>() {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "an async generator declaration",
      "async function* f() {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "an exported default function",
      "export default function () {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "a function declared after another statement",
      "x = 1\nfunction f() {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "a function declared in a function's body",
      "function f() {\n  function g() {}\n  /re/.test(s);\n}",
      "re:/re/",
    ],
    ["a class declaration", "class C {}\n/re/.test(s);", "re:/re/"],
    [
      "a class declaration with an object in what it extends",
      "class C extends B<{ a: 1 }> implements I {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "a decorated abstract class",
      "@d()\nexport abstract class C {}\n/re/.test(s);",
      "re:/re/",
    ],
    ["an enum declaration", "const enum E { A }\n/re/.test(s);", "re:/re/"],
    [
      "an interface declaration",
      "interface I extends J<{ a: 1 }> {}\n/re/.test(s);",
      "re:/re/",
    ],
    ["a namespace declaration", "namespace N {}\n/re/.test(s);", "re:/re/"],
    ["a module declaration", 'declare module "m" {}\n/re/.test(s);', "re:/re/"],
    ["a global declaration", "declare global {}\n/re/.test(s);", "re:/re/"],
    [
      "a function declared after a label",
      "l: function f() {}\n/re/.test(s);",
      "re:/re/",
    ],
    [
      "a function declared in a case",
      "switch (x) {\n  case a ? b : c:\n    function f() {}\n    /re/.test(s);\n}",
      "re:/re/",
    ],
    [
      "a function declared after default",
      "switch (x) {\n  default:\n    function f() {}\n    /re/.test(s);\n}",
      "re:/re/",
    ],
    ["a switch", "switch (x) {}\n/re/.test(s);", "re:/re/"],
    [
      "a decorated class declaration",
      "@d.e(1)\nclass C {}\n/re/.test(s);",
      "re:/re/",
    ],
  ])("begins a regular expression after %s", (_, source, token) => {
    expect(tokens(source)).toContain(token);
  });

  it.each([
    ["a call", "f(c) / 2 / 3;"],
    ["a method named like a statement", "o.if(c) / 2 / 3;"],
    ["an object literal", "x = {} / 2 / 3;"],
    ["a non-null assertion", "x = a! / 2 / 3;"],
    ["a name spelled `of`", "x = of / 2 / 3;"],
    ["a name spelled `undefined`", "x = undefined / 2 / 3;"],
    ["a name spelled `type`", "x = type / 2 / 3;"],
    ["a function expression", "x = function () {} / 2 / 3;"],
    ["an async function expression", "x = async function () {} / 2 / 3;"],
    ["a class expression", "x = class {} / 2 / 3;"],
    ["an object after an overload", "function f(): void;\nx = {} / 2 / 3;"],
    [
      "a declared function, which has no body",
      "declare function f(): void\nx = a + {} / 2 / 3;",
    ],
    ["a member named `enum`", "class A { enum = 1\n b = 1 + {} / 2 / 3 }"],
    [
      "a member named `function`",
      "class A { function = 1\n b = 1 + {} / 2 / 3 }",
    ],
    [
      "a name spelled `namespace` on a line of its own",
      "namespace\nN\nx = a + {} / 2 / 3;",
    ],
    ["a decorated class expression", "x = @d class {} / 2 / 3;"],
    ["a class in a `for` head", "for (const k of class {} / 2 / 3);"],
    ["a member spelled `else`", "x = o.else / 2 / 3;"],
    ["a member spelled `do`", "x = o?.do / 2 / 3;"],
    [
      "a function assigned to a name spelled `module`",
      "module.exports = function () {} / 2 / 3;",
    ],
    [
      "an object assigned to a name spelled `namespace`",
      "namespace = {} / 2 / 3;",
    ],
  ])("divides after %s", (_, source) => {
    expect(tokens(source).filter((token) => token === "/")).toHaveLength(2);
  });
});

/**
 * What the reader reads the way TypeScript's parser does without being told:
 * each source here needs no reading, so a file of them is read once. Read the
 * other way, each regular expression holding a bracket hid the next from the
 * enforester, and a file of them was read once for each.
 */
describe("where the statements around a token say how it reads", () => {
  it.each([
    // A statement ending with a type.
    ["a variable's type", "let a: string\n/[(]/.test(s);"],
    ["a binding with no type", "let a\n/[(]/.test(s);"],
    ["a pattern's type", "const { a }: T\n/[(]/.test(s);"],
    [
      "type arguments across lines",
      "let a: Map<string,\n  number>\n/[(]/.test(s);",
    ],
    ["a union across lines", "let a: A\n  | B\n/[(]/.test(s);"],
    ["a declarator after an initializer", "let a = 1, b: U\n/[(]/.test(s);"],
    ["type arguments in an initializer", "let a = f<A, B>(c) / 2;"],
    ["a declared constant", "declare const a: string\n/[(]/.test(s);"],
    ["a type alias", "type T = {}\n/[(]/.test(s);"],
    ["a type alias's parameters", "type T<A = B> = A\n/[(]/.test(s);"],
    [
      "a conditional type",
      "type T = A extends B\n  ? C\n  : D\n/[(]/.test(s);",
    ],
    ["an overload", "function f(): string\n/[(]/.test(s);"],
    [
      "an ambient function",
      "declare function f(): void\nfunction g() {}\n/[(]/.test(s);",
    ],
    [
      "generic type parameters",
      "declare function f<T extends (a) => b>(x: T): T\n/[(]/.test(s);",
    ],
    ["an import alias", "import x = A.B\n/[(]/.test(s);"],
    ["a statement after a type", "type T = string\nx = a\n/ b;"],
    ["a block after a type", "let a: string\n{ /[(]/.test(s); }"],
    // A function or a class written as an expression.
    [
      "a function expression's body",
      "foo(function () {\n  a;\n  function g() {}\n  /[(]/.test(s);\n});",
    ],
    [
      "a method's body",
      "const o = { m() {\n  a;\n  function g() {}\n  /[(]/.test(s);\n} };",
    ],
    [
      "a class expression's method",
      "const C = class { m() {\n  a;\n  class D {}\n  /[(]/.test(s);\n} };",
    ],
    ["a class expression divided", "x = class {} / 2;"],
    [
      "a key spelled `class`",
      "o = { class: 1, m() { a; function g() {} /[(]/.test(s); } };",
    ],
    // Statement starts.
    [
      "a static block",
      "class C { static { function f() {}\n/[(]/.test(s); } }",
    ],
    [
      "a parameter's decorator",
      "class A { constructor(@Inject(T) t: T) {} }\nclass B {}\n/[(]/.test(s);",
    ],
    [
      "a last member's decorator",
      "class A {\n  @d x\n}\nclass B {}\n/[(]/.test(s);",
    ],
    ["`export default` braces", "export default {} / 2;"],
    ["a type after `as` in a conditional", "x = c ? w as T : {} / 2;"],
    [
      "a `return` on its own line",
      "function q() { return\nfunction f() {}\n/[(]/.test(s); }",
    ],
    ["`async` on its own line", "x = async\nfunction f() {}\n/[(]/.test(s);"],
    ["`declare` on its own line", "declare\nfunction f() {}\n/[(]/.test(s);"],
    ["a block under an operand", "f(x)\n{ /[(]/.test(s) }"],
  ])("reads a slash after %s as TypeScript does", (_, source) => {
    const { readings, unparsed } = typescriptReadings(source, "standard");
    expect(unparsed).toEqual([]);
    expect([...readings]).toEqual([]);
  });

  it.each([
    [
      "a container after a container",
      "const a = <div>{f(x)}{/[(]/.test(s)}</div>;",
    ],
    ["an element under a type", "let a: T\n<b>(note): x</b>;"],
    ["an element in a function body", "function g() {\n  <b>(note): x</b>;\n}"],
    [
      "an element in a callback's body",
      "foo(function () {\n  a;\n  function g() {}\n  <div>{x}</div>;\n});",
    ],
  ])("reads %s in a JSX file as TypeScript does", (_, source) => {
    const { readings, unparsed } = typescriptReadings(source, "jsx");
    expect(unparsed).toEqual([]);
    expect([...readings]).toEqual([]);
  });
});

describe("reading a slash's text the other way", () => {
  it.each([
    ["a regular expression", "if (c) /a  b/.test(s);", 7, 13],
    ["no expression on the line", "x = a / 2;\ny / 3;", 6, undefined],
  ])("measures where %s a slash would begin ends", (_, source, offset, end) => {
    expect(regularExpressionEnd(source, offset)).toBe(end);
  });

  it("splits a regular expression's text into the division it reads as", () => {
    expect(
      divisionTokens("/ 2 /g")?.map(({ raw, leadingTrivia }) => [
        leadingTrivia.map((trivia) => trivia.raw).join(""),
        raw,
      ]),
    ).toEqual([
      ["", "/"],
      [" ", "2"],
      [" ", "/"],
      ["", "g"],
      ["", ""],
    ]);
  });

  it("reads nothing where the text does not read as tokens", () => {
    expect(divisionTokens("/ - /")).toBeUndefined();
  });

  it("reports an unterminated regular expression where it begins", () => {
    const source = "let y = /abc";
    const [diagnostic] = readSyntax(source, { sourceId, scopes }).diagnostics;
    expect(diagnostic?.primaryOrigin).toMatchObject({ start: 8 });
    expect(diagnostic?.messageArguments).toEqual([
      "Unterminated regular expression literal.",
    ]);
  });
});

describe("TypeScript's reading of a source's slashes", () => {
  it("reads slashes as TypeScript's parser reads them", () => {
    const source =
      "let w = a\n  + 1, x: T\n/(/.test(s);\nx = y as const / 2 / 3;";
    const { readings, unparsed } = typescriptReadings(source, "standard");
    expect([...readings]).toEqual([
      [source.indexOf("/(/"), "regular-expression"],
      [source.indexOf("/ 2"), "division"],
    ]);
    expect(unparsed).toEqual([]);
    expect(
      readSyntax(source, { sourceId, scopes, readings: readings }).diagnostics,
    ).toEqual([]);
  });

  /**
   * TypeScript nests a chain of binary operators one node per operator, and
   * reading its tree by recursion ran out of stack on a chain this long.
   */
  it("reads the slashes of fifty thousand divisions", () => {
    const source = `x = ${Array.from({ length: 50_000 }, () => "a").join(" / ")};\nlet w = a\n  + 1, y: T\n/(/.test(s);`;
    const { readings, unparsed } = typescriptReadings(source, "standard");
    expect(unparsed).toEqual([]);
    expect([...readings]).toEqual([
      [source.indexOf("/(/"), "regular-expression"],
    ]);
  });

  it("answers nothing where the parser could not read the source", () => {
    // TypeScript reads a call and a division where a macro's own syntax is
    // written, and reports the error where it gave up: at `b`, in what it
    // read as the next statement.
    const source = "unless (c) /a  b/.test(s);\nx = a / b / c;";
    const { unparsed } = typescriptReadings(source, "standard");
    const within = (offset: number) =>
      unparsed.some(({ start, end }) => offset >= start && offset < end);
    expect(within(source.indexOf("/a"))).toBe(true);
    expect(within(source.indexOf("/ b"))).toBe(false);
  });

  it("answers nothing for a statement that uses a macro", () => {
    // TypeScript parses this cleanly as divisions, and `unless` reads a
    // regular expression. The statement beside it is answered for.
    const source = "unless(c) /a  +b/i.test(s);\nx = a / b / c;";
    const { unparsed } = typescriptReadings(source, "standard", [0]);
    const within = (offset: number) =>
      unparsed.some(({ start, end }) => offset >= start && offset < end);
    expect(within(source.indexOf("/a"))).toBe(true);
    expect(within(source.indexOf("/ b"))).toBe(false);
  });
});

/** Whether a read of `source` groups an element anywhere in it. */
function groupsElement(syntax: Syntax): boolean {
  if (syntax.tag === "token") return false;
  if (
    syntax.tag === "group" &&
    (syntax.delimiter === "jsx-element" || syntax.delimiter === "jsx-fragment")
  )
    return true;
  return syntax.children.some(groupsElement);
}

describe("the reading of a bare `<T>` in a JSX file", () => {
  const member = "type T = {\n  <b>(note): x</b>;\n}\n";
  // After an initializer that goes on across a line the reader reads `, x:
  // T` as an expression's, and the `<` under it as a comparison; TypeScript
  // reads a declarator and, under it, a statement that begins with an
  // element.
  const statement = "let w = a\n  + 1, x: T\n<b>(note): x</b>;\n";
  const angle = statement.indexOf("<b>");

  it("is judged type parameters where a member begins", () => {
    const read = readSyntax(member, { sourceId, scopes, variant: "jsx" });
    expect(groupsElement(read.root)).toBe(false);
  });

  it("is judged an element where a statement begins", () => {
    const source = "function g() {\n  <b>(note): x</b>;\n}\n";
    const read = readSyntax(source, { sourceId, scopes, variant: "jsx" });
    expect(read.diagnostics).toEqual([]);
    expect(groupsElement(read.root)).toBe(true);
  });

  it("is read as the reading given for it says", () => {
    const read = readSyntax(statement, {
      sourceId,
      scopes,
      variant: "jsx",
      readings: new Map([[angle, "element"]]),
    });
    expect(read.diagnostics).toEqual([]);
    expect(groupsElement(read.root)).toBe(true);
    expect([...read.readings]).toEqual([[angle, "element"]]);
    expect(printLossless(read.root)).toBe(statement);
  });

  it("can be given as type parameters where it would open an element", () => {
    const source = "const e = <b>(note)</b>;\n";
    const read = readSyntax(source, {
      sourceId,
      scopes,
      variant: "jsx",
      readings: new Map([[source.indexOf("<b>"), "type-parameters"]]),
    });
    expect(groupsElement(read.root)).toBe(false);
    expect(printLossless(read.root)).toBe(source);
  });

  it("is applied where the reader judged the `<` to follow an operand", () => {
    // After a name the reader judges no element. Where the enforester reads
    // one beginning there -- after the `}` of a declaration the reader took
    // for an operand's end -- the read follows its reading, as for a slash;
    // unapplied, the reading was asked for again on every read.
    const source = "const e = a\n<b>(c)</b>;\n";
    const angle = source.indexOf("<b>");
    expect(
      groupsElement(
        readSyntax(source, { sourceId, scopes, variant: "jsx" }).root,
      ),
    ).toBe(false);
    const read = readSyntax(source, {
      sourceId,
      scopes,
      variant: "jsx",
      readings: new Map([[angle, "element"]]),
    });
    expect(groupsElement(read.root)).toBe(true);
    expect([...read.readings]).toEqual([[angle, "element"]]);
    expect(printLossless(read.root)).toBe(source);
  });
});

describe("TypeScript's reading of a JSX source's `<`s", () => {
  it("reads an element where TypeScript does", () => {
    const source = "let w = a\n  + 1, x: T\n<b>(note): x</b>;\n";
    const { readings, unparsed } = typescriptReadings(source, "jsx");
    expect(unparsed).toEqual([]);
    expect([...readings]).toEqual([[source.indexOf("<b>"), "element"]]);
    const read = readSyntax(source, {
      sourceId,
      scopes,
      variant: "jsx",
      readings,
    });
    expect(groupsElement(read.root)).toBe(true);
  });

  it("asks for nothing where the reader already agrees", () => {
    const source =
      "interface I { <T>(v: T); }\nconst f: <T>(v: T) => T = (v) => v;\nconst e = <b>(x)</b>;\n";
    expect([...typescriptReadings(source, "jsx").readings]).toEqual([]);
  });
});
