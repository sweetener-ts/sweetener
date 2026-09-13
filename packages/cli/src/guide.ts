import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The file the guide is kept in, at the repository root and in the package. */
export const guideFileName = "SKILL.md";

/**
 * Where the guide is, from where this module was loaded.
 *
 * The published package carries a copy of the repository's `SKILL.md` at its
 * root, placed there when the release is staged, so the guide a user reads is
 * the one the repository documents. Run from a checkout there is no copy, and
 * the repository's own is two directories above the package.
 */
export function guidePath(
  moduleUrl: string = import.meta.url,
): string | undefined {
  // This module is dist/src/guide.js, two directories below the package root.
  const packageRoot = join(dirname(fileURLToPath(moduleUrl)), "..", "..");
  const packaged = join(packageRoot, guideFileName);
  if (existsSync(packaged)) return packaged;
  const repositoryRoot = join(packageRoot, "..", "..");
  const checkout = join(repositoryRoot, guideFileName);
  return existsSync(join(repositoryRoot, "pnpm-workspace.yaml")) &&
    existsSync(checkout)
    ? checkout
    : undefined;
}

/**
 * The guide as a person reads it. Its front matter names it for agents that
 * load it as a skill, and says nothing to someone at a terminal.
 */
export function readGuide(path: string): string {
  const text = readFileSync(path, "utf8");
  const frontMatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/u.exec(text);
  return frontMatter === null ? text : text.slice(frontMatter[0].length);
}
