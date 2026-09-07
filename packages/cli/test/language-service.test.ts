import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import {
  MappedLanguageService,
  VirtualLanguageServiceProject,
} from "@sweetener/typescript-host";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * An editor asks about the file the author wrote, while TypeScript only ever
 * sees the expansion. These drive the mapping over a real expansion rather than
 * a hand-built one, so what the compiler actually produces is what is mapped.
 */
function editor(macros: string, main: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-editor-"));
  const sourceFileName = join(directory, "main.sts");
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(sourceFileName, main);
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );

  const provider = createDefaultProjectExpansionProvider();
  const project = loadSweetProject(configPath);
  const expansion = provider.expandProject(project);
  const inspected = provider.inspectSource(sourceFileName);
  if (inspected === undefined) throw new Error("main.sts was not inspected");
  const virtualFileName = expansion.files.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.fileName;
  if (virtualFileName === undefined) throw new Error("no virtual main.ts");

  const virtualProject = new VirtualLanguageServiceProject({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
    currentDirectory: directory,
    files: expansion.files.map(({ fileName, generated }) => ({
      fileName,
      generated,
    })),
  });
  const service = new MappedLanguageService(virtualProject, [
    {
      sourceFileName,
      sourceId: inspected.sourceId,
      virtualFileName,
      printed: inspected.generated,
      index: inspected.index,
      origins: inspected.origins,
    },
  ]);
  return { service, sourceFileName, source: main };
}

const macros = `export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}`;

describe("language service over a real expansion", () => {
  test("answers hover at a position in the written source", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
export const doubled = twice(41);
`;
    const { service, sourceFileName } = editor(macros, source);
    const info = service.quickInfo(
      sourceFileName,
      source.indexOf("doubled") + 1,
    );
    expect(info).toBeDefined();
    // The type comes from the expansion; the position is the author's.
    expect(ts.displayPartsToString([...(info?.displayParts ?? [])])).toContain(
      "doubled",
    );
  });

  test("reports a type error at the position the author wrote", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
export const wrong: string = twice(41);
`;
    const { service, sourceFileName } = editor(macros, source);
    const reported = service.diagnostics(sourceFileName);
    expect(reported.length).toBeGreaterThan(0);
    const primary = reported[0]?.primaryOrigin;
    // The span covers the author's own `wrong`, not a position in the expansion.
    expect(source.slice(primary?.start ?? 0, primary?.end ?? 0)).toBe("wrong");
    expect(reported[0]?.messageText).toContain(
      "Type 'number[]' is not assignable to type 'string'",
    );
  });

  test("finds a definition back in the written source", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
const seed = 41;
export const doubled = twice(seed);
`;
    const { service, sourceFileName } = editor(macros, source);
    // The use is inside the macro call; the definition is the author's `const`.
    const [definition] = service.definitions(
      sourceFileName,
      source.lastIndexOf("seed") + 1,
    );
    expect(definition?.sourceFileName).toBe(sourceFileName);
    expect(
      source.slice(
        definition?.source?.start ?? 0,
        definition?.source?.end ?? 0,
      ),
    ).toBe("seed");
  });

  test("reports every reference to a name the macro duplicated", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
const seed = 41;
export const doubled = twice(seed);
`;
    const { service, sourceFileName } = editor(macros, source);
    const references = service.references(
      sourceFileName,
      source.indexOf("const seed") + "const ".length,
    );
    // `twice` writes `seed` twice, but both come from one written occurrence,
    // so the editor must not be shown the same span more than once.
    const spans = references.flatMap(({ source: span }) =>
      span === undefined ? [] : [`${String(span.start)}:${String(span.end)}`],
    );
    expect(new Set(spans).size).toBe(spans.length);
    expect(spans.length).toBe(2);
  });

  test("refuses to rename through a macro without binding proof", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
const seed = 41;
export const doubled = twice(seed);
`;
    const { service, sourceFileName } = editor(macros, source);
    const result = service.rename(
      sourceFileName,
      source.lastIndexOf("seed") + 1,
    );
    // Renaming both copies together would be correct here, but the service
    // will not edit text a macro copied without proof of which binding each
    // copy denotes, and nothing computes that proof yet. The refusal is
    // deliberate: it says so rather than editing on an assumption.
    expect(result.canRename).toBe(false);
    if (result.canRename) throw new Error("unreachable");
    expect(result.reason).toContain("binding identity proof");
  });

  test("does not read a macro's own spacing as another occurrence", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
const seed = 41;
export const doubled = twice(seed + 1);
`;
    const { service, sourceFileName } = editor(macros, source);
    // `twice` writes `[$value, $value]`, so the expansion holds a space before
    // the second copy and a grouping parenthesis around each -- text the
    // printer gives the copy's own origin. Counted as places the written
    // `seed` landed, they made the service ask TypeScript which binding lived
    // at a space, and read the silence as a second, distinct one. The refusal
    // that stands is the one this input earns: nothing yet proves which
    // binding each copy denotes.
    const result = service.rename(
      sourceFileName,
      source.lastIndexOf("seed") + 1,
    );
    expect(result.canRename).toBe(false);
    if (result.canRename) throw new Error("unreachable");
    expect(result.reason).toContain("binding identity proof");
  });

  test("refuses to rename a name that the expansion erases", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
export const doubled = twice(41);
`;
    const { service, sourceFileName } = editor(macros, source);
    // A `for syntax` import is compile-time only; nothing in the output to edit.
    const result = service.rename(sourceFileName, source.indexOf("twice") + 1);
    expect(result.canRename).toBe(false);
    if (result.canRename) throw new Error("unreachable");
    expect(result.reason).toContain("no generated TypeScript location");
  });

  test("offers completions at a position in the written source", () => {
    const source = `import { twice } from "./macros.sts" for syntax;
const seed = 41;
export const doubled = twice(seed);
`;
    const { service, sourceFileName } = editor(macros, source);
    const completions = service.completions(
      sourceFileName,
      source.lastIndexOf("seed") + 1,
    );
    expect(completions?.entries.some(({ name }) => name === "seed")).toBe(true);
  });
});
