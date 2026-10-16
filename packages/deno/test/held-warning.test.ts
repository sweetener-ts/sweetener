import { mkdtempSync, writeFileSync, writeSync } from "node:fs";
import type * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, vi } from "vitest";
import { createSweetenerHooks } from "../src/index.js";

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
  writeSync: vi.fn(),
}));

/**
 * What expansion holds about a name it left standing is said before the hook
 * returns, so it is there beside the error the name throws when the module
 * runs. A warning emitted for a later tick was never printed when the module
 * threw at its top level, which is the usual way such a name fails.
 */
test("says what it holds about a name before the module is handed back", () => {
  const directory = mkdtempSync(join(tmpdir(), "sweet-deno-held-"));
  writeFileSync(
    join(directory, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(directory, "mod.sts"),
    `import { twice } from "./macros.sts" for syntax;\nconsole.log(twice);\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["macros.sts", "mod.sts"],
    }),
  );
  createSweetenerHooks().load(
    pathToFileURL(join(directory, "mod.sts")).href,
    undefined,
    () => {
      throw new Error("the hook should not have delegated");
    },
  );
  expect(vi.mocked(writeSync)).toHaveBeenCalledWith(
    2,
    expect.stringContaining("warning TS4024"),
  );
});
