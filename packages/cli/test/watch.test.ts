import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { watchConfiguredProject } from "../src/index.js";

/**
 * What a watch follows, and how often it builds.
 *
 * The set of watched files was taken once, when the watch began. A file added
 * to the project afterwards, and a macro module a file newly imported, were
 * never watched -- editing either rebuilt nothing, and the build kept
 * reporting what it had found before. Nor was there any delay: an editor
 * writing one file in two steps, or a save across several files, started a
 * build for each write.
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
