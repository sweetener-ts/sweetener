import type { ScopeSetId, SourceId } from "@sweetener/shared";
import type { SlashReading, Syntax } from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  divisionTokens,
  printLossless,
  readSyntax,
  regularExpressionEnd,
  typescriptSlashes,
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
    slashReadings: readings,
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
      slashReadings: new Map([[9, "regular-expression"]]),
    });
    expect(read.diagnostics).toEqual([]);
    expect([...read.slashReadings]).toEqual([[9, "regular-expression"]]);
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
      slashReadings: new Map([[slash, "regular-expression"]]),
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
      slashReadings: new Map([
        [4, "regular-expression"],
        [6, "regular-expression"],
      ]),
    });
    expect([...read.slashReadings]).toEqual([[4, "regular-expression"]]);
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
    const { readings, unparsed } = typescriptSlashes(source, "standard");
    expect([...readings]).toEqual([
      [9, "regular-expression"],
      [source.indexOf("/ 2"), "division"],
    ]);
    expect(unparsed).toEqual([]);
    expect(
      readSyntax(source, { sourceId, scopes, slashReadings: readings })
        .diagnostics,
    ).toEqual([]);
  });

  /**
   * TypeScript nests a chain of binary operators one node per operator, and
   * reading its tree by recursion ran out of stack on a chain this long.
   */
  it("reads the slashes of fifty thousand divisions", () => {
    const source = `x = ${Array.from({ length: 50_000 }, () => "a").join(" / ")};\nlet y: T\n/(/.test(s);`;
    const { readings, unparsed } = typescriptSlashes(source, "standard");
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
    const { unparsed } = typescriptSlashes(source, "standard");
    const within = (offset: number) =>
      unparsed.some(({ start, end }) => offset >= start && offset < end);
    expect(within(source.indexOf("/a"))).toBe(true);
    expect(within(source.indexOf("/ b"))).toBe(false);
  });
});
