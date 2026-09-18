#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const artifactDirectory = join(repositoryRoot, "artifacts", "test-results");
const rawPath = join(artifactDirectory, "vitest.raw");
const reportPath = join(artifactDirectory, "unit.json");
const vitestPath = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const startedAt = new Date();
const start = performance.now();

await mkdir(artifactDirectory, { recursive: true });
// A package's own tests import `../src`, but a test that reaches across
// packages resolves through `exports` to `dist`. Without this a source-only
// edit is tested against the last build: the run is green and says nothing
// about the change. `tsc6 -b` is incremental, so it costs nothing when the
// build is current.
const built = spawnSync(
  join(repositoryRoot, "node_modules", ".bin", "tsc6"),
  ["-b", "--pretty", "false"],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (built.error) throw built.error;
if (built.status !== 0) {
  process.stderr.write(`${built.stdout ?? ""}${built.stderr ?? ""}`);
  process.stderr.write("Tests did not run: the build failed.\n");
  process.exitCode = built.status ?? 1;
  process.exit(process.exitCode);
}
const result = spawnSync(
  process.execPath,
  [vitestPath, "run", "--reporter=json", `--outputFile=${rawPath}`],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  },
);

if (result.error) throw result.error;

const raw = JSON.parse(await readFile(rawPath, "utf8"));
const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const report = {
  schemaVersion: 1,
  commit,
  startedAt: startedAt.toISOString(),
  durationMs: Math.round(performance.now() - start),
  passed: raw.numPassedTests,
  failed: raw.numFailedTests,
  skipped: raw.numPendingTests + raw.numTodoTests,
  testFiles: raw.testResults.length,
  capabilities: ["FOUNDATION-WORKSPACE", "FOUNDATION-BOUNDARIES"],
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

process.stdout.write(
  `Unit tests: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped across ${report.testFiles} files (${report.durationMs} ms).\n`,
);

if (raw.numFailedTests > 0) {
  for (const file of raw.testResults) {
    for (const assertion of file.assertionResults) {
      if (assertion.status !== "failed") continue;
      process.stderr.write(`\n${assertion.fullName}\n`);
      process.stderr.write(`${assertion.failureMessages.join("\n")}\n`);
    }
  }
}
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
