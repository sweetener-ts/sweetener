#!/usr/bin/env node

// Builds the Zed and VS Code extensions and writes the archives a GitHub
// Release carries. The language server is not bundled: both extensions start
// `packages/cli/bin/sweetener-lsp.mjs` from a checkout that has been built.

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
const output = join(root, "artifacts", "editors");
const zedSource = join(root, "editors", "zed");
const vscodeSource = join(root, "editors", "vscode");
const zedStage = join(output, "sweetener-zed");
const zedArchive = `sweetener-zed-${version}.tar.gz`;
const vscodeArchive = `sweetener-vscode-${version}.vsix`;

await rm(output, { recursive: true, force: true });
await mkdir(zedStage, { recursive: true });

execFileSync(
  "cargo",
  ["build", "--locked", "--release", "--target", "wasm32-wasip2"],
  { cwd: zedSource, stdio: "inherit" },
);

for (const name of [
  "extension.toml",
  "Cargo.toml",
  "Cargo.lock",
  "README.md",
  "THIRD-PARTY-LICENSES.txt",
]) {
  await cp(join(zedSource, name), join(zedStage, name));
}
await cp(join(zedSource, "src"), join(zedStage, "src"), { recursive: true });
await cp(join(zedSource, "languages"), join(zedStage, "languages"), {
  recursive: true,
});
await cp(
  join(zedSource, "target", "wasm32-wasip2", "release", "sweetener.wasm"),
  join(zedStage, "extension.wasm"),
);

execFileSync(
  "tar",
  ["-czf", join(output, zedArchive), "-C", output, "sweetener-zed"],
  {
    stdio: "inherit",
  },
);

execFileSync("npm", ["ci"], { cwd: vscodeSource, stdio: "inherit" });
execFileSync(
  "npx",
  [
    "--yes",
    "@vscode/vsce@3.6.0",
    "package",
    "--out",
    join(output, vscodeArchive),
    "--allow-missing-repository",
  ],
  { cwd: vscodeSource, stdio: "inherit" },
);

await writeFile(
  join(output, "editors.json"),
  `${JSON.stringify(
    {
      version,
      target: "wasm32-wasip2",
      rustc: "1.98.1",
      files: [zedArchive, vscodeArchive],
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`editor archives written to ${output}\n`);
