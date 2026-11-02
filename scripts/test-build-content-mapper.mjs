// The content mapper's end-to-end tests have TypeScript 7 start what is built, so
// a test can otherwise pass against code that no longer matches the source.
// `pnpm test` has built by now, and says so; this is for vitest started any other
// way, which refuses to run on a build it could not bring up to date, as
// run-tests.mjs does.

import { spawnSync } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function build() {
  const { status, stdout, stderr, error } = spawnSync(
    "tsc6",
    ["-b", "packages/content-mapper"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        PATH: `${resolve(repositoryRoot, "node_modules", ".bin")}${delimiter}${process.env["PATH"] ?? ""}`,
      },
    },
  );
  if (error !== undefined) throw error;
  if (status !== 0)
    throw new Error(
      `The content mapper did not build, and its end-to-end tests run what is built:\n${stdout}${stderr}`,
    );
}

export default function setup(project) {
  if (process.env["SWEETENER_TESTS_BUILT"] === "1") return;
  build();
  // Vitest watching runs tests again from here, not from the top.
  project.onTestsRerun(build);
}
