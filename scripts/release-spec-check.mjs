#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  coreEntryPoints,
  coreSpecifier,
  publishedPackageNames,
} from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const specificationDirectory = join(root, "docs", "specifications");
const release = await readFile(
  join(specificationDirectory, "06-public-release-surface.md"),
  "utf8",
);
const requiredSections = [
  "Source ownership and grammar",
  "Hygiene and phases",
  "Categories, operators, and generated definitions",
  "Macro-module format",
  "Trace and origin-map formats",
  "Security and resources",
  "Public packages",
  "Migration from Sweet.js",
];
// Derived, not listed: the spec has to name what actually publishes, and a
// second copy of the list is a second place to forget.
const requiredPackages = [
  ...(await publishedPackageNames(root)),
  ...Object.keys(coreEntryPoints)
    .filter((entryPoint) => entryPoint !== ".")
    .map(coreSpecifier),
];
const problems = [];
for (const [index, section] of requiredSections.entries())
  if (!release.includes(`## ${String(index + 1)}. ${section}`))
    problems.push(`missing release section ${section}`);
for (const packageName of requiredPackages)
  if (!release.includes(`\`${packageName}\``))
    problems.push(`missing public package ${packageName}`);

for (const name of await readdir(specificationDirectory)) {
  if (!name.endsWith(".md")) continue;
  const text = await readFile(join(specificationDirectory, name), "utf8");
  if (/OPEN-[A-Z]+-\d+/u.test(text))
    problems.push(`unresolved decision marker in ${name}`);
}

const decisionDirectory = join(root, "docs", "decisions");
const numbers = new Map();
for (const name of await readdir(decisionDirectory)) {
  const number = /^(\d{4})-.*\.md$/u.exec(name)?.[1];
  if (number === undefined) continue;
  const previous = numbers.get(number);
  if (previous !== undefined)
    problems.push(`duplicate ADR ${number}: ${previous}, ${name}`);
  numbers.set(number, name);
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
} else
  process.stdout.write("Release specifications are complete and indexed.\n");
