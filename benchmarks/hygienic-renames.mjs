import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../packages/cli/dist/src/index.js";

/** How many invocations introduce a binder of the one spelling. */
const BINDERS = 2_000;

/**
 * One file in which every expansion introduces a binder named `v`, beside a
 * `v` of the file's own.
 *
 * Every one of those binders has to be renamed apart from the others and from
 * the file's, so this is the renamer's worst shape: thousands of bindings of
 * one spelling, each resolved against all the others, each needing a name none
 * of the others took. Resolving every reference by testing every binding of
 * its spelling, listing every pair of bindings as a conflict, and searching
 * `v`, `v_1`, `v_2` from the start for every binding each cost the square of
 * the binders: 10,000 took a minute. A file of ordinary size never shows that,
 * because a few binders cost the same either way.
 *
 * Each template declares its `v` in the module's own run, beside the item it
 * exports, where the expander asks whether the `v` the template reads is one
 * of those declarations. Asked of every binder of the spelling the run held,
 * that was the square of the invocations too: 8,000 took 14 s.
 */
export function defineHygienicRenamesBenchmark() {
  const directory = mkdtempSync(join(tmpdir(), "sweet-hygienic-renames-"));
  // The suite runs one process per scenario, so this project would otherwise
  // be left behind once per scenario rather than once per run.
  process.on("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(
    join(directory, "macros.sts"),
    `export syntax defineBound:item {
  rule { defineBound $name:binding; }
  bind $name in following as recursive value;
  => { const v = 1; export const $name = (w: number) => w + v; }
}
`,
  );
  const invocations = Array.from(
    { length: BINDERS },
    (_, index) => `defineBound value${String(index)};`,
  );
  writeFileSync(
    join(directory, "main.sts"),
    [
      `import { defineBound } from "./macros.sts" for syntax;`,
      ...invocations,
      "export const v = 1;",
      "",
    ].join("\n"),
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
    id: "expansion/hygienic-renames",
    description: `Rename ${String(BINDERS)} template-introduced binders of one spelling apart`,
    run() {
      const provider = createDefaultProjectExpansionProvider();
      const output = provider.expandProject(loadSweetProject(configPath));
      if (output.diagnostics.length > 0)
        throw new Error("Hygienic-renames benchmark produced diagnostics");
      const main = output.files.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      );
      if (!main?.generated.text.includes(`v_${String(BINDERS)}`))
        throw new Error("Hygienic-renames benchmark renamed no binder apart");
      return { invocations: BINDERS };
    },
  };
}
