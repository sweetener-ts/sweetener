import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const languageTourRoot = resolve(
  import.meta.dirname,
  "../../../examples/language-tour",
);

/**
 * Every `.sts` and `.stsx` the language tour is written in, as paths relative
 * to the tour, sorted.
 *
 * Walked rather than read with `recursive: true`, because the tour is a
 * workspace package and `pnpm install` therefore always leaves a
 * `node_modules` in it, whose every entry is a link into the pnpm store. A
 * recursive read descends the whole store: 492,825 entries and about twelve
 * seconds, to find exactly the ninety-two files that a walk stopping at
 * `node_modules` finds in a few milliseconds. The cost looked like slow
 * formatting and was paid for by raising a test's timeout, which hid it.
 */
export function languageTourSources(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(languageTourRoot, directory), {
      withFileTypes: true,
    })) {
      if (entry.name === "node_modules") continue;
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.stsx?$/u.test(entry.name)) found.push(path);
    }
  };
  walk("");
  // A corpus test that reads nothing passes, so a walk that reaches nothing is
  // an error rather than an empty list.
  if (found.length === 0)
    throw new Error(`No .sts or .stsx sources under ${languageTourRoot}`);
  return found.sort();
}
