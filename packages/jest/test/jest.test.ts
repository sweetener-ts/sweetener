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
import { expect, test } from "vitest";
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
  // The cache key hashed the macros only when a configFile was passed, so a
  // project without one kept serving an expansion from before its macros were
  // edited — and kept passing tests that should have changed.
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

/**
 * Jest has to be able to find this by name.
 *
 * `transform: { "\\.sts$": ["@sweetener/jest", {}] }` — the configuration
 * anyone would write — failed with `Module @sweetener/jest in the transform
 * option was not found`, because the exports map offered only `types` and
 * `import` and Jest resolves a transformer under conditions that need
 * `require` or `default`. The suite pointed at `dist/src/index.js` by absolute
 * path, so it never asked the question a user's config asks.
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
