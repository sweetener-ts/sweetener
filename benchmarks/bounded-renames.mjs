import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../packages/cli/dist/src/index.js";

/** How many functions each hold two invocations and a `tmp` of their own. */
const FUNCTIONS = 2_000;

/**
 * One file of functions that each declare a `tmp` and invoke a macro whose
 * template declares a `tmp` of its own, twice.
 *
 * A binder in a function binds only in the function, so each class of them
 * is renamed only over the regions it binds in, and every `tmp` printed has
 * to be told which class reaches it and whether it stands where that class
 * binds. Asked of every class of the spelling, each invocation's, that was the
 * square of the invocations: 3,200 functions took 19 s.
 * `expansion/hygienic-renames` declares its binders at the module's top,
 * where a class binds everywhere, and never asks.
 */
export function defineBoundedRenamesBenchmark() {
  const directory = mkdtempSync(join(tmpdir(), "sweet-bounded-renames-"));
  process.on("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(
    join(directory, "macros.sts"),
    `export syntax swap:stmt {
  rule { swap($a:ident, $b:ident); } => { const tmp = $a; $a = $b; $b = tmp; }
}
`,
  );
  const functions = Array.from(
    { length: FUNCTIONS },
    (_, index) =>
      `export function f${String(index)}() { let x = 1, y = 2; const tmp = 0; swap(x, y); swap(y, x); return x + y + tmp; }`,
  );
  writeFileSync(
    join(directory, "main.sts"),
    [`import { swap } from "./macros.sts" for syntax;`, ...functions, ""].join(
      "\n",
    ),
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
    id: "expansion/bounded-renames",
    description: `Rename the binders ${String(FUNCTIONS * 2)} invocations introduce in ${String(FUNCTIONS)} functions apart`,
    run() {
      const provider = createDefaultProjectExpansionProvider();
      const output = provider.expandProject(loadSweetProject(configPath));
      if (output.diagnostics.length > 0)
        throw new Error("Bounded-renames benchmark produced diagnostics");
      const main = output.files.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      );
      if (!main?.generated.text.includes("const tmp_1 = x"))
        throw new Error("Bounded-renames benchmark renamed no binder apart");
      return { invocations: FUNCTIONS * 2 };
    },
  };
}
