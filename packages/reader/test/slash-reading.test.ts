import type { ScopeSetId, SourceId } from "@sweetener/shared";
import type { SlashReading, Syntax } from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  nextSlashReadings,
  printLossless,
  readSyntax,
  regularExpressionEnd,
  typescriptSlashReadings,
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
 * from the token before and is told otherwise where the enforester found it
 * wrong.
 */
describe("slash readings", () => {
  it("reads a slash the reader judged a division as a regular expression", () => {
    const source = "if (c) /re/.test(s);";
    expect(tokens(source)).toContain("/");
    expect(tokens(source, new Map([[7, "regular-expression"]]))).toEqual([
      "if",
      "(",
      "c",
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
    const source = "x = of / 2 / 3;";
    expect(tokens(source)).toContain("re:/ 2 /");
    expect(tokens(source, new Map([[7, "division"]]))).toEqual([
      "x",
      "=",
      "of",
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
    const source = "if (c) /(/.test(s);\nrun();";
    expect(readSyntax(source, { sourceId, scopes }).diagnostics).not.toEqual(
      [],
    );
    const read = readSyntax(source, {
      sourceId,
      scopes,
      slashReadings: new Map([[7, "regular-expression"]]),
    });
    expect(read.diagnostics).toEqual([]);
  });

  it("refuses a reading that names no slash", () => {
    expect(() =>
      readSyntax("x = 1;", {
        sourceId,
        scopes,
        slashReadings: new Map([[2, "division"]]),
      }),
    ).toThrow(/No slash at offset 2/u);
  });

  it.each([
    ["a regular expression of names", "/re/", true],
    ["one holding a bracket", "/[a-z]/", false],
    ["one holding a parenthesis", "/(a)/", false],
    ["one holding a quote", "/'/", false],
    ["one holding a comment's opening", "/x\\/*y/", false],
  ])(
    "takes the misreading after %s only where it changed only itself",
    (_, expression, local) => {
      const source = `if (a) ${expression}.test(s);\nif (b) /y/.test(s);\n`;
      const later = source.indexOf("/y/");
      const next = nextSlashReadings(
        source,
        "standard",
        new Map(),
        new Map([
          [7, "regular-expression"],
          [later, "regular-expression"],
        ]),
      );
      expect(next.has(7)).toBe(true);
      expect(next.has(later)).toBe(local);
    },
  );

  it("takes misreadings together up to the first that is not local", () => {
    const source =
      "if (a) /x/.test(s);\nif (b) /(/.test(s);\nif (c) /y/.test(s);";
    const second = source.indexOf("/(/");
    const third = source.indexOf("/y/");
    const next = nextSlashReadings(
      source,
      "standard",
      new Map(),
      new Map([
        [7, "regular-expression"],
        [second, "regular-expression"],
        [third, "regular-expression"],
      ]),
    );
    expect([...next]).toEqual([
      [7, "regular-expression"],
      [second, "regular-expression"],
    ]);
  });

  it("refuses a slash found misread after it was read as asked", () => {
    expect(() =>
      nextSlashReadings(
        "if (c) /re/.test(s);",
        "standard",
        new Map([[7, "regular-expression"]]),
        new Map([[7, "division"]]),
      ),
    ).toThrow(/read as regular-expression and then found misread/u);
  });

  it.each([
    ["a regular expression", "if (c) /a  b/.test(s);", 7, 13],
    ["no expression on the line", "x = a / 2;\ny / 3;", 6, undefined],
  ])("measures where %s a slash would begin ends", (_, source, offset, end) => {
    expect(regularExpressionEnd(source, offset)).toBe(end);
  });

  it("reads slashes as TypeScript's parser reads them", () => {
    const source = "if (c) /(/.test(s);\nx = of / 2 / 3;";
    const readings = typescriptSlashReadings(source, "standard");
    expect([...readings]).toEqual([
      [7, "regular-expression"],
      [source.indexOf("/ 2"), "division"],
    ]);
    expect(
      readSyntax(source, { sourceId, scopes, slashReadings: readings })
        .diagnostics,
    ).toEqual([]);
  });
});
