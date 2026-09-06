import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadSweetProject, parseSweetCompilerOptions } from "../src/index.js";

describe("sweet project configuration", () => {
  test("preserves missing and malformed config-file diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-config-"));
    const missing = loadSweetProject(join(directory, "missing.json"));
    expect(missing.typescript.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 5083 })]),
    );

    const malformedPath = join(directory, "malformed.json");
    writeFileSync(malformedPath, '{ "compilerOptions": ');
    const malformed = loadSweetProject(malformedPath);
    expect(malformed.typescript.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 1109, file: expect.anything() }),
      ]),
    );
  });

  test("parses every expansion-affecting option deterministically", () => {
    const result = parseSweetCompilerOptions({
      languageVersion: "1",
      typescriptVersionPolicy: "compatible-minor",
      macroExtensions: [".stsx", ".sts", ".sts"],
      allowCoreShadowing: true,
      sourceDeclarations: true,
      trace: "full",
      limits: { maxOutputTokens: 1000, maxMatcherSteps: 500 },
    });
    expect(result.problems).toEqual([]);
    expect(result.options).toEqual({
      languageVersion: "1",
      typescriptVersionPolicy: "compatible-minor",
      macroExtensions: [".sts", ".stsx"],
      allowCoreShadowing: true,
      sourceDeclarations: true,
      trace: "full",
      limits: { maxMatcherSteps: 500, maxOutputTokens: 1000 },
    });
  });

  test("reports unknown and malformed options with stable paths", () => {
    const result = parseSweetCompilerOptions({
      unknown: true,
      macroExtensions: ["sts"],
      trace: "everything",
      limits: { maxOutputTokens: -1 },
    });
    expect(result.problems).toMatchObject([
      { code: "SWR6001", path: "sweet.unknown" },
      { code: "SWR6001", path: "sweet.macroExtensions" },
      { code: "SWR6001", path: "sweet.trace" },
      { code: "SWR6001", path: "sweet.limits.maxOutputTokens" },
    ]);
  });
});

describe("macro sources under wildcard globs", () => {
  function project(config: Record<string, unknown>): string {
    const directory = mkdtempSync(join(tmpdir(), "sweet-glob-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(
      join(directory, "src", "macros.sts"),
      `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value] }\n}\n`,
      "utf8",
    );
    writeFileSync(
      join(directory, "src", "main.sts"),
      `import { twice } from "./macros.sts" for syntax;\nexport const doubled = twice(21);\n`,
      "utf8",
    );
    writeFileSync(
      join(directory, "src", "plain.ts"),
      "export const plain = 1;\n",
      "utf8",
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify(config),
      "utf8",
    );
    return directory;
  }

  const base = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
    },
    sweet: { macroExtensions: [".sts"] },
  };

  test("an include glob resolves them, as it does ordinary TypeScript", () => {
    // They used to be left out of the program entirely while the build still
    // reported success, so a project laid out the ordinary way compiled none
    // of its macros and was told nothing.
    const directory = project({ ...base, include: ["src"] });
    const loaded = loadSweetProject(join(directory, "tsconfig.json"));
    const names = loaded.typescript.fileNames.map((name) =>
      name.split("/").at(-1),
    );
    expect(names).toContain("macros.sts");
    expect(names).toContain("main.sts");
    expect(names).toContain("plain.ts");
  });

  test("a files list still resolves them", () => {
    const directory = project({
      ...base,
      files: ["src/macros.sts", "src/main.sts", "src/plain.ts"],
    });
    const loaded = loadSweetProject(join(directory, "tsconfig.json"));
    expect(loaded.typescript.fileNames).toHaveLength(3);
  });

  test("a glob that names the extension resolves them", () => {
    const directory = project({ ...base, include: ["src/**/*.sts"] });
    const loaded = loadSweetProject(join(directory, "tsconfig.json"));
    const names = loaded.typescript.fileNames.map((name) =>
      name.split("/").at(-1),
    );
    expect(names).toContain("macros.sts");
    expect(names).not.toContain("plain.ts");
  });
});
