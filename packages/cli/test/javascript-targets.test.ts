import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  emitStandalone,
  loadSweetProject,
  parseSweetCompilerOptions,
  runConfiguredProjectCommand,
} from "../src/index.js";

const macroBody = `
export syntax duplicate:expr {
  rule { duplicate($value:tt) } => { [$value, $value] }
}
`;

interface Project {
  readonly directory: string;
  readonly config: string;
}

function project(options: {
  readonly files: Readonly<Record<string, string>>;
  readonly compilerOptions?: Readonly<Record<string, unknown>>;
  readonly sweet?: Readonly<Record<string, unknown>>;
}): Project {
  const directory = mkdtempSync(join(tmpdir(), "sweet-js-"));
  mkdirSync(join(directory, "src"), { recursive: true });
  for (const [name, content] of Object.entries(options.files))
    writeFileSync(join(directory, name), content);
  const config = join(directory, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        outDir: "dist",
        rootDir: "src",
        target: "ES2022",
        module: "ESNext",
        strict: false,
        ...options.compilerOptions,
      },
      ...(options.sweet === undefined ? {} : { sweet: options.sweet }),
      files: Object.keys(options.files).filter(
        (name) => name !== "package.json",
      ),
    }),
  );
  return { directory, config };
}

describe("JavaScript macro extensions", () => {
  test("expands and emits a .sjs project as JavaScript", () => {
    const { directory, config } = project({
      files: {
        "src/macros.sjs": macroBody,
        "src/main.sjs": `import { duplicate } from "./macros.sjs" for syntax;\nexport const answer = duplicate(21);\n`,
      },
      sweet: { macroExtensions: [".sjs"] },
    });
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: config,
      writeThrough: true,
    });
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.messageText),
    ).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(directory, "dist/main.js"), "utf8")).toContain(
      "[21, 21]",
    );
  });

  /**
   * TypeScript does not check a `.js` file unless it is asked to, so nothing
   * on that side ever answers for a name expansion left standing. Held against
   * an answer that never comes, the sentence vanished: the project reported
   * success and wrote `export const held = duplicate;`, a name the emitted
   * code does not define, because the compile-time import is erased.
   *
   * It is said instead, as a warning -- the one claim it cannot make without a
   * checker is that nothing else defines the name.
   */
  test("says what it knows about a name in a file TypeScript did not check", () => {
    const { config } = project({
      files: {
        "src/macros.sjs": macroBody,
        "src/main.sjs": `import { duplicate } from "./macros.sjs" for syntax;\nexport const held = duplicate;\n`,
      },
      compilerOptions: { checkJs: false, noEmit: true },
      sweet: { macroExtensions: [".sjs"] },
    });
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(
      result.diagnostics.map(({ code, category }) => [code, category]),
    ).toEqual([[4024, ts.DiagnosticCategory.Warning]]);
    expect(result.exitCode).toBe(0);
  });

  /**
   * The same project with the checker turned on, which is what isolates the
   * cause: TypeScript answers, and the sentence is written in place of its
   * `Cannot find name` as an error.
   */
  test("lets TypeScript answer for the same name when it checks the file", () => {
    const { config } = project({
      files: {
        "src/macros.sjs": macroBody,
        "src/main.sjs": `import { duplicate } from "./macros.sjs" for syntax;\nexport const held = duplicate;\n`,
      },
      compilerOptions: { checkJs: true, noEmit: true },
      sweet: { macroExtensions: [".sjs"] },
    });
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(
      result.diagnostics.map(({ code, category }) => [code, category]),
    ).toEqual([[4024, ts.DiagnosticCategory.Error]]);
    expect(result.exitCode).toBe(1);
  });

  /**
   * The cost of saying it, and the reason it is a warning.
   *
   * `JSON` is a global, so the emitted `export const held = JSON;` is correct
   * and nothing is wrong here. With no checker in this file expansion cannot
   * know that, so it says what it knows and says it as a warning: the build
   * still produces the file, and the sentence is a question rather than a
   * verdict. Turn `checkJs` on and it disappears, because then TypeScript
   * answers.
   */
  test("says it even about a name a global defines, where nothing can answer", () => {
    const { config } = project({
      files: {
        "src/macros.sjs": `export syntax JSON:expr {\n  rule { JSON($value:tt) } => { [$value] }\n}\n`,
        "src/main.sjs": `import { JSON } from "./macros.sjs" for syntax;\nexport const held = JSON;\nexport const made = JSON(1);\n`,
      },
      compilerOptions: { checkJs: false, noEmit: true },
      sweet: { macroExtensions: [".sjs"] },
    });
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(
      result.diagnostics.map(({ code, category }) => [code, category]),
    ).toEqual([[4024, ts.DiagnosticCategory.Warning]]);
    // And it says only what it knows. "Nothing defines JSON in the emitted
    // code" is a claim about the whole program, which is exactly what this
    // path has nobody to ask -- `lib.d.ts`, an ambient declaration and a
    // `declare global` all declare names expansion cannot see. On the checked
    // path the same sentence is earned, because TypeScript has already
    // reported it cannot find the name.
    const said = ts.flattenDiagnosticMessageText(
      result.diagnostics[0]?.messageText,
      " ",
    );
    expect(said).toContain(
      "JSON is written into the emitted code as it stands",
    );
    expect(said).not.toContain("nothing defines JSON");
    const checked = project({
      files: {
        "src/macros.sjs": `export syntax JSON:expr {\n  rule { JSON($value:tt) } => { [$value] }\n}\n`,
        "src/main.sjs": `import { JSON } from "./macros.sjs" for syntax;\nexport const held = JSON;\nexport const made = JSON(1);\n`,
      },
      compilerOptions: { checkJs: true, noEmit: true },
      sweet: { macroExtensions: [".sjs"] },
    });
    const answered = runConfiguredProjectCommand({
      command: "check",
      configPath: checked.config,
      writeThrough: false,
    });
    expect(answered.diagnostics.map(({ code }) => code)).toEqual([]);
    expect(answered.exitCode).toBe(0);
  });

  /**
   * `// @ts-check` and `// @ts-nocheck` decide whether TypeScript checks a
   * file, so they decide whether a held sentence will ever be answered.
   *
   * Read from the extension and `checkJs` alone, both directions were wrong.
   * A `@ts-check`ed JavaScript file was warned about names TypeScript had
   * already resolved -- the noise this design exists to avoid -- and a
   * `@ts-nocheck`ed TypeScript file was assumed to answer, so its sentence
   * was dropped and `export const held = duplicate;` shipped with `check`
   * reporting success and saying nothing at all.
   */
  const heldName = {
    macros: `export syntax duplicate:expr {\n  rule { duplicate($value:tt) } => { [$value, $value] }\n}\n`,
    globalMacros: `export syntax JSON:expr {\n  rule { JSON($value:tt) } => { [$value] }\n}\n`,
  };

  test.each([
    {
      what: "a checked JavaScript file says nothing about a name a global defines",
      extension: "sjs",
      macros: heldName.globalMacros,
      main: `// @ts-check\nimport { JSON } from "./macros.sjs" for syntax;\nexport const held = JSON;\nexport const made = JSON(1);\n`,
      expected: [],
      exitCode: 0,
    },
    {
      what: "a checked JavaScript file reports a name nothing defines",
      extension: "sjs",
      macros: heldName.macros,
      main: `// @ts-check\nimport { duplicate } from "./macros.sjs" for syntax;\nexport const held = duplicate;\n`,
      expected: [[4024, ts.DiagnosticCategory.Error]],
      exitCode: 1,
    },
    {
      what: "an unchecked TypeScript file warns rather than falling silent",
      extension: "sts",
      macros: heldName.macros,
      main: `// @ts-nocheck\nimport { duplicate } from "./macros.sts" for syntax;\nexport const held = duplicate;\n`,
      expected: [[4024, ts.DiagnosticCategory.Warning]],
      exitCode: 0,
    },
  ])("$what", ({ extension, macros, main, expected, exitCode }) => {
    const { config } = project({
      files: {
        [`src/macros.${extension}`]: macros,
        [`src/main.${extension}`]: main,
      },
      compilerOptions: { checkJs: false, noEmit: true },
      sweet: { macroExtensions: [`.${extension}`] },
    });
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(
      result.diagnostics.map(({ code, category }) => [code, category]),
    ).toEqual(expected);
    expect(result.exitCode).toBe(exitCode);
  });

  test("rejects a macro extension with no virtual-file target", () => {
    const parsed = parseSweetCompilerOptions({ macroExtensions: [".sxs"] });
    expect(parsed.problems.map(({ path }) => path)).toContain(
      "sweet.macroExtensions",
    );
  });
});

describe('"use sweetener" opt-in', () => {
  test("expands a .js file that opens with the directive", () => {
    const { directory, config } = project({
      files: {
        "src/macros.js": `"use sweetener";\n${macroBody}`,
        "src/main.js": `"use sweetener";\nimport { duplicate } from "./macros.js" for syntax;\nexport const answer = duplicate(21);\n`,
      },
    });
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: config,
      writeThrough: true,
    });
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.messageText),
    ).toEqual([]);
    const generated = readFileSync(join(directory, "dist/main.js"), "utf8");
    expect(generated).toContain("[21, 21]");
    // The directive is a compile-time marker and must not survive expansion.
    expect(generated).not.toContain("use sweetener");
  });

  test("leaves a .js file without the directive untouched", () => {
    const { config } = project({
      files: {
        "src/plain.js": `export const answer = 1;\n`,
      },
    });
    const provider = createDefaultProjectExpansionProvider();
    expect(provider.expandProject(loadSweetProject(config)).files).toHaveLength(
      0,
    );
  });

  test("parses the generated file as JavaScript, not TypeScript", () => {
    // `f(a) < b > (c)` is a pair of comparisons in JavaScript and a call with
    // a type argument in TypeScript, which erases to `f(a)(c)`. Presenting the
    // expansion under a `.ts` name makes TypeScript take the second reading and
    // silently emit different code for legal JavaScript.
    const { directory, config } = project({
      files: {
        "src/main.js": `"use sweetener";\nconst f = (x) => x, a = 1, b = 2, c = 3;\nexport const compared = f(a) < b > (c);\n`,
      },
      compilerOptions: { checkJs: false },
    });
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: config,
      writeThrough: true,
    });
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.messageText),
    ).toEqual([]);
    const generated = readFileSync(join(directory, "dist/main.js"), "utf8");
    expect(generated).toContain("<");
    expect(generated).not.toContain("f(a)(c)");
  });

  test("honours checkJs against JSDoc types", () => {
    const { config } = project({
      files: {
        "src/main.js": `"use sweetener";\n/** @param {number} value */\nexport function scaled(value) { return value * 2; }\nexport const bad = scaled("nope");\n`,
      },
      compilerOptions: { checkJs: true },
    });
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
    });
    expect(result.exitCode).toBe(1);
    expect(
      result.diagnostics.some(({ code }) => code === 2345),
      "expected an argument-type error from checkJs",
    ).toBe(true);
  });

  test("expands a .ts file that opens with the directive", () => {
    const { directory, config } = project({
      files: {
        "src/macros.ts": `"use sweetener";\n${macroBody}`,
        "src/main.ts": `"use sweetener";\nimport { duplicate } from "./macros.ts" for syntax;\nexport const answer: number[] = duplicate(21);\n`,
      },
    });
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: config,
      writeThrough: true,
    });
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.messageText),
    ).toEqual([]);
    expect(readFileSync(join(directory, "dist/main.js"), "utf8")).toContain(
      "[21, 21]",
    );
  });
});

describe("config-free emit", () => {
  test("expands JavaScript with no tsconfig.json", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-standalone-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(
      join(directory, "src/macros.js"),
      `"use sweetener";\n${macroBody}`,
    );
    writeFileSync(
      join(directory, "src/main.js"),
      `"use sweetener";\nimport { duplicate } from "./macros.js" for syntax;\nexport const answer = duplicate(21);\n`,
    );
    const result = emitStandalone({
      fileNames: [join(directory, "src/main.js")],
      outDir: join(directory, "out"),
    });
    expect(result.diagnostics).toEqual([]);
    const emitted = readFileSync(join(directory, "out/main.js"), "utf8");
    expect(emitted).toContain("[21, 21]");
    expect(emitted).not.toContain("use sweetener");
  });

  /**
   * There is no checker on this path, so nothing else will ever speak about a
   * macro name left standing: the name is written out and the silence is
   * total. It is said here, and said as a warning, because the one claim
   * expansion cannot make -- that nothing else defines the name -- is exactly
   * the claim there is no one here to answer. The output is written either
   * way, since it is the same text either way.
   */
  test("warns about a macro name left standing, and still writes the output", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-standalone-held-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(
      join(directory, "src/macros.js"),
      `"use sweetener";\n${macroBody}`,
    );
    writeFileSync(
      join(directory, "src/main.js"),
      `"use sweetener";\nimport { duplicate } from "./macros.js" for syntax;\nexport const held = duplicate;\n`,
    );
    const result = emitStandalone({
      fileNames: [join(directory, "src/main.js")],
      outDir: join(directory, "out"),
    });
    expect(
      result.diagnostics.map(({ code, category }) => [code, category]),
    ).toEqual([[4024, ts.DiagnosticCategory.Warning]]);
    expect(
      ts.flattenDiagnosticMessageText(result.diagnostics[0]?.messageText, "\n"),
    ).toContain("Macro duplicate is written here as a name on its own");
    expect(readFileSync(join(directory, "out/main.js"), "utf8")).toContain(
      "held = duplicate",
    );
  });

  /** An expansion error of its own is still an error, and still refuses. */
  test("refuses to write output an expansion error stands in", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-standalone-error-"));
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(
      join(directory, "src/macros.js"),
      `"use sweetener";\nexport syntax only:expr {\n  rule { only(1) } => { 1 }\n}\n`,
    );
    writeFileSync(
      join(directory, "src/main.js"),
      `"use sweetener";\nimport { only } from "./macros.js" for syntax;\nexport const bad = only(2);\n`,
    );
    const result = emitStandalone({
      fileNames: [join(directory, "src/main.js")],
      outDir: join(directory, "out"),
    });
    expect(
      result.diagnostics.map(({ code, category }) => [code, category]),
    ).toEqual([[4001, ts.DiagnosticCategory.Error]]);
    expect(result.outputs.size).toBe(0);
  });
});
