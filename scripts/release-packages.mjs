#!/usr/bin/env node

// What the workspace publishes, and under which name.
//
// The repository builds twenty-one packages and publishes nine. The layering
// is real and `check:boundaries` enforces it, but that enforcement happens
// here rather than on the registry: published separately, eleven of those
// layers were names nobody installs deliberately, pinned to each other at one
// version so they could never move apart. Splitting a published package later
// is routine; merging published ones back is not.
//
// Staging and the release check both read this, so a package cannot be
// silently dropped from the release by being absent from one list.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The package the layers below ship inside. */
export const core = "compiler";

/** The layers that ship inside `@sweetener/core` rather than beside it. */
export const absorbed = Object.freeze([
  "shared",
  "syntax",
  "reader",
  "pattern",
  "macro-language",
  "hygiene",
  "template",
  "enforestation",
  "expansion",
  "printer",
  "typescript-host",
]);

/**
 * What the repository builds but does not publish at all.
 *
 * `test-support` is the harness this repository's own suites and gate scripts
 * share. Published, it was a public contract with nothing demonstrating it —
 * no example uses it, and even the scripts here reach it by path rather than
 * by name.
 */
export const unpublished = Object.freeze(["test-support"]);

/**
 * What something outside the compiler may import from it, and where it lives.
 *
 * Only what a published package actually reaches for: the command line and the
 * Node loader use the TypeScript host, and the Prettier plugin reads syntax
 * without expanding it. The other seven layers have no entry point, which is
 * the point — they stop being a public surface.
 */
export const coreEntryPoints = Object.freeze({
  ".": core,
  "./typescript-host": "typescript-host",
  "./reader": "reader",
  "./syntax": "syntax",
  "./shared": "shared",
});

/**
 * The specifier a consumer writes for one of the core's entry points.
 *
 * `coreEntryPoints` is keyed the way an exports map is — "." and "./reader" —
 * which is one character away from the specifier and was written wrong twice.
 */
export function coreSpecifier(entryPoint) {
  return `@sweetener/${core}${entryPoint === "." ? "" : entryPoint.slice(1)}`;
}

/** Every directory under `packages`, whether or not it is published. */
export async function workspaceDirectories(root) {
  return (await readdir(join(root, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
}

/** The directories staged under their own name. */
export async function publishedDirectories(root) {
  return (await workspaceDirectories(root)).filter(
    (name) => !absorbed.includes(name) && !unpublished.includes(name),
  );
}

/** The names those directories publish under. */
export async function publishedPackageNames(root) {
  return await Promise.all(
    (await publishedDirectories(root)).map(async (directory) => {
      const manifest = JSON.parse(
        await readFile(
          join(root, "packages", directory, "package.json"),
          "utf8",
        ),
      );
      return manifest.name;
    }),
  );
}
