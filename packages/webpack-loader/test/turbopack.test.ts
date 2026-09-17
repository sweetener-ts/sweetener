import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "@sweetener/compiler";

const execute = promisify(execFile);
const temporaryProjects = new Set<string>();

afterEach(() => {
  for (const directory of temporaryProjects)
    rmSync(directory, { recursive: true, force: true });
  temporaryProjects.clear();
});

test("Next builds Sweetener with the native loader under Turbopack", async () => {
  const repository = realpathSync(resolve("."));
  const root = realpathSync(
    mkdtempSync(join(resolve("packages/webpack-loader"), ".tmp-turbopack-")),
  );
  temporaryProjects.add(root);
  const app = join(root, "app");
  mkdirSync(app);
  const loader = resolve("packages/webpack-loader/dist/src/index.js");
  const config = join(root, "sweetener.json");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, scripts: { build: "next build" } }),
  );
  writeFileSync(
    join(root, "next.config.mjs"),
    `export default { turbopack: { root: ${JSON.stringify(repository)}, rules: { "*.sts": { loaders: [{ loader: ${JSON.stringify(loader)}, options: { configFile: ${JSON.stringify(config)} } }], as: "*.ts" } } } };\n`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        jsx: "preserve",
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        allowArbitraryExtensions: true,
        noEmit: true,
      },
      sweet: { sourceDeclarations: true },
      files: ["value.sts", "macros.sts"],
    }),
  );
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        jsx: "preserve",
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ES2022",
        allowArbitraryExtensions: true,
      },
      include: ["app/**/*.tsx"],
    }),
  );
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    join(root, "value.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const answer = twice(21);\n`,
  );
  writeFileSync(
    join(app, "page.tsx"),
    `import { answer } from "../value.sts";\nexport default function Page() { return <main>{answer.join(",")}</main>; }\n`,
  );
  expect(
    runConfiguredProjectCommand({ command: "check", configPath: config })
      .diagnostics,
  ).toEqual([]);

  const binary = resolve("packages/webpack-loader/node_modules/.bin/next");
  const result = await execute(binary, ["build"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  expect(result.stdout).toMatch(/Turbopack/u);
  expect(existsSync(join(root, ".next", "BUILD_ID"))).toBe(true);
});
