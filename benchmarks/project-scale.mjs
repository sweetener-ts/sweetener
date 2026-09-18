import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../packages/cli/dist/src/index.js";

const FILE_COUNT = 300;

const body = (index) => `
export interface Row${index} { id: number; label: string; active: boolean; }
const rows${index}: Row${index}[] = [];
export function total${index}(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) { sum = sum + value; }
  return sum;
}
export function describe${index}(row: Row${index}): string {
  return row.active ? \`\${row.label}:\${String(row.id)}\` : "inactive";
}
export const first${index} = twice(${index});
export const second${index} = twice(total${index}([1, 2, 3]));
export const rest${index} = rows${index}.map((row) => describe${index}(row));
`;

/**
 * A whole project, not a single expansion.
 *
 * Per-file costs that are really per-project — indexing a project's macro
 * modules, or searching its invocation traces — are invisible in a scenario
 * that expands one file, and grow with the square of the project in one that
 * does not. Only a scenario with many files in one project shows them.
 */
export async function defineProjectScaleBenchmark() {
  const directory = mkdtempSync(join(tmpdir(), "sweet-project-scale-"));
  // The suite runs one process per scenario, so this 301-file project would
  // otherwise be left behind once per scenario rather than once per run.
  process.on("exit", () => {
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(
    join(directory, "macros.sts"),
    `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value] }\n}`,
  );
  const files = ["macros.sts"];
  let bytes = 0;
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const text = `import { twice } from "./macros.sts" for syntax;\n${body(index)}`;
    writeFileSync(join(directory, `module${index}.sts`), text);
    files.push(`module${index}.sts`);
    bytes += Buffer.byteLength(text);
  }
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
      files,
    }),
  );

  return {
    id: "expansion/project-scale",
    description: `Expand a ${String(FILE_COUNT)}-file project sharing one macro module`,
    run() {
      const provider = createDefaultProjectExpansionProvider();
      const output = provider.expandProject(loadSweetProject(configPath));
      if (output.files.length !== files.length)
        throw new Error("Project-scale expansion lost a file");
      return { files: output.files.length, bytes };
    },
  };
}
