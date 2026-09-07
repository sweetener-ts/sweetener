#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  absorbed,
  publishedDirectories,
  publishedPackageNames,
  unpublished,
  workspaceDirectories,
} from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = join(root, "artifacts", "release");
const release = JSON.parse(
  await readFile(join(releaseRoot, "release.json"), "utf8"),
);
const problems = [];
if (release.release !== "0.1.0-alpha.0")
  problems.push("unexpected alpha version");
for (const field of [
  "languageVersion",
  "specificationVersion",
  "macroModuleFormatVersion",
  "originMapSchemaVersion",
  "expansionTraceSchemaVersion",
  "fixtureVersion",
])
  if (release[field] === undefined) problems.push(`missing ${field}`);
// Not every workspace package is published — eleven ship inside
// @sweetener/compiler and one is not published at all — but every one has to
// be accounted for, or a new package is dropped from the release by being
// absent from a list rather than by a decision.
const directories = await workspaceDirectories(root);
for (const directory of directories)
  if (
    !absorbed.includes(directory) &&
    !unpublished.includes(directory) &&
    !(await publishedDirectories(root)).includes(directory)
  )
    problems.push(`${directory} is neither published, absorbed, nor excluded`);
const expectedPackageNames = new Set(await publishedPackageNames(root));
const releasedPackageNames = new Set(release.packages.map((item) => item.name));
if (
  expectedPackageNames.size !== releasedPackageNames.size ||
  [...expectedPackageNames].some((name) => !releasedPackageNames.has(name))
)
  problems.push(
    "release package set does not match what the workspace publishes",
  );
for (const item of release.packages) {
  const bytes = await readFile(join(releaseRoot, item.file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== item.sha256 || bytes.byteLength !== item.bytes)
    problems.push(`tarball integrity mismatch for ${item.name}`);
  const manifest = JSON.parse(
    await readFile(
      join(releaseRoot, "staging", item.name.split("/").at(-1), "package.json"),
      "utf8",
    ),
  );
  if (manifest.private === true || manifest.version !== release.release)
    problems.push(`invalid publish manifest for ${item.name}`);
  if (
    Object.values(manifest.dependencies ?? {}).some(
      (value) => typeof value === "string" && value.startsWith("workspace:"),
    )
  )
    problems.push(`workspace dependency in ${item.name}`);
}
for (const document of [
  "0.1.0-alpha.0.md",
  "compatibility-matrix.md",
  "external-samples.md",
  "known-limitations.md",
  "versioning.md",
])
  try {
    await readFile(join(root, "docs", "release", document), "utf8");
  } catch {
    problems.push(`missing release document ${document}`);
  }

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
} else
  process.stdout.write("Alpha release artifacts and documents are current.\n");
