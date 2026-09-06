#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts", "release");
const staging = join(output, "staging");
const tarballs = join(output, "tarballs");
const version = "0.1.0-alpha.0";
const packageRoot = join(root, "packages");

await rm(output, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(tarballs, { recursive: true });

const packageDirectories = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => name)
  .sort();
/**
 * What a package's npm page says.
 *
 * Every one of these used to read "Alpha package from Sweetener language
 * version 1." and nothing else — a blank page, for a project whose whole value
 * is integrating with something. The ones a consumer installs deliberately get
 * the snippet that makes them work; the internals say what they are and point
 * at the package people should actually reach for.
 */
const summaries = {
  cli: {
    text: "Check, build, and watch a Sweetener project, and scaffold one into an existing repository.",
    usage: [
      "```sh",
      "npx sweetener init          # scaffold, after showing what it would write",
      "npx sweetener check         # type-check through the official compiler",
      "npx sweetener build         # expand and emit",
      "npx sweetener watch",
      "```",
    ].join("\n"),
  },
  unplugin: {
    text: "Sweetener for Vite, Rollup, Rolldown, webpack, Rspack, Rsbuild, esbuild, Farm, and Bun.",
    usage: [
      "```ts",
      "// vite.config.ts",
      'import { resolve } from "node:path";',
      'import sweetener from "@sweetener/unplugin/vite";',
      "",
      "export default defineConfig({",
      "  plugins: [",
      '    ...sweetener({ configFile: resolve(import.meta.dirname, "sweetener.json") }),',
      "  ],",
      "});",
      "```",
      "",
      "Swap the entry point for the host you use: `/rollup`, `/rolldown`,",
      "`/webpack`, `/rspack`, `/rsbuild`, `/esbuild`, `/farm`, `/bun`.",
    ].join("\n"),
  },
  "webpack-loader": {
    text: "A webpack, Rspack, and Turbopack loader for Sweetener sources.",
    usage: [
      "```js",
      "module.exports = {",
      "  module: {",
      "    rules: [",
      '      { test: /\\.sts$/, use: [{ loader: "@sweetener/webpack-loader" }] },',
      "    ],",
      "  },",
      "};",
      "```",
      "",
      'It emits JavaScript. Pass `options.emit: "typescript"` when a loader',
      "after this one should strip the types instead.",
    ].join("\n"),
  },
  "parcel-transformer": {
    text: "A Parcel 2 transformer for Sweetener sources.",
    usage: [
      "```json",
      "{",
      '  "extends": "@parcel/config-default",',
      '  "transformers": { "*.sts": ["@sweetener/parcel-transformer", "..."] }',
      "}",
      "```",
    ].join("\n"),
  },
  node: {
    text: "Run Sweetener sources directly on Node, through its module customization hooks.",
    usage: [
      "```sh",
      "node --import @sweetener/node/register src/main.sts",
      "```",
    ].join("\n"),
  },
  deno: {
    text: "Run Sweetener sources on Deno, through its module hooks.",
    usage: [
      "```sh",
      "deno run --import ./node_modules/@sweetener/deno/dist/src/register.js src/main.sts",
      "```",
      "",
      "`SWEETENER_CONFIG` names the project config, since a preload takes no",
      "arguments. `deno check` cannot read `.sts`; expand first for that.",
    ].join("\n"),
  },
  jest: {
    text: "An asynchronous Jest transformer for Sweetener sources, with macro-aware cache keys.",
    usage: [
      "```js",
      "// jest.config.mjs",
      "export default {",
      '  transform: { "\\\\.stsx?$": ["@sweetener/jest", {}] },',
      '  moduleFileExtensions: ["sts", "stsx", "js", "ts", "json"],',
      '  extensionsToTreatAsEsm: [".sts", ".stsx"],',
      "};",
      "```",
      "",
      "Run Jest with `NODE_OPTIONS=--experimental-vm-modules`.",
    ].join("\n"),
  },
  babel: {
    text: "Expand a Sweetener source and hand the result to Babel, with the expansion's map as Babel's input map.",
    usage: [
      "```ts",
      'import { transformSweetenerFile } from "@sweetener/babel";',
      "",
      'const result = await transformSweetenerFile("src/main.sts", {',
      "  babel: { presets: [typescript] },",
      "});",
      "```",
      "",
      "This is a programmatic entry point, not a Babel plugin, and it cannot be",
      "one: expansion has to happen before Babel parses, and a `parserOverride`",
      "returning an AST built from different text would leave every position in",
      "the source map pointing into the expansion. For a build, use",
      "`@sweetener/webpack-loader` under babel-loader, or `@sweetener/jest`",
      "instead of babel-jest.",
    ].join("\n"),
  },
  "prettier-plugin": {
    text: "Format `.sts` and `.stsx` with Prettier 3.",
    usage: [
      "```js",
      "// prettier.config.mjs",
      'import sweetener from "@sweetener/prettier-plugin";',
      "",
      "export default { plugins: [sweetener] };",
      "```",
    ].join("\n"),
  },
  compiler: {
    text: "The expansion session every build-tool adapter is built on. Reach for an adapter first.",
  },
  "typescript-host": {
    text: "Runs the official TypeScript compiler and language service over expanded virtual files.",
  },
};

const internals =
  "An internal part of the Sweetener compiler. It has no stable API of its own; install @sweetener/cli, or the adapter for your build tool, instead.";

function readmeFor(name, directory) {
  const summary = summaries[directory];
  const lines = [
    `# ${name}`,
    "",
    summary?.text ?? internals,
    "",
    "Part of [Sweetener](https://github.com/jimmyhmiller/sweetener), hygienic",
    "declarative macros for TypeScript. Alpha: the language version is 1 and the",
    "package interfaces may still change.",
  ];
  if (summary?.usage !== undefined)
    lines.push("", "## Usage", "", summary.usage);
  return `${lines.join("\n")}\n`;
}

const staged = [];
for (const directory of packageDirectories) {
  const sourceDirectory = join(packageRoot, directory);
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, "package.json"), "utf8"),
  );
  const targetDirectory = join(staging, directory);
  await mkdir(targetDirectory, { recursive: true });
  // Everything the package says it ships, not just `dist` — a package whose
  // command lives outside `dist` was staged without it, so the tarball
  // declared a command it did not contain.
  for (const entry of manifest.files ?? ["dist"]) {
    await cp(join(sourceDirectory, entry), join(targetDirectory, entry), {
      // Compiled tests and the incremental build log are not part of the
      // package. `files: ["dist"]` swept them in: 128 test artifacts in the
      // command line, 104 in expansion, each importing a devDependency —
      // vitest, vite, webpack, @parcel/core — that a consumer never installs.
      filter: (path) =>
        !/(?:^|[\\/])(?:test|\.tsbuildinfo)(?:[\\/]|$)/u.test(
          path.slice(sourceDirectory.length),
        ),
      recursive: true,
    });
  }
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).map(([name, requirement]) => [
      name,
      typeof requirement === "string" && requirement.startsWith("workspace:")
        ? version
        : requirement,
    ]),
  );
  const publishManifest = {
    name: manifest.name,
    version,
    description: `Sweetener alpha package: ${directory}`,
    type: "module",
    // Carried from the package rather than assumed. Dropping `bin` published a
    // command-line tool with no command; dropping `main` and `types` published
    // a package with no entry point at all, for the ones that name their entry
    // that way instead of through `exports`.
    ...(manifest.exports === undefined ? {} : { exports: manifest.exports }),
    ...(manifest.main === undefined ? {} : { main: manifest.main }),
    ...(manifest.types === undefined ? {} : { types: manifest.types }),
    ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
    // A package that imports its host at runtime — @babel/core, webpack, jest,
    // vite — has to say so, or it installs cleanly, warns about nothing, and
    // fails on the first import.
    ...(manifest.peerDependencies === undefined
      ? {}
      : { peerDependencies: manifest.peerDependencies }),
    ...(manifest.peerDependenciesMeta === undefined
      ? {}
      : { peerDependenciesMeta: manifest.peerDependenciesMeta }),
    files: manifest.files ?? ["dist"],
    dependencies,
    // A floor, not a ceiling. `>=24 <25` refused every Node newer than the one
    // the matrix happened to list: an install on 25 or 26 warned about a dozen
    // packages and failed outright under engine-strict, for a runtime the
    // suite passes on. The matrix covers current Node as well as the LTS.
    // Parcel asks a plugin to declare the Parcel it supports, and warns on
    // every build when it does not.
    engines: { node: ">=24", ...(manifest.engines ?? {}) },
    // Provenance is a publish-time flag, not a property of the package.
    // Declaring it here made `npm publish` fail anywhere but a CI with an
    // OIDC token — `Automatic provenance generation not supported for
    // provider: null` — which is every maintainer's machine. Release CI
    // passes `--provenance` instead.
    publishConfig: { access: "public" },
  };
  await writeFile(
    join(targetDirectory, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(targetDirectory, "README.md"),
    readmeFor(manifest.name, directory),
    "utf8",
  );
  const packed = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", tarballs],
    { cwd: targetDirectory, encoding: "utf8" },
  ).trim();
  staged.push({ name: manifest.name, directory, tarball: packed });
}

const packages = [];
for (const item of staged) {
  const path = join(tarballs, item.tarball);
  const bytes = await readFile(path);
  packages.push({
    name: item.name,
    version,
    file: `tarballs/${basename(path)}`,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
const release = {
  schemaVersion: 1,
  release: version,
  languageVersion: "1",
  specificationVersion: "1",
  macroModuleFormatVersion: 1,
  originMapSchemaVersion: 1,
  expansionTraceSchemaVersion: 1,
  fixtureVersion: "1",
  node: ">=24 <25",
  typescriptApi: "6.0.x",
  packages,
};
await writeFile(
  join(output, "release.json"),
  `${JSON.stringify(release, null, 2)}\n`,
  "utf8",
);
process.stdout.write(
  `Staged ${String(packages.length)} packages for ${version} in ${output}\n`,
);
