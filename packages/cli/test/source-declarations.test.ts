import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Declarations that let ordinary TypeScript import a macro module.
 *
 * `import { pair } from "./main.sts"` in a `.ts` or `.tsx` file was
 * unresolvable: `tsc` has no idea what a `.sts` is, so the standard Vite build
 * script — `tsc -b && vite build` — failed the moment any file imported one.
 * The workaround in the checked-in examples is a hand-written
 * `declare module "*.sts"` restating every export, which goes stale silently.
 *
 * With `allowArbitraryExtensions`, TypeScript resolves `./main.sts` through
 * `main.d.sts.ts` beside it. Emitting that is what makes the import work
 * everywhere TypeScript already works, editors included.
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
