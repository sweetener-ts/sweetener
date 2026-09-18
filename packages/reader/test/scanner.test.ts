import type { SourceId } from "@sweetener/shared";
import { describe, expect, it } from "vitest";
import {
  assertSupportedTypeScriptVersion,
  reconstructScannedSource,
  scanTypeScript,
  supportedTypeScriptMajorMinor,
  UnsupportedTypeScriptVersionError,
} from "../src/index.js";

const sourceId = 1 as SourceId;

describe("TypeScript scanner adapter", () => {
  it("leaves each closing angle of nested type arguments its own token", () => {
    // Every reader that counts type-argument depth relies on this: a `>` may
    // close type arguments, so the scanner never joins two of them, and `>>`
    // reaches a reader only as the shift operator it is written as.
    const nested = scanTypeScript("type T = Map<string, Array<number>>;", {
      sourceId,
    });
    expect(
      nested.tokens
        .filter(({ raw }) => raw.startsWith(">"))
        .map(({ raw }) => raw),
    ).toEqual([">", ">"]);
    const shift = scanTypeScript("const shifted = value >> 2;", { sourceId });
    expect(
      shift.tokens
        .filter(({ raw }) => raw.startsWith(">"))
        .map(({ raw }) => raw),
    ).toEqual([">", ">"]);
  });

  /**
   * The same of every path that reads a `>`, because the adapter counts
   * type-argument depth one angle at a time and carried a width for `>>` and
   * `>>>` that nothing could produce.
   *
   * TypeScript's scanner emits `GreaterThanToken` per character and leaves
   * joining them to `reScanGreaterToken`, which the parser calls where a
   * shift or a shift-assignment is what it is reading. This adapter never
   * calls it -- it rescans only slashes, templates, hashes and JSX -- so no
   * token it produces carries more than one angle, whichever mode it is read
   * in.
   */
  it.each([
    ["a shift and its assignments", "a >>= b; a >>>= c; a >= d;", "standard"],
    [
      "a type argument closing three at once",
      "type T = A<B<C<D>>>;",
      "standard",
    ],
    [
      "a template literal type",
      "type U = `${Uppercase<Lowercase<'a'>>}`;",
      "standard",
    ],
    [
      "type arguments on a call",
      "const g = f<Array<Map<K, V>>>();",
      "standard",
    ],
    [
      "a type parameter list",
      "class C<T extends Array<Set<U>>> {}",
      "standard",
    ],
    [
      "type arguments on a JSX tag",
      "const e = <Box<Item<T>> on={a >> b}>t</Box>;",
      "jsx",
    ],
    [
      "a generic arrow written in JSX",
      "const x = <A<B<C>>,>(v: A) => v;",
      "jsx",
    ],
    [
      "a shift inside a JSX expression",
      "const p = <div a={c >>> d}>{e}</div>;",
      "jsx",
    ],
  ] as const)("spells every angle as one token: %s", (_, source, variant) => {
    const scanned = scanTypeScript(source, { sourceId, variant });
    expect(
      scanned.tokens
        .filter(({ kind, raw }) => kind === "punctuation" && raw.includes(">"))
        .map(({ raw }) => raw)
        .filter((raw) => raw !== "=>"),
    ).toEqual(expect.arrayContaining([">"]));
    expect(
      scanned.tokens.filter(
        ({ kind, raw }) => kind === "punctuation" && /^>{2,}/u.test(raw),
      ),
    ).toEqual([]);
  });

  it("normalizes standard tokens while retaining TypeScript kinds", () => {
    const result = scanTypeScript("const answer: number = 0x2a;", { sourceId });
    expect(result.tokens.map((token) => token.kind)).toEqual([
      "keyword",
      "identifier",
      "punctuation",
      "keyword",
      "punctuation",
      "numeric-literal",
      "punctuation",
      "end-of-file",
    ]);
    expect(result.tokens[0]).toMatchObject({
      raw: "const",
      typescriptKindName: "ConstKeyword",
      lexicalMode: "standard",
    });
    expect(result.tokens[5]).toMatchObject({ raw: "0x2a", value: 42 });
  });

  it("preserves byte-exact spelling, offsets, comments, and line breaks", () => {
    const source =
      "#!/usr/bin/env node\r\n// note\nlet café = 'x'; /* tail */\n";
    const result = scanTypeScript(source, { sourceId });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(
      result.tokens[0]?.leadingTrivia.map((trivia) => trivia.kind),
    ).toEqual(["shebang", "whitespace", "line-comment", "whitespace"]);
    expect(result.tokens[0]?.span).toEqual({ start: 29, end: 32 });
    expect(result.tokens.at(-1)?.leadingTrivia.at(-1)).toMatchObject({
      kind: "whitespace",
      raw: "\n",
      hasLineBreak: true,
    });
  });

  it("keeps custom punctuation as lossless scanner components", () => {
    const result = scanTypeScript(
      "value |>> next <- source :: member @ tag #name #{ syntax }",
      {
        sourceId,
      },
    );
    expect(reconstructScannedSource(result.tokens)).toBe(
      "value |>> next <- source :: member @ tag #name #{ syntax }",
    );
    expect(
      result.tokens
        .filter((token) => token.kind === "punctuation")
        .map((token) => token.raw),
    ).toEqual(["|", ">", ">", "<", "-", ":", ":", "@", "#", "{", "}"]);
    expect(result.tokens.some((token) => token.raw === "#name")).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("distinguishes regular expressions from division by lexical goal", () => {
    const source =
      "const pattern = /a[b\\/]c+/giu; const ratio = left / right / 2;";
    const result = scanTypeScript(source, { sourceId });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(
      result.tokens
        .filter((token) => token.kind === "regular-expression-literal")
        .map((token) => token.raw),
    ).toEqual(["/a[b\\/]c+/giu"]);
    expect(
      result.tokens
        .filter((token) => token.raw === "/")
        .map((token) => token.kind),
    ).toEqual(["punctuation", "punctuation"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports malformed lexical input as project diagnostics", () => {
    const result = scanTypeScript("const value = 'unterminated", { sourceId });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "SWR1001",
      stage: "reader",
      severity: "error",
    });
    expect(result.tokens.at(-2)).toMatchObject({
      kind: "string-literal",
      unterminated: true,
    });
  });

  it("attaches final trivia to the EOF token", () => {
    const result = scanTypeScript("x /* final */  ", { sourceId });
    const eof = result.tokens.at(-1);
    expect(eof?.kind).toBe("end-of-file");
    expect(eof?.raw).toBe("");
    expect(eof?.leadingTrivia.map((trivia) => trivia.raw)).toEqual([
      " ",
      "/* final */",
      "  ",
    ]);
    expect(reconstructScannedSource(result.tokens)).toBe("x /* final */  ");
  });

  it("freezes result records and child arrays", () => {
    const result = scanTypeScript("let x = 1", { sourceId });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tokens)).toBe(true);
    expect(Object.isFrozen(result.tokens[0])).toBe(true);
    expect(Object.isFrozen(result.tokens[0]?.leadingTrivia)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
  });

  it("keeps standard and JSX variants explicitly distinct", () => {
    const standard = scanTypeScript("<Widget value='x' />", { sourceId });
    const jsx = scanTypeScript("<Widget value='x' />", {
      sourceId,
      variant: "jsx",
    });
    expect(reconstructScannedSource(standard.tokens)).toBe(
      "<Widget value='x' />",
    );
    expect(reconstructScannedSource(jsx.tokens)).toBe("<Widget value='x' />");
    expect(
      standard.tokens.some((token) => token.kind === "jsx-identifier"),
    ).toBe(false);
    expect(jsx.tokens.some((token) => token.kind === "jsx-identifier")).toBe(
      true,
    );
  });

  it("accepts only the isolated supported TypeScript line", () => {
    expect(() =>
      assertSupportedTypeScriptVersion(`${supportedTypeScriptMajorMinor}.99`),
    ).not.toThrow();
    expect(() => assertSupportedTypeScriptVersion("7.0.0")).toThrow(
      UnsupportedTypeScriptVersionError,
    );
  });

  it("exposes the actual compatible compiler version used for a scan", () => {
    const result = scanTypeScript("x", { sourceId });
    expect(result.typescriptVersion.startsWith("6.0.")).toBe(true);
  });

  it("rescans template heads, middles, and tails losslessly", () => {
    const source = "const value = `before ${first} between ${second} after`;";
    const result = scanTypeScript(source, { sourceId });
    const templates = result.tokens.filter((token) =>
      token.kind.startsWith("template-"),
    );
    expect(templates.map((token) => [token.kind, token.raw])).toEqual([
      ["template-head", "`before ${"],
      ["template-middle", "} between ${"],
      ["template-tail", "} after`"],
    ]);
    expect(templates.map((token) => token.lexicalMode)).toEqual([
      "template-substitution",
      "template",
      "template",
    ]);
    expect(reconstructScannedSource(result.tokens)).toBe(source);
  });

  it("tracks ordinary braces inside template substitutions", () => {
    const source = "`value ${{ nested: { answer: 42 } }.nested.answer} done`";
    const result = scanTypeScript(source, { sourceId });
    expect(
      result.tokens.filter((token) => token.kind === "template-tail"),
    ).toHaveLength(1);
    expect(result.tokens.filter((token) => token.raw === "}")).toHaveLength(2);
    expect(reconstructScannedSource(result.tokens)).toBe(source);
  });

  it("tracks nested templates independently", () => {
    const source = "`outer ${`inner ${value} end`} tail`";
    const result = scanTypeScript(source, { sourceId });
    expect(result.tokens.map((token) => token.kind)).toEqual([
      "template-head",
      "template-head",
      "identifier",
      "template-tail",
      "template-tail",
      "end-of-file",
    ]);
    expect(reconstructScannedSource(result.tokens)).toBe(source);
  });

  it("preserves escaped template content", () => {
    const source = "const text = `line\\\\n\\${literal} ${value}`;";
    const result = scanTypeScript(source, { sourceId });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(
      result.tokens.find((token) => token.kind === "template-head")?.raw,
    ).toContain(String.raw`\${literal}`);
  });

  it("bounds unterminated templates at EOF", () => {
    const noSubstitution = scanTypeScript("`unterminated", { sourceId });
    expect(noSubstitution.tokens[0]).toMatchObject({
      kind: "no-substitution-template",
      unterminated: true,
    });
    expect(noSubstitution.diagnostics.length).toBeGreaterThan(0);

    const substitution = scanTypeScript("`value ${missing", { sourceId });
    expect(substitution.tokens.at(-1)?.kind).toBe("end-of-file");
    expect(reconstructScannedSource(substitution.tokens)).toBe(
      "`value ${missing",
    );
  });

  it("scans JSX tags, attributes, text, and expressions contextually", () => {
    const source = '<Widget data-id="x">hello {user.name}!</Widget>';
    const result = scanTypeScript(source, { sourceId, variant: "jsx" });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(
      result.tokens
        .filter((token) => token.kind === "jsx-identifier")
        .map((token) => token.raw),
    ).toEqual(["Widget", "data-id", "Widget"]);
    expect(
      result.tokens
        .filter((token) => token.kind === "jsx-text")
        .map((token) => token.raw),
    ).toEqual(["hello ", "!"]);
  });

  it("handles fragments, nested tags, and self-closing elements", () => {
    const source = "<>before<span><Icon /></span>after</>";
    const result = scanTypeScript(source, { sourceId, variant: "jsx" });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(
      result.tokens
        .filter((token) => token.kind === "jsx-identifier")
        .map((token) => token.raw),
    ).toEqual(["span", "Icon", "span"]);
    expect(
      result.tokens
        .filter((token) => token.kind === "jsx-text")
        .map((token) => token.raw),
    ).toEqual(["before", "after"]);
  });

  it("returns from nested JSX and templates inside JSX expressions", () => {
    const source = "<View>{ready ? <Icon /> : `value ${count}`}</View>";
    const result = scanTypeScript(source, { sourceId, variant: "jsx" });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(result.tokens.some((token) => token.raw === "Icon")).toBe(true);
    expect(result.tokens.some((token) => token.kind === "template-tail")).toBe(
      true,
    );
    expect(result.tokens.at(-1)?.kind).toBe("end-of-file");
  });

  it("preserves mismatched JSX tags without semantic pairing", () => {
    const source = "<Outer><Inner>text</Wrong></Outer>";
    const result = scanTypeScript(source, { sourceId, variant: "jsx" });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(result.tokens.find((token) => token.raw === "Wrong")).toMatchObject({
      kind: "jsx-identifier",
      lexicalMode: "jsx-tag",
    });
  });

  it("does not reinterpret ordinary TSX comparisons with spaced operands", () => {
    const source = "const less = left < right;";
    const result = scanTypeScript(source, { sourceId, variant: "jsx" });
    expect(reconstructScannedSource(result.tokens)).toBe(source);
    expect(result.tokens.some((token) => token.kind === "jsx-text")).toBe(
      false,
    );
    expect(result.tokens.find((token) => token.raw === "<")?.kind).toBe(
      "punctuation",
    );
  });
});
