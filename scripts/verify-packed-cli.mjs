#!/usr/bin/env node

// Runs the command line out of the packed tarballs.
//
// Everything else about the release is checked by reading it: the tarballs
// hash to what the manifest says, the manifests carry no workspace ranges, the
// documents exist. None of that runs the thing being shipped, which is how a
// tarball that declared a `sweetener` command while containing no such file
// passed every check. This installs what would be published and uses it.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseRoot = join(root, "artifacts", "release");
const release = JSON.parse(
  await readFile(join(releaseRoot, "release.json"), "utf8"),
);

const problems = [];
const directory = mkdtempSync(join(tmpdir(), "sweetener-packed-"));
const modules = join(directory, "node_modules");

try {
  // Unpack every package as a consumer would receive it. They depend on each
  // other by name, so they all have to be present for any of them to load.
  for (const item of release.packages) {
    const target = join(modules, item.name);
    await mkdir(target, { recursive: true });
    execFileSync(
      "tar",
      [
        "-xzf",
        join(releaseRoot, item.file),
        "-C",
        target,
        "--strip-components=1",
      ],
      { stdio: "pipe" },
    );
    const manifest = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    );
    // A package that lists what it ships must actually ship it.
    for (const entry of manifest.files ?? []) {
      try {
        await stat(join(target, entry));
      } catch {
        problems.push(`${item.name} declares files["${entry}"] but omits it`);
      }
    }
    // A consumer reaches the code through `exports`, and a TypeScript consumer
    // reaches the declarations the same way, so both targets have to be there.
    for (const [condition, file] of Object.entries(
      manifest.exports?.["."] ?? {},
    )) {
      if (typeof file !== "string") continue;
      try {
        await stat(join(target, file));
      } catch {
        problems.push(
          `${item.name} points its ${condition} export at ${file}, which the tarball does not contain`,
        );
      }
    }
    for (const [command, file] of Object.entries(manifest.bin ?? {})) {
      try {
        await readFile(join(target, file), "utf8");
      } catch {
        problems.push(
          `${item.name} declares the ${command} command as ${file}, which the tarball does not contain`,
        );
      }
    }
  }

  // Everything the packages depend on that is not one of them comes from the
  // registry for a real consumer, peer dependencies included. Borrowing the
  // copies already installed here keeps this check off the network, and
  // standing them up at all is what lets the libraries below be loaded rather
  // than merely inspected. Each is resolved from the package that depends on
  // it, because the installer keeps them there rather than at the root.
  const linked = new Set();
  for (const item of release.packages) {
    const workspaceDirectory = join(
      root,
      "packages",
      item.name.split("/").at(-1),
    );
    const from = createRequire(join(workspaceDirectory, "package.json"));
    // Read from the packed manifest, not the workspace one. Taking peers from
    // the workspace supplied whatever the published package forgot to declare,
    // so the import always succeeded and the omission could not be seen.
    const packedManifest = JSON.parse(
      await readFile(join(modules, item.name, "package.json"), "utf8"),
    );
    const needed = [
      ...Object.keys(packedManifest.dependencies ?? {}),
      ...Object.keys(packedManifest.peerDependencies ?? {}),
    ];
    for (const name of needed) {
      if (name.startsWith("@sweetener/") || linked.has(name)) continue;
      let packageRoot;
      try {
        packageRoot = dirname(from.resolve(name));
      } catch {
        try {
          packageRoot = dirname(
            from.resolve(`${name}/package.json`, {
              paths: [workspaceDirectory],
            }),
          );
        } catch {
          problems.push(
            `${item.name} depends on ${name}, which is not installed here to borrow`,
          );
          linked.add(name);
          continue;
        }
      }
      while (packageRoot !== dirname(packageRoot)) {
        try {
          const found = JSON.parse(
            await readFile(join(packageRoot, "package.json"), "utf8"),
          );
          if (found.name === name || found.name === undefined) break;
          break;
        } catch {
          packageRoot = dirname(packageRoot);
        }
      }
      const target = join(modules, name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(packageRoot, target, "dir");
      linked.add(name);
    }
  }

  // A project of the shape the README describes.
  await writeFile(
    join(directory, "macros.sts"),
    `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value] }\n}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "main.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const doubled = twice(21);\n`,
    "utf8",
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        sweet: { macroExtensions: [".sts"] },
        files: ["macros.sts", "main.sts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Load every library by name from the unpacked tree. The command line
  // reaches most of them, but only along the paths it happens to use; a
  // consumer writing `import { ... } from "@sweetener/compiler"` does not.
  // By the entry points each package actually declares. One of them exposes
  // only a subpath, and importing its bare name would fail by design.
  const importable = [];
  for (const item of release.packages) {
    if (item.name === "@sweetener/cli") continue;
    const manifest = JSON.parse(
      await readFile(join(modules, item.name, "package.json"), "utf8"),
    );
    const subpaths = Object.keys(manifest.exports ?? {});
    if (subpaths.length === 0) importable.push(item.name);
    else
      for (const subpath of subpaths) {
        // A register entry point exists to install loader hooks into whatever
        // imports it, and which runtime that is decides whether it should.
        // Importing one here would be asking the wrong question; each is
        // covered by its own tests and, for Deno, by the example CI runs.
        if (subpath.endsWith("/register")) continue;
        importable.push(join(item.name, subpath).replaceAll("\\", "/"));
      }
  }
  // One process each, rather than one process for all of them. A package
  // whose whole purpose is a global side effect — a loader hook that installs
  // itself on import — would otherwise decide the fate of every package
  // imported after it, and report their failures as their own.
  await writeFile(
    join(directory, "import-one.mjs"),
    `await import(process.argv[2]);\n`,
    "utf8",
  );
  for (const specifier of importable) {
    try {
      execFileSync(
        process.execPath,
        [join(directory, "import-one.mjs"), specifier],
        { cwd: directory, encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      const detail =
        error instanceof Error && "stderr" in error
          ? (String(error.stderr ?? error.message)
              .split("\n")
              .find((line) => line.trim().length > 0) ?? error.message)
          : String(error);
      problems.push(`a consumer cannot import ${specifier}: ${detail.trim()}`);
    }
  }

  const cli = release.packages.find(({ name }) => name === "@sweetener/cli");
  if (cli === undefined) problems.push("no @sweetener/cli in the release");
  else {
    const manifest = JSON.parse(
      await readFile(join(modules, cli.name, "package.json"), "utf8"),
    );
    const command = manifest.bin?.sweetener;
    if (command === undefined)
      problems.push("@sweetener/cli publishes no sweetener command");
    else {
      // Through the command the manifest names, which is what a package
      // manager links, rather than through the built file behind it.
      const entry = join(modules, cli.name, command);
      const run = (arguments_) =>
        execFileSync(process.execPath, [entry, ...arguments_], {
          cwd: directory,
          encoding: "utf8",
          stdio: "pipe",
        });
      // Compared without regard to layout: this is checking that the macro
      // ran, not how the printer spaces an array.
      const expanded = (text) =>
        text.replaceAll(/\s+/gu, "").includes("[21,21]");
      try {
        const printed = run(["expand", "main.sts"]);
        if (!expanded(printed))
          problems.push(
            `the packed command printed unexpected expansion: ${JSON.stringify(printed)}`,
          );
        // The guide is copied in when the release is staged, so only the
        // packed command shows whether it arrived.
        const guide = run(["guide"]);
        if (!guide.includes("# Sweetener"))
          problems.push(
            `the packed command printed no guide: ${JSON.stringify(guide.slice(0, 200))}`,
          );
        run(["emit", "macros.sts", "main.sts", "--out-dir", ".sweetener"]);
        const emitted = await readFile(
          join(directory, ".sweetener", "main.ts"),
          "utf8",
        );
        if (!expanded(emitted))
          problems.push(
            `the packed command emitted unexpected TypeScript: ${JSON.stringify(emitted)}`,
          );
      } catch (error) {
        const detail =
          error instanceof Error && "stderr" in error
            ? String(error.stderr ?? error.message)
            : String(error);
        problems.push(`the packed command failed to expand a file: ${detail}`);
      }
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(
    "The packed command line installs and expands a project.\n",
  );
