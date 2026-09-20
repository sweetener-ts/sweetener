#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const artifactDirectory = join(repositoryRoot, "artifacts", "test-results");
const rawPath = join(artifactDirectory, "vitest.raw");
const reportPath = join(artifactDirectory, "unit.json");
const vitestPath = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");

/**
 * Removes whatever the last run left at `path`.
 *
 * The file's name never varies, so nothing about it distinguishes this run's
 * output from the one before it. Left in place, a Vitest that died before
 * writing left the previous run's report to be read and stamped with this
 * commit -- `pnpm test` still failed, because the exit code comes from the
 * process rather than from the file, but `unit.json` and the `STATUS.md`
 * validation table rendered from it recorded a pass at a commit where no test
 * ran. A recorded green that nothing produced is worse than a red.
 */
export async function clearRawOutput(path) {
  await rm(path, { force: true });
}

/**
 * The report this run wrote, or an error naming what happened.
 *
 * A run that produced no report is a run with no result, not a run that
 * passed, so a missing file is reported as itself rather than filled in from
 * whatever else is on disk.
 */
export async function readRawOutput(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      `Vitest wrote no report at ${path}. The run produced no result, so ` +
        `none is recorded. Check the output above for how it ended.`,
      { cause: error },
    );
  }
  return JSON.parse(text);
}

async function main() {
  const startedAt = new Date();
  const start = performance.now();
  await mkdir(artifactDirectory, { recursive: true });
  await clearRawOutput(rawPath);
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

  let raw;
  try {
    raw = await readRawOutput(rawPath);
  } catch (error) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = result.status === 0 ? 1 : (result.status ?? 1);
    return;
  }
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
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
