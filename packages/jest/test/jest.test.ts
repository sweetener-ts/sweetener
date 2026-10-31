import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import type * as Compiler from "@sweetener/compiler";
import transformer from "../src/index.js";

const execute = promisify(execFile);

test("Jest executes .sts through its real async transformer API", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-jest-"));
  const config = join(root, "sweetener.json");
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(root, "value.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const answer: number[] = twice(21);\n`,
  );
  writeFileSync(
    join(root, "value.test.mjs"),
    `import { answer } from "./value.sts";\ntest("expanded", () => expect(answer).toEqual([21, 21]));\n`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["value.sts", "macros.sts"],
    }),
  );
  const transformer = resolve("packages/jest/dist/src/index.js");
  const jestConfig = join(root, "jest.config.mjs");
  writeFileSync(
    jestConfig,
    `export default { rootDir: ${JSON.stringify(root)}, testEnvironment: "node", testMatch: ["**/*.test.mjs"], extensionsToTreatAsEsm: [".sts"], transform: { "\\.sts$": [${JSON.stringify(transformer)}, { configFile: ${JSON.stringify(config)} }] } };\n`,
  );
  const binary = resolve("packages/jest/node_modules/jest/bin/jest.js");
  const result = await execute(
    process.execPath,
    [
      "--experimental-vm-modules",
      binary,
      "--runInBand",
      "--config",
      jestConfig,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 60_000,
    },
  );
  expect(result.stderr).toMatch(/1 passed/u);
});

test("re-expands after a macro changes, with no configFile given", async () => {
  // The cache key has to hash the macros whether or not a configFile is
  // passed. Otherwise a project without one keeps serving an expansion from
  // before its macros were edited — and keeps passing tests that should fail.
  const directory = mkdtempSync(join(tmpdir(), "sweet-jest-stale-"));
  const macros = join(directory, "macros.sts");
  writeFileSync(
    macros,
    `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value] }\n}\n`,
    "utf8",
  );
  const main = join(directory, "value.sts");
  writeFileSync(
    main,
    `import { twice } from "./macros.sts" for syntax;\nexport const answer = twice(21);\n`,
    "utf8",
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "value.sts"],
    }),
    "utf8",
  );

  const options = {
    config: { rootDir: directory },
    transformerConfig: {},
  };
  const source = readFileSync(main, "utf8");
  const before = await transformer.getCacheKeyAsync(source, main, options);

  writeFileSync(
    macros,
    `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value, $value] }\n}\n`,
    "utf8",
  );
  const after = await transformer.getCacheKeyAsync(source, main, options);

  // The file itself did not change; the macros it expands through did.
  expect(after).not.toBe(before);
});

test("re-expands after a macro an installed package exports changes", async () => {
  // The config lists only the file; the macro module is read from the
  // package, which no list names.
  const directory = mkdtempSync(join(tmpdir(), "sweet-jest-package-"));
  const pkg = join(directory, "node_modules", "@acme", "forms");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@acme/forms",
      version: "1.0.0",
      sweetMacros: "./sweet-macros.json",
    }),
  );
  writeFileSync(
    join(pkg, "sweet-macros.json"),
    JSON.stringify({
      formatVersion: 1,
      name: "@acme/forms",
      languageVersion: "1",
      compiler: { minimum: "0.1.0", maximum: "0.9.x" },
      entry: "./macros.sts",
      exports: {
        packaged: { source: "./forms.sts", category: "expr", phase: 1 },
      },
      dependencies: [],
    }),
  );
  writeFileSync(join(pkg, "macros.sts"), 'export const metadata = "x";\n');
  const rule = (template: string): void =>
    writeFileSync(
      join(pkg, "forms.sts"),
      `export syntax packaged:expr { rule { packaged($value:tt) } => { ${template} } }\n`,
    );
  rule("[$value, $value]");
  const main = join(directory, "main.sts");
  writeFileSync(
    main,
    'import { packaged } from "@acme/forms" for syntax;\nexport const answer = packaged(1);\n',
  );
  const configFile = join(directory, "tsconfig.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022" },
      files: ["main.sts"],
    }),
  );
  const options = {
    config: { rootDir: directory },
    transformerConfig: { configFile },
  };
  const source = readFileSync(main, "utf8");
  const before = await transformer.getCacheKeyAsync(source, main, options);
  rule("[$value, $value, $value]");
  const after = await transformer.getCacheKeyAsync(source, main, options);
  expect(after).not.toBe(before);
  const { code } = await transformer.processAsync(source, main, options);
  expect(code).toContain("[1, 1, 1]");
});

/**
 * A worker that finds what a file's last expansion read in Jest's cache keys
 * the file from that, without expanding it: expanded to answer every key, a
 * warm run expanded the whole project in each worker before Jest served a
 * cached transform. The record is still checked against the files it names,
 * so a macro no list names changing changes the key all the same.
 */
test("keys a file from what its last expansion read, in a worker that has not expanded it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sweet-jest-record-"));
  const pkg = join(directory, "node_modules", "@acme", "forms");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@acme/forms",
      version: "1.0.0",
      sweetMacros: "./sweet-macros.json",
    }),
  );
  writeFileSync(
    join(pkg, "sweet-macros.json"),
    JSON.stringify({
      formatVersion: 1,
      name: "@acme/forms",
      languageVersion: "1",
      compiler: { minimum: "0.1.0", maximum: "0.9.x" },
      entry: "./macros.sts",
      exports: {
        packaged: { source: "./forms.sts", category: "expr", phase: 1 },
      },
      dependencies: [],
    }),
  );
  writeFileSync(join(pkg, "macros.sts"), 'export const metadata = "x";\n');
  const rule = (template: string): void =>
    writeFileSync(
      join(pkg, "forms.sts"),
      `export syntax packaged:expr { rule { packaged($value:tt) } => { ${template} } }\n`,
    );
  rule("[$value, $value]");
  const main = join(directory, "main.sts");
  writeFileSync(
    main,
    'import { packaged } from "@acme/forms" for syntax;\nexport const answer = packaged(1);\n',
  );
  const configFile = join(directory, "tsconfig.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022" },
      files: ["main.sts"],
    }),
  );
  const options = {
    config: { rootDir: directory, cacheDirectory: join(directory, "cache") },
    transformerConfig: { configFile },
  };
  const source = readFileSync(main, "utf8");
  const first = await transformer.getCacheKeyAsync(source, main, options);

  // Another worker: the module loaded afresh, with no session of its own,
  // counting what its sessions are asked to expand.
  let expansions = 0;
  vi.resetModules();
  vi.doMock("@sweetener/compiler", async (original) => {
    const compiler = await original<typeof Compiler>();
    return {
      ...compiler,
      createSweetenerSession: () => {
        const session = compiler.createSweetenerSession();
        return {
          ...session,
          transform: (request: Parameters<typeof session.transform>[0]) => {
            expansions += 1;
            return session.transform(request);
          },
        };
      },
    };
  });
  try {
    const { default: worker } = await import("../src/index.js");
    expect(await worker.getCacheKeyAsync(source, main, options)).toBe(first);
    expect(expansions).toBe(0);

    rule("[$value, $value, $value]");
    const changed = await worker.getCacheKeyAsync(source, main, options);
    expect(changed).not.toBe(first);
    expect(expansions).toBe(0);
    const { code } = await worker.processAsync(source, main, options);
    expect(code).toContain("[1, 1, 1]");
  } finally {
    vi.doUnmock("@sweetener/compiler");
    vi.resetModules();
  }
});

/**
 * Jest has to be able to find this by name.
 *
 * `transform: { "\\.sts$": ["@sweetener/jest", {}] }` is the configuration
 * anyone would write. Jest resolves a transformer under conditions that need
 * `require` or `default`, so an exports map offering only `types` and `import`
 * fails with `Module @sweetener/jest in the transform option was not found`.
 * Pointing at `dist/src/index.js` by absolute path would never ask the
 * question a user's config asks, so this resolves the package by name.
 */
test("Jest resolves the transformer by package name", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-jest-named-"));
  const scope = join(root, "node_modules", "@sweetener");
  mkdirSync(scope, { recursive: true });
  symlinkSync(resolve("packages/jest"), join(scope, "jest"), "dir");
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(root, "value.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const answer: number[] = twice(21);\n`,
  );
  writeFileSync(
    join(root, "value.test.mjs"),
    `import { answer } from "./value.sts";\ntest("expanded", () => expect(answer).toEqual([21, 21]));\n`,
  );
  const config = join(root, "sweetener.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["value.sts", "macros.sts"],
    }),
  );
  writeFileSync(
    join(root, "jest.config.mjs"),
    `export default { rootDir: ${JSON.stringify(root)}, testEnvironment: "node", testMatch: ["**/*.test.mjs"], extensionsToTreatAsEsm: [".sts"], transform: { "\\.sts$": ["@sweetener/jest", { configFile: ${JSON.stringify(config)} }] } };\n`,
  );
  const result = await execute(
    process.execPath,
    [
      "--experimental-vm-modules",
      resolve("packages/jest/node_modules/jest/bin/jest.js"),
      "--runInBand",
      "--watchman=false",
      "--config",
      join(root, "jest.config.mjs"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 60_000,
    },
  );
  expect(result.stderr).toMatch(/1 passed/u);
});

/**
 * What expansion holds about a name it left standing is said whenever a test
 * loads the module -- including on a run that takes the transform from Jest's
 * cache, which never calls the transformer at all. Said once while
 * transforming, it was said on the first run and never again.
 */
test("says what it holds about a name on every run, cached or not", async () => {
  const root = mkdtempSync(join(tmpdir(), "sweet-jest-held-"));
  const config = join(root, "sweetener.json");
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(root, "value.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const kind = typeof twice;\n`,
  );
  writeFileSync(
    join(root, "value.test.mjs"),
    `import { kind } from "./value.sts";\ntest("loaded", () => expect(kind).toBe("undefined"));\n`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["value.sts", "macros.sts"],
    }),
  );
  const transformer = resolve("packages/jest/dist/src/index.js");
  const jestConfig = join(root, "jest.config.mjs");
  writeFileSync(
    jestConfig,
    `export default { rootDir: ${JSON.stringify(root)}, cacheDirectory: ${JSON.stringify(join(root, "cache"))}, testEnvironment: "node", testMatch: ["**/*.test.mjs"], extensionsToTreatAsEsm: [".sts"], transform: { "\\.sts$": [${JSON.stringify(transformer)}, { configFile: ${JSON.stringify(config)} }] } };\n`,
  );
  const binary = resolve("packages/jest/node_modules/jest/bin/jest.js");
  const run = () =>
    execute(
      process.execPath,
      [
        "--experimental-vm-modules",
        binary,
        "--runInBand",
        "--config",
        jestConfig,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        timeout: 60_000,
      },
    );
  // Jest prints what a test's modules write to the console on stdout, and its
  // own summary on stderr.
  const first = await run();
  expect(first.stderr).toMatch(/1 passed/u);
  expect(first.stdout).toContain("warning SWR4024");
  const cached = await run();
  expect(cached.stderr).toMatch(/1 passed/u);
  expect(cached.stdout).toContain("warning SWR4024");
});
