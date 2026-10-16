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
    // swallowed what followed it, and the read was reported unbalanced.
    const source = "let x: T\n/(/.test(s);\nrun();";
    expect(readSyntax(source, { sourceId, scopes }).diagnostics).not.toEqual(
      [],
    );
    const read = readSyntax(source, {
      sourceId,
      scopes,
      readings: new Map([[9, "regular-expression"]]),
    });
    expect(read.diagnostics).toEqual([]);
    expect([...read.readings]).toEqual([[9, "regular-expression"]]);
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
    ["a method named `function`", "x = { function() {} }.a / 2 / 3;"],
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
    const source = "let x: T\n/(/.test(s);\nx = y as const / 2 / 3;";
    const { readings, unparsed } = typescriptReadings(source, "standard");
    expect([...readings]).toEqual([
      [9, "regular-expression"],
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
    const source = `x = ${Array.from({ length: 50_000 }, () => "a").join(" / ")};\nlet y: T\n/(/.test(s);`;
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
  const statement = "function g() {\n  <b>(note): x</b>;\n}\n";
  const angle = statement.indexOf("<b>");

  it("is judged type parameters where a member begins", () => {
    const read = readSyntax(statement, { sourceId, scopes, variant: "jsx" });
    expect(groupsElement(read.root)).toBe(false);
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

  it("is not applied where the reader judges no `<`", () => {
    // After a name a `<` opens type arguments or compares, and is not judged.
    const source = "const e = a <b>(c);\n";
    const read = readSyntax(source, {
      sourceId,
      scopes,
      variant: "jsx",
      readings: new Map([[source.indexOf("<b>"), "element"]]),
    });
    expect(groupsElement(read.root)).toBe(false);
    expect([...read.readings]).toEqual([]);
  });
});

describe("TypeScript's reading of a JSX source's `<`s", () => {
  it("reads an element where TypeScript does", () => {
    const source = "function g() {\n  <b>(note): x</b>;\n}\n";
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
