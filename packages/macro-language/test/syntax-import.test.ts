import { readSyntax } from "@sweetener/reader";
import type { ScopeSetId, SourceId } from "@sweetener/shared";
import { describe, expect, test } from "vitest";
import { parseCompileTimeSyntaxImports } from "../src/index.js";

const sourceId = 204 as SourceId;
const scopes = 0 as ScopeSetId;

function parse(source: string) {
  const read = readSyntax(source, { sourceId, scopes });
  expect(read.diagnostics).toEqual([]);
  return parseCompileTimeSyntaxImports(read.root, { sourceId });
}

describe("compile-time syntax imports", () => {
  test("parses named and aliased macro bindings without claiming runtime imports", () => {
    const result = parse(`
      import { doForm, optional as maybe, (|>) } from "./language.sts" for syntax;
      import { runtime } from "./runtime.js";
      const answer = doForm(42);
    `);

    expect(result.diagnostics).toEqual([]);
    expect(result.imports).toMatchObject([
      {
        specifier: "./language.sts",
        bindings: [
          { imported: "doForm", local: "doForm" },
          { imported: "optional", local: "maybe" },
          { imported: "|>", local: "|>" },
        ],
      },
    ]);
  });

  test("reports malformed phase-qualified imports structurally", () => {
    const result = parse(`import forms from "./language.sts" for syntax;`);

    expect(result.imports).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      { code: "SWR2019", severity: "error" },
    ]);
  });

  test("records explicit core-form interception opt-in", () => {
    const result = parse(
      `import { if, function } from "./core.sts" for syntax shadows core;`,
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.imports).toMatchObject([
      {
        specifier: "./core.sts",
        shadowsCore: true,
        bindings: [
          { imported: "if", local: "if" },
          { imported: "function", local: "function" },
        ],
      },
    ]);
  });
});

/**
 * A compile-time import ends where any other statement ends.
 *
 * Requiring the semicolon meant a project that does without them could not
 * write one at all — and the default Vite template is such a project, so the
 * very first import anyone added to one was rejected, with a message that
 * listed what was expected and no line to look at.
 */
describe("a syntax import without a semicolon", () => {
  test("ends at a line break", () => {
    const result = parse(
      `import { doForm } from "./language.sts" for syntax\n\nconst answer = doForm(42)\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.imports).toMatchObject([{ specifier: "./language.sts" }]);
  });

  test("ends at a line break before another import", () => {
    const result = parse(
      `import { doForm } from "./language.sts" for syntax\nimport "./side.css"\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.imports).toMatchObject([{ specifier: "./language.sts" }]);
  });

  test("ends at the end of the file", () => {
    const result = parse(`import { doForm } from "./language.sts" for syntax`);
    expect(result.diagnostics).toEqual([]);
    expect(result.imports).toMatchObject([{ specifier: "./language.sts" }]);
  });

  test("ends at a line break after shadows core", () => {
    const result = parse(
      `import { typeof } from "./forms.sts" for syntax shadows core\n\nconst kind = typeof 1\n`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.imports).toMatchObject([
      { specifier: "./forms.sts", shadowsCore: true },
    ]);
  });

  test("covers only itself, so what follows still expands", () => {
    const result = parse(
      `import { doForm } from "./language.sts" for syntax\nconst answer = doForm(42)\n`,
    );
    expect(result.diagnostics).toEqual([]);
    const [only] = result.imports;
    expect(
      `import { doForm } from "./language.sts" for syntax\nconst answer = doForm(42)\n`.slice(
        only!.span.start,
        only!.span.end,
      ),
    ).toBe(`import { doForm } from "./language.sts" for syntax`);
  });

  test("still refuses one that runs into the next statement", () => {
    const result = parse(
      `import { doForm } from "./language.sts" for syntax const answer = 1;`,
    );
    expect(result.imports).toEqual([]);
    expect(result.diagnostics).toMatchObject([{ code: "SWR2019" }]);
  });
});
