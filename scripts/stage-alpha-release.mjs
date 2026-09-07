#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  absorbed,
  core,
  coreEntryPoints,
  coreSpecifier,
  publishedDirectories,
} from "./release-packages.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(root, "artifacts", "release");
const staging = join(output, "staging");
const tarballs = join(output, "tarballs");
// The one place the release version is written. It was a constant here, which
// made bumping it an edit to a build script rather than to the thing `npm
// version` bumps.
const version = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
).version;
const packageRoot = join(root, "packages");

await rm(output, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(tarballs, { recursive: true });

const packageDirectories = await publishedDirectories(root);
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
    keywords: ["command-line", "build", "watch"],
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
    keywords: [
      "vite",
      "rollup",
      "rolldown",
      "webpack",
      "rspack",
      "rsbuild",
      "esbuild",
      "farm",
      "bun",
      "unplugin",
    ],
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
    keywords: ["webpack", "loader", "nextjs", "turbopack"],
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
    keywords: ["parcel", "transformer"],
    text: "A Parcel 2 transformer for Sweetener sources. Its entry point is CommonJS so that Parcel loads it through its own `require` rather than analyzing the plugin's module graph, which reaches the TypeScript compiler and its runtime `require` calls; builds with it warn about nothing and keep their cache.",
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
    keywords: ["node", "loader", "register"],
    text: "Run Sweetener sources directly on Node, through its module customization hooks.",
    usage: [
      "```sh",
      "node --import @sweetener/node/register src/main.sts",
      "```",
    ].join("\n"),
  },
  deno: {
    keywords: ["deno", "loader", "register"],
    text: "Run Sweetener sources on Deno, through its module hooks.",
    usage: [
      "```sh",
      "SWEETENER_CONFIG=./sweetener.json \\",
      "  deno run --import npm:@sweetener/deno/register src/main.sts",
      "```",
      "",
      "A bare `@sweetener/deno/register` is resolved as a path rather than as a",
      "package, so name it as npm. `SWEETENER_CONFIG` names the project config,",
      "since a preload takes no arguments. `deno check` cannot read `.sts`;",
      "expand first for that.",
    ].join("\n"),
  },
  jest: {
    keywords: ["jest", "transformer", "testing"],
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
  "prettier-plugin": {
    keywords: ["prettier", "formatter", "plugin"],
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
    keywords: ["compiler", "expansion", "hygiene"],
    text: "The Sweetener compiler: the expansion session every build-tool adapter is built on. Reach for an adapter first.",
    usage: [
      "```ts",
      'import { createSweetenerSession } from "@sweetener/compiler";',
      "",
      "const session = createSweetenerSession();",
      "const result = await session.transform({ code, filename, configFile });",
      "```",
      "",
      "Subpaths expose the layers a host reaches past the session for:",
      "`/typescript-host` runs the official TypeScript compiler and language",
      "service over expanded virtual files, and `/reader`, `/syntax` and",
      "`/shared` read Sweetener source without expanding it. Everything else is",
      "internal and has no stable API.",
    ].join("\n"),
  },
};

function readmeFor(name, directory) {
  const summary = summaries[directory];
  // Every published package is one someone installs deliberately, so every one
  // has something to say. This used to fall back to a sentence about being an
  // internal part of the compiler, which is what the layers now inside
  // `@sweetener/compiler` published instead of a page.
  if (summary === undefined)
    throw new Error(
      `No README summary for ${directory}. Add one to \`summaries\` in this script, or absorb the package into @sweetener/${core}.`,
    );
  const lines = [
    `# ${name}`,
    "",
    summary.text,
    "",
    "Part of [Sweetener](https://github.com/jimmyhmiller/sweetener), hygienic",
    "declarative macros for TypeScript. Alpha: the language version is 1 and the",
    "package interfaces may still change.",
  ];
  if (summary?.usage !== undefined)
    lines.push("", "## Usage", "", summary.usage);
  return `${lines.join("\n")}\n`;
}

/**
 * Every module specifier in built output, and nothing that merely looks like
 * one.
 *
 * Each layer exports a `packageName` constant holding its own name, so a blind
 * replacement rewrote a string value into a relative path. Anchoring on the
 * import forms keeps to specifiers.
 */
const specifierPattern =
  /(from\s*|import\(\s*|require\(\s*)"(@sweetener\/[a-z-]+)"/gu;

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  }))
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name));
  return found;
}

/** Rewrite the specifiers in built JavaScript and declarations, in place. */
async function rewriteSpecifiers(directory, resolveSpecifier) {
  for (const file of await filesUnder(directory)) {
    if (!/\.(?:js|d\.ts)$/u.test(file)) continue;
    const before = await readFile(file, "utf8");
    const after = before.replaceAll(
      specifierPattern,
      (match, lead, specifier) => {
        const replacement = resolveSpecifier(specifier, file);
        return replacement === undefined ? match : `${lead}"${replacement}"`;
      },
    );
    if (after !== before) await writeFile(file, after, "utf8");
  }
}

/** Where an absorbed layer's entry point sits inside the merged package. */
function entryPointFor(name) {
  const found = Object.entries(coreEntryPoints).find(
    ([, directory]) => directory === name,
  );
  return found?.[0];
}

const staged = [];
for (const directory of packageDirectories) {
  const sourceDirectory = join(packageRoot, directory);
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, "package.json"), "utf8"),
  );
  const targetDirectory = join(staging, directory);
  await mkdir(targetDirectory, { recursive: true });
  // The merged package holds one directory per layer, its own included, so
  // every entry point is addressed the same way and nothing has to know which
  // layer it came from.
  const layers = directory === core ? [core, ...absorbed] : [];
  for (const layer of layers)
    await cp(
      join(packageRoot, layer, "dist"),
      join(targetDirectory, "dist", layer),
      {
        filter: (path) =>
          !/(?:^|[\\/])(?:test|\.tsbuildinfo)(?:[\\/]|$)/u.test(path),
        recursive: true,
      },
    );
  // Everything the package says it ships, not just `dist` — a package whose
  // command lives outside `dist` was staged without it, so the tarball
  // declared a command it did not contain.
  for (const entry of layers.length > 0 ? [] : (manifest.files ?? ["dist"])) {
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
  if (layers.length > 0)
    // Inside the merged package a layer reaches its neighbour by path. The
    // names it used to import are the directories it now sits beside.
    await rewriteSpecifiers(targetDirectory, (specifier, file) => {
      const layer = specifier.slice("@sweetener/".length);
      if (!layers.includes(layer)) return undefined;
      const target = join(targetDirectory, "dist", layer, "src", "index.js");
      const path = relative(dirname(file), target).replaceAll("\\", "/");
      return path.startsWith(".") ? path : `./${path}`;
    });
  else
    // Outside it, a layer is a subpath of the compiler — or it is internal,
    // and a package importing it has to say what it needs before this can
    // publish something whose imports do not resolve.
    await rewriteSpecifiers(targetDirectory, (specifier) => {
      const layer = specifier.slice("@sweetener/".length);
      if (!absorbed.includes(layer)) return undefined;
      const entryPoint = entryPointFor(layer);
      if (entryPoint === undefined)
        throw new Error(
          `${manifest.name} imports ${specifier}, which ships inside @sweetener/${core} with no entry point. Add one to \`coreEntryPoints\`, or stop importing it.`,
        );
      return coreSpecifier(entryPoint);
    });
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {})
      // An absorbed layer is not a dependency any more; the package that holds
      // it is.
      .map(([name, requirement]) =>
        absorbed.includes(name.slice("@sweetener/".length))
          ? [`@sweetener/${core}`, `workspace:*`]
          : [name, requirement],
      )
      .filter(([name]) => name !== manifest.name)
      .map(([name, requirement]) => [
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
    ...(layers.length > 0
      ? {
          exports: Object.fromEntries(
            Object.entries(coreEntryPoints).map(([entryPoint, layer]) => [
              entryPoint,
              {
                types: `./dist/${layer}/src/index.d.ts`,
                import: `./dist/${layer}/src/index.js`,
              },
            ]),
          ),
        }
      : manifest.exports === undefined
        ? {}
        : { exports: manifest.exports }),
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
    // npm carries a LICENSE beside a package whether or not `files` lists it,
    // but only if one is there: each staged package is built from nothing, so
    // the repository's has to be copied in. Without it every package publishes
    // as all-rights-reserved, which is a licence nobody can use.
    license: "MIT",
    author: "Jimmy Miller <jimmyhmiller@gmail.com>",
    repository: {
      type: "git",
      url: "git+https://github.com/jimmyhmiller/sweetener.git",
      directory: `packages/${directory}`,
    },
    homepage: `https://github.com/jimmyhmiller/sweetener/tree/main/packages/${directory}#readme`,
    bugs: { url: "https://github.com/jimmyhmiller/sweetener/issues" },
    keywords: [
      "sweetener",
      "macros",
      "typescript",
      "hygienic",
      "syntax",
      ...(summaries[directory]?.keywords ?? []),
    ],
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
  await cp(join(root, "LICENSE"), join(targetDirectory, "LICENSE"));
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
  // The same floor the packages carry. This said `>=24 <25` while every
  // package it describes said `>=24`, and the compatibility workflow passes
  // on current Node.
  node: ">=24",
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
