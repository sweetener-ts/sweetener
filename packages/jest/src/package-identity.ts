import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The name and version of the package the module at `moduleUrl` ships in:
 * those of the nearest manifest above it that names a package. A manifest
 * with no name -- one a build writes to say how its files are loaded -- says
 * nothing about which release they are.
 */
export function packageIdentity(moduleUrl: string): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const { name, version } = JSON.parse(readFileSync(manifest, "utf8")) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      if (typeof name === "string")
        return `${name}@${typeof version === "string" ? version : ""}`;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`No package manifest names the package of ${moduleUrl}`);
    directory = parent;
  }
}
