// The content mapper's end-to-end tests have TypeScript 7 start what is built, so
// a test can otherwise pass against code that no longer matches the source. A
// type error is the typecheck's to report, so it stops nothing here: the tests
// run against the last build, and say nothing of it being behind.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default function setup() {
  const { status, stdout } = spawnSync(
    "tsc6",
    ["-b", "packages/content-mapper"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        PATH: `${resolve(repositoryRoot, "node_modules", ".bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`,
      },
    },
  );
  if (status !== 0)
    process.stderr.write(
      `The content mapper did not build, so its end-to-end tests run the last build:\n${stdout}\n`,
    );
}
