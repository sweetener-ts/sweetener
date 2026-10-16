import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../packages/cli/dist/src/index.js";

/** How many definitions the one macro module holds. */
const DEFINITIONS = 5_000;

/**
 * One macro module of thousands of definitions, each with a comment above it,
 * compiled and stripped to its runtime code through the project provider.
 *
 * Finding where each definition begins searched the module's nodes for it,
 * deciding whether each node is compile-time syntax asked every definition's
 * range of it, the comments of removed definitions were copied onto one
 * another, and each definition was checked for a duplicate against every one
 * kept before it. Each cost the square of the module: 10,000 definitions took
 * 16 s. A module of a few dozen never shows that.
 */
export function defineMacroModuleBenchmark() {
  const directory = mkdtempSync(join(tmpdir(), "sweet-macro-module-"));
  // The suite runs one process per scenario, so this project would otherwise
  // be left behind once per scenario rather than once per run.
  process.on("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  const definitions = Array.from(
    { length: DEFINITIONS },
    (_, index) =>
      `/** The number ${String(index)}. */\nexport syntax m${String(index)}:expr {\n  rule { m${String(index)} } => { ${String(index)} }\n}`,
  );
  writeFileSync(
    join(directory, "macros.sts"),
    [...definitions, "export const kept = 1;", ""].join("\n"),
  );
  writeFileSync(
    join(directory, "main.sts"),
    `import { m${String(DEFINITIONS - 1)} } from "./macros.sts" for syntax;\nexport const last = m${String(DEFINITIONS - 1)};\n`,
  );
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

  return {
    id: "expansion/macro-module",
    description: `Compile and strip one macro module of ${String(DEFINITIONS)} definitions`,
    run() {
      const provider = createDefaultProjectExpansionProvider();
      const output = provider.expandProject(loadSweetProject(configPath));
      if (output.diagnostics.length > 0)
        throw new Error("Macro-module benchmark produced diagnostics");
      const macros = output.files.find(({ fileName }) =>
        fileName.endsWith("macros.ts"),
      );
      const main = output.files.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      );
      if (
        !main?.generated.text.includes(`last = ${String(DEFINITIONS - 1)}`) ||
        !macros?.generated.text.includes(
          `The number ${String(DEFINITIONS - 1)}.`,
        )
      )
        throw new Error("Macro-module benchmark expanded the wrong thing");
      return { definitions: DEFINITIONS };
    },
  };
}
