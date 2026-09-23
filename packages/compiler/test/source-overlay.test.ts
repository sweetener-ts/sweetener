import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

describe("in-memory source overlay", () => {
  test("expands buffer text and leaves the file on disk alone", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-overlay-"));
    const macros = join(directory, "macros.sts");
    const main = join(directory, "main.sts");
    writeFileSync(
      macros,
      `export syntax clamp:expr {
  rule { clamp($value:expr, $minimum:expr, $maximum:expr) } => {
    globalThis.Math.min($maximum, globalThis.Math.max($minimum, $value))
  }
}
`,
    );
    const onDisk = `import { clamp } from "./macros.sts" for syntax;
export const low = clamp(-4, 0, 10);
`;
    writeFileSync(main, onDisk);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: ["macros.sts", "main.sts"],
      }),
    );
    const overlaid = onDisk.replace("-4", "-9");
    const provider = createDefaultProjectExpansionProvider({
      readSource: (fileName) =>
        resolve(fileName) === resolve(main) ? overlaid : undefined,
    });
    provider.expandProject(loadSweetProject(join(directory, "tsconfig.json")));
    const inspected = provider.inspectSource(main);
    expect(inspected?.generated.text).toContain("-9");
    expect(inspected?.generated.text).toContain("globalThis.Math.min");
    expect(inspected?.generated.text).not.toContain("-4");
    expect(readFileSync(main, "utf8")).toBe(onDisk);
  });
});
