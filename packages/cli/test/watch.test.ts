import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { watchConfiguredProject } from "../src/index.js";

/**
 * What a watch follows, and how often it builds.
 *
 * The set of watched files cannot be taken once, when the watch begins. A file
 * added to the project afterwards, and a macro module a file newly imports,
 * have to be watched too -- otherwise editing either rebuilds nothing, and the
 * build keeps reporting what it found before. Builds are also delayed: an
 * editor writing one file in two steps, or a save across several files, must
 * not start a build for each write.
 */

function project(): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-watch-"));
  writeFileSync(
    join(directory, "macros.sts"),
    "export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }",
  );
  writeFileSync(
    join(directory, "main.sts"),
    'import { twice } from "./macros.sts" for syntax;\nexport const a = twice(1);\n',
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      include: ["*.sts"],
    }),
  );
  return directory;
}

/** A system that records its watchers so a test can fire them by hand. */
function recordingSystem() {
  const files = new Map<string, () => void>();
  const directories = new Map<string, (fileName: string) => void>();
  const system: ts.System = {
    ...ts.sys,
    watchFile: (fileName, callback) => {
      files.set(fileName, () =>
        callback(fileName, ts.FileWatcherEventKind.Changed),
      );
      return { close: () => files.delete(fileName) };
    },
    watchDirectory: (directory, callback) => {
      directories.set(directory, callback);
      return { close: () => directories.delete(directory) };
    },
  };
  return { system, files, directories };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("watching a project", () => {
  test("follows a macro module a file newly imports", async () => {
    const directory = project();
    const { system, files } = recordingSystem();
    const results: number[] = [];
    const watch = watchConfiguredProject({
      configPath: join(directory, "tsconfig.json"),
      system,
      writeThrough: false,
      debounceMilliseconds: 0,
      onResult: (result) => results.push(result.diagnostics.length),
    });
    try {
      expect(files.has(join(directory, "macros.sts"))).toBe(true);

      // A second macro module, imported only after the watch began.
      writeFileSync(
        join(directory, "more.sts"),
        "export syntax thrice:expr { rule { thrice($x:tt) } => { [$x, $x, $x] } }",
      );
      writeFileSync(
        join(directory, "main.sts"),
        'import { twice } from "./macros.sts" for syntax;\n' +
          'import { thrice } from "./more.sts" for syntax;\n' +
          "export const a = twice(1);\nexport const b = thrice(2);\n",
      );
      files.get(join(directory, "main.sts"))!();
      await settle();

      expect(files.has(join(directory, "more.sts"))).toBe(true);
      expect(watch.result.diagnostics).toEqual([]);
      expect(
        watch.result.virtualFiles.find(({ fileName }) =>
          fileName.endsWith("main.ts"),
        )?.generated.text,
      ).toContain("[2, 2, 2]");
    } finally {
      watch.close();
    }
  });

  test("follows a macro package from before it is installed", async () => {
    const directory = project();
    writeFileSync(
      join(directory, "main.sts"),
      'import { packaged } from "@acme/forms" for syntax;\nexport const a = packaged(1);\n',
    );
    const { system, files, directories } = recordingSystem();
    const watch = watchConfiguredProject({
      configPath: join(directory, "tsconfig.json"),
      system,
      writeThrough: false,
      debounceMilliseconds: 0,
      onResult: () => {},
    });
    const packageRoot = join(directory, "node_modules", "@acme", "forms");
    const generated = () =>
      watch.result.virtualFiles.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      )?.generated.text;
    const manifest = (source: string) =>
      JSON.stringify({
        formatVersion: 1,
        name: "@acme/forms",
        languageVersion: "1",
        compiler: { minimum: "0.1.0", maximum: "0.9.x" },
        entry: "./macros.sts",
        exports: { packaged: { source, category: "expr", phase: 1 } },
        dependencies: [],
      });
    try {
      expect(watch.result.diagnostics).not.toEqual([]);
      // Nothing is there to watch yet, so it is watched for from the nearest
      // directory that is: the project's, where `node_modules` will appear.
      const packageJson = join(packageRoot, "package.json");
      expect(files.has(packageJson)).toBe(false);
      const project = directories.get(directory)!;

      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        packageJson,
        JSON.stringify({
          name: "@acme/forms",
          version: "1.0.0",
          sweetMacros: "./sweet-macros.json",
        }),
      );
      writeFileSync(
        join(packageRoot, "sweet-macros.json"),
        manifest("./macros.sts"),
      );
      writeFileSync(
        join(packageRoot, "macros.sts"),
        "export syntax packaged:expr { rule { packaged($x:tt) } => { [$x, $x] } }",
      );
      writeFileSync(
        join(packageRoot, "more.sts"),
        "export syntax packaged:expr { rule { packaged($x:tt) } => { [$x, $x, $x] } }",
      );
      project(join(directory, "notes.md"));
      await settle();
      expect(watch.result.diagnostics).not.toEqual([]);
      project(join(directory, "node_modules"));
      await settle();
      expect(watch.result.diagnostics).toEqual([]);
      expect(generated()).toContain("[1, 1]");

      // The manifest is package metadata, not a macro module, and is watched
      // all the same: pointing it elsewhere rebuilds.
      const manifestPath = join(packageRoot, "sweet-macros.json");
      writeFileSync(manifestPath, manifest("./more.sts"));
      files.get(manifestPath)!();
      await settle();
      expect(generated()).toContain("[1, 1, 1]");
    } finally {
      watch.close();
    }
  });

  test("builds once for a burst of writes", async () => {
    const directory = project();
    const { system, files } = recordingSystem();
    let builds = 0;
    const watch = watchConfiguredProject({
      configPath: join(directory, "tsconfig.json"),
      system,
      writeThrough: false,
      debounceMilliseconds: 0,
      onResult: () => (builds += 1),
    });
    try {
      expect(builds).toBe(1);
      const fire = files.get(join(directory, "main.sts"))!;
      fire();
      fire();
      fire();
      await settle();
      expect(builds).toBe(2);
    } finally {
      watch.close();
    }
  });

  test("a directory change to an unrelated file starts no build", async () => {
    const directory = project();
    const { system, directories } = recordingSystem();
    let builds = 0;
    const watch = watchConfiguredProject({
      configPath: join(directory, "tsconfig.json"),
      system,
      writeThrough: false,
      debounceMilliseconds: 0,
      onResult: () => (builds += 1),
    });
    try {
      const notify = directories.get(directory)!;
      notify(join(directory, "notes.md"));
      notify(join(directory, "node_modules", "pkg", "index.ts"));
      await settle();
      expect(builds).toBe(1);

      notify(join(directory, "added.sts"));
      await settle();
      expect(builds).toBe(2);
    } finally {
      watch.close();
    }
  });

  test("stops building once closed", async () => {
    const directory = project();
    const { system, files } = recordingSystem();
    let builds = 0;
    const watch = watchConfiguredProject({
      configPath: join(directory, "tsconfig.json"),
      system,
      writeThrough: false,
      debounceMilliseconds: 0,
      onResult: () => (builds += 1),
    });
    const fire = files.get(join(directory, "main.sts"))!;
    fire();
    watch.close();
    await settle();
    expect(builds).toBe(1);
  });
});

/**
 * The same watch on the real file system, through TypeScript's own watchers.
 *
 * A recording system accepts a watch on anything, so it cannot show what
 * Node refuses: TypeScript watches a file that is not there by polling it at
 * the interval its caller gives, and `fs.watchFile` throws without one --
 * which ended the watch the moment it followed a path that did not exist.
 */
// The operating system's watchers are slow to start on a loaded machine --
// macOS has taken over twenty seconds to deliver a process its first event --
// so these wait until the watch is listening, and allow it that long.
describe(
  "watching a project on the real file system",
  { timeout: 120_000 },
  () => {
    const until = async (done: () => boolean): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (!done()) {
        if (Date.now() > deadline)
          throw new Error("The watch did not rebuild within 30 seconds");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    /**
     * Wait until the watch is listening. An operating system's watcher starts
     * listening a little after it is made, and a change before then reaches no
     * watcher -- TypeScript's own included. Writing files the watch reacts to
     * until it reacts says it is listening.
     */
    const listening = async (
      directory: string,
      builds: () => number,
    ): Promise<void> => {
      const deadline = Date.now() + 90_000;
      for (let attempt = 0; Date.now() < deadline; attempt += 1) {
        const before = builds();
        // A new file each time: some watchers -- kqueue's, which Node falls back
        // to off its main thread -- see a directory's entries change but not a
        // file in it being rewritten.
        writeFileSync(
          join(directory, `listening-${attempt}.ts`),
          `export const attempt = ${attempt};\n`,
        );
        const patience = Date.now() + 250;
        while (Date.now() < patience) {
          if (builds() > before) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw new Error("The watch did not start listening within 90 seconds");
    };
    const generated = (watch: ReturnType<typeof watchConfiguredProject>) =>
      watch.result.virtualFiles.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      )?.generated.text;
    const writeFormsPackage = (packageRoot: string, rule: string): void => {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@acme/forms",
          version: "1.0.0",
          sweetMacros: "./sweet-macros.json",
        }),
      );
      writeFileSync(
        join(packageRoot, "sweet-macros.json"),
        JSON.stringify({
          formatVersion: 1,
          name: "@acme/forms",
          languageVersion: "1",
          compiler: { minimum: "0.1.0", maximum: "0.9.x" },
          entry: "./forms.sts",
          exports: {
            packaged: { source: "./forms.sts", category: "expr", phase: 1 },
          },
          dependencies: [],
        }),
      );
      writeFileSync(
        join(packageRoot, "forms.sts"),
        `export syntax packaged:expr { rule { packaged($x:tt) } => { ${rule} } }\n`,
      );
    };
    const formsUser =
      'import { packaged } from "@acme/forms" for syntax;\nexport const a = packaged(1);\n';

    test("follows a config that extends a package", async () => {
      const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "sweet-watch-")),
      );
      const base = join(directory, "node_modules", "@tsconfig", "base");
      mkdirSync(base, { recursive: true });
      writeFileSync(
        join(base, "package.json"),
        JSON.stringify({ name: "@tsconfig/base", version: "1.0.0" }),
      );
      writeFileSync(
        join(base, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      writeFileSync(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          extends: "@tsconfig/base/tsconfig.json",
          compilerOptions: { noEmit: true, target: "ES2022" },
          files: ["main.sts"],
        }),
      );
      writeFileSync(
        join(directory, "macros.sts"),
        "export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }",
      );
      writeFileSync(
        join(directory, "main.sts"),
        'import { twice } from "./macros.sts" for syntax;\nexport const a = twice(1);\n',
      );
      let builds = 0;
      const watch = watchConfiguredProject({
        configPath: join(directory, "tsconfig.json"),
        writeThrough: false,
        debounceMilliseconds: 0,
        onResult: () => (builds += 1),
      });
      try {
        expect(generated(watch)).toContain("[1, 1]");
        await listening(directory, () => builds);
        writeFileSync(
          join(directory, "macros.sts"),
          "export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x, $x] } }",
        );
        await until(() => generated(watch)?.includes("[1, 1, 1]") === true);
      } finally {
        watch.close();
      }
    });

    test("follows a macro package installed above the project", async () => {
      const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "sweet-watch-")),
      );
      const packageRoot = join(directory, "node_modules", "@acme", "forms");
      writeFormsPackage(packageRoot, "[$x, $x]");
      const app = join(directory, "app");
      mkdirSync(app);
      writeFileSync(
        join(app, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, target: "ES2022" },
          files: ["main.sts"],
        }),
      );
      writeFileSync(join(app, "main.sts"), formsUser);
      let builds = 0;
      const watch = watchConfiguredProject({
        configPath: join(app, "tsconfig.json"),
        writeThrough: false,
        debounceMilliseconds: 0,
        onResult: () => (builds += 1),
      });
      try {
        expect(generated(watch)).toContain("[1, 1]");
        await listening(app, () => builds);
        writeFormsPackage(packageRoot, "[$x, $x, $x]");
        await until(() => generated(watch)?.includes("[1, 1, 1]") === true);
      } finally {
        watch.close();
      }
    });

    test("follows a macro package installed after the watch began", async () => {
      const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "sweet-watch-")),
      );
      writeFileSync(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, target: "ES2022" },
          files: ["main.sts"],
        }),
      );
      writeFileSync(join(directory, "main.sts"), formsUser);
      let builds = 0;
      const watch = watchConfiguredProject({
        configPath: join(directory, "tsconfig.json"),
        writeThrough: false,
        debounceMilliseconds: 0,
        onResult: () => (builds += 1),
      });
      try {
        expect(watch.result.diagnostics).not.toEqual([]);
        await listening(directory, () => builds);
        writeFormsPackage(
          join(directory, "node_modules", "@acme", "forms"),
          "[$x, $x]",
        );
        await until(() => generated(watch)?.includes("[1, 1]") === true);
        expect(watch.result.diagnostics).toEqual([]);
      } finally {
        watch.close();
      }
    });

    test("keeps watching once a file it follows is deleted", async () => {
      const directory = realpathSync(project());
      let builds = 0;
      const watch = watchConfiguredProject({
        configPath: join(directory, "tsconfig.json"),
        writeThrough: false,
        debounceMilliseconds: 0,
        onResult: () => (builds += 1),
      });
      try {
        await listening(directory, () => builds);
        rmSync(join(directory, "macros.sts"));
        await until(() => watch.result.diagnostics.length > 0);
        writeFileSync(
          join(directory, "macros.sts"),
          "export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x, $x] } }",
        );
        await until(() => generated(watch)?.includes("[1, 1, 1]") === true);
        expect(builds).toBeGreaterThan(2);
      } finally {
        watch.close();
      }
    });
  },
);
