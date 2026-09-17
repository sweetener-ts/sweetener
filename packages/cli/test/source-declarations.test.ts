import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Declarations that let ordinary TypeScript import a macro module.
 *
 * `tsc` has no idea what a `.sts` is, so on its own it cannot resolve
 * `import { pair } from "./main.sts"` in a `.ts` or `.tsx` file, and the
 * standard Vite build script — `tsc -b && vite build` — fails the moment any
 * file imports one.
 *
 * With `allowArbitraryExtensions`, TypeScript resolves `./main.sts` through
 * `main.d.sts.ts` beside it. Emitting that is what makes the import work
 * everywhere TypeScript already works, editors included. These check that the
 * declarations are written when the project asks for them, kept in step with
 * the sources, and read by plain `tsc` with real types.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}
`;

function project(main: string, consumer?: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-declarations-"));
  writeFileSync(join(directory, "macros.sts"), macros, "utf8");
  writeFileSync(join(directory, "main.sts"), main, "utf8");
  if (consumer !== undefined)
    writeFileSync(join(directory, "consumer.ts"), consumer, "utf8");
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        allowArbitraryExtensions: true,
        noEmit: true,
      },
      sweet: { macroExtensions: [".sts"], sourceDeclarations: true },
      files: ["macros.sts", "main.sts"],
    }),
    "utf8",
  );
  const result = runConfiguredProjectCommand({
    command: "build",
    configPath: join(directory, "tsconfig.json"),
  });
  return { directory, result };
}

const main = `import { twice } from "./macros.sts" for syntax;

export const pair: readonly number[] = twice(21);
export interface Point { readonly x: number }
`;

describe("source declarations", () => {
  test("writes one beside each macro source", () => {
    const { directory, result } = project(main);
    expect(result.diagnostics.map(({ messageText }) => messageText)).toEqual(
      [],
    );
    const declaration = readFileSync(join(directory, "main.d.sts.ts"), "utf8");
    expect(declaration).toContain(
      "export declare const pair: readonly number[]",
    );
    expect(declaration).toContain("export interface Point");
  });

  test("is not written unless the project asks for it", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-no-declarations-"));
    writeFileSync(join(directory, "macros.sts"), macros, "utf8");
    writeFileSync(join(directory, "main.sts"), main, "utf8");
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022", noEmit: true },
        sweet: { macroExtensions: [".sts"] },
        files: ["macros.sts", "main.sts"],
      }),
      "utf8",
    );
    runConfiguredProjectCommand({
      command: "build",
      configPath: join(directory, "tsconfig.json"),
    });
    expect(() =>
      readFileSync(join(directory, "main.d.sts.ts"), "utf8"),
    ).toThrow();
  });

  /**
   * They cannot wait for the project to check.
   *
   * A `.ts` file importing a `.sts` one does not resolve until the declaration
   * exists, so declarations written only after a clean check would never be
   * written at all: the check cannot pass without what it would refuse to
   * produce, and `sweetener check` would report `Cannot find module
   * "./main.sts"` for a project that is correct.
   */
  test("are written even when the project does not check", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-declarations-first-"));
    writeFileSync(join(directory, "macros.sts"), macros, "utf8");
    writeFileSync(join(directory, "main.sts"), main, "utf8");
    writeFileSync(
      join(directory, "consumer.ts"),
      `import { pair } from "./main.sts";\nexport const wrong: string = pair;\n`,
      "utf8",
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          allowArbitraryExtensions: true,
          noEmit: true,
        },
        sweet: { macroExtensions: [".sts"], sourceDeclarations: true },
        files: ["macros.sts", "main.sts", "consumer.ts"],
      }),
      "utf8",
    );
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: join(directory, "tsconfig.json"),
    });
    // The project has a real error in it, and the declaration is still there.
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(directory, "main.d.sts.ts"), "utf8")).toContain(
      "export declare const pair",
    );
    // And the error is the assignment, not an unresolved module.
    const messages = result.diagnostics.map(({ messageText }) =>
      String(messageText),
    );
    expect(messages.join("\n")).toContain("not assignable");
    expect(messages.join("\n")).not.toContain("Cannot find module");
  });

  /**
   * A declaration outlives its source only until the next run.
   *
   * These stand beside the sources and are what TypeScript resolves a
   * `./main.sts` import through, so one left behind keeps answering for a
   * module that is gone: an import of a deleted file goes on type-checking
   * until the bundler fails on it.
   */
  test("removes one whose source has been deleted", () => {
    const { directory } = project(main);
    const orphan = join(directory, "gone.d.sts.ts");
    writeFileSync(orphan, "export declare const gone: number;\n", "utf8");
    // A declaration whose source is still there is left alone.
    expect(readFileSync(join(directory, "main.d.sts.ts"), "utf8")).toContain(
      "pair",
    );

    runConfiguredProjectCommand({
      command: "build",
      configPath: join(directory, "tsconfig.json"),
    });

    expect(() => readFileSync(orphan, "utf8")).toThrow();
    expect(readFileSync(join(directory, "main.d.sts.ts"), "utf8")).toContain(
      "pair",
    );
  });

  /** The point of the exercise: plain `tsc` reads them, and checks against them. */
  test("lets ordinary TypeScript import the macro module, with real types", () => {
    const { directory } = project(
      main,
      `import { pair } from "./main.sts";\nexport const wrong: string = pair;\n`,
    );
    const configPath = join(directory, "tsconfig.json");
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configPath, ts.sys.readFile).config,
      ts.sys,
      directory,
    );
    const program = ts.createProgram({
      rootNames: [join(directory, "consumer.ts")],
      options: parsed.options,
    });
    const messages = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      );
    // Resolved — no "cannot find module" — and checked, so the bad assignment
    // is the only thing it has to say.
    expect(messages).toEqual([
      "Type 'readonly number[]' is not assignable to type 'string'.",
    ]);
  });
});
