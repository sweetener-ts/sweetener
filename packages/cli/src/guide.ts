import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The file the guide is kept in, at the repository root and in the package. */
export const guideFileName = "SKILL.md";

/**
 * The directory of the package this module belongs to. Found by looking up
 * rather than by counting, because the module runs from `dist/src` once built
 * and from `src` under the test runner.
 */
function cliPackageRoot(start: string): string | undefined {
  for (let directory = start; ; directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as {
        readonly name?: unknown;
      };
      if (name === "@sweetener/cli") return directory;
    }
    if (dirname(directory) === directory) return undefined;
  }
}

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
  const packageRoot = cliPackageRoot(dirname(fileURLToPath(moduleUrl)));
  if (packageRoot === undefined) return undefined;
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
