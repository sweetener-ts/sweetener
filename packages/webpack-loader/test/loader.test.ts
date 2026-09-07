import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import rspack, { type Stats as RspackStats } from "@rspack/core";
import webpack from "webpack";
import { describe, expect, test } from "vitest";

function fixture(host: string) {
  const root = mkdtempSync(join(tmpdir(), `sweet-loader-${host}-`));
  const entry = join(root, "main.sts");
  const config = join(root, "tsconfig.json");
  writeFileSync(
    join(root, "macros.sts"),
    `export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }\n`,
  );
  writeFileSync(
    entry,
    `import { twice } from "./macros.sts" for syntax;\nexport const answer = twice(21);\n`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext" },
      files: ["main.sts", "macros.sts"],
    }),
  );
  return { root, entry, config };
}

const loader = resolve("packages/webpack-loader/dist/src/index.js");

describe("native webpack loader", () => {
  test("runs in webpack with maps and dependency tracking", async () => {
    const project = fixture("webpack");
    const output = join(project.root, "dist");
    const compiler = webpack({
      mode: "development",
      devtool: "source-map",
      entry: project.entry,
      output: { path: output, filename: "bundle.js" },
      module: {
        rules: [
          {
            test: /\.sts$/u,
            use: [{ loader, options: { configFile: project.config } }],
          },
        ],
      },
    });
    const stats = await new Promise<webpack.Stats>((resolveStats, reject) =>
      compiler.run((error, result) =>
        error != null
          ? reject(error)
          : result === undefined
            ? reject(new Error("No stats"))
            : resolveStats(result),
      ),
    );
    await new Promise<void>((done, reject) =>
      compiler.close((error) => (error == null ? done() : reject(error))),
    );
    expect(stats.hasErrors(), stats.toString({ errors: true })).toBe(false);
    expect(readFileSync(join(output, "bundle.js"), "utf8")).toContain("21, 21");
    expect(readFileSync(join(output, "bundle.js.map"), "utf8")).toContain(
      "main.sts",
    );
  });

  test("runs unchanged in Rspack", async () => {
    const project = fixture("rspack");
    const output = join(project.root, "dist");
    const compiler = rspack({
      mode: "development",
      entry: project.entry,
      output: { path: output, filename: "bundle.js" },
      module: {
        rules: [
          {
            test: /\.sts$/u,
            use: [{ loader, options: { configFile: project.config } }],
          },
        ],
      },
    });
    const stats = await new Promise<RspackStats>((resolveStats, reject) =>
      compiler.run((error, result) =>
        error != null
          ? reject(error)
          : result === undefined
            ? reject(new Error("No stats"))
            : resolveStats(result),
      ),
    );
    await new Promise<void>((done, reject) =>
      compiler.close((error) => (error == null ? done() : reject(error))),
    );
    expect(stats.hasErrors(), stats.toString({ errors: true })).toBe(false);
    expect(readFileSync(join(output, "bundle.js"), "utf8")).toContain("21, 21");
  });
});

test("reports a macro failure to webpack instead of taking the process down", async () => {
  // The loader used to throw from inside a `.then` success branch, so the
  // error escaped as an unhandled rejection and the callback was never
  // called. Under `webpack --watch` that kills the dev server rather than
  // printing a compile error.
  const directory = mkdtempSync(join(tmpdir(), "sweet-loader-fail-"));
  writeFileSync(
    join(directory, "macros.sts"),
    `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value, $value] }\n}\n`,
    "utf8",
  );
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice } from "./macros.sts" for syntax;\nexport const broken = twice(1, 2, 3);\n`,
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
      files: ["macros.sts", "main.sts"],
    }),
    "utf8",
  );

  const reported = await new Promise<Error | null>((resolve) => {
    const context = {
      resourcePath: join(directory, "main.sts"),
      mode: "development",
      addDependency: () => {},
      getOptions: () => ({}),
      async: () => (error: Error | null) => resolve(error),
    };
    void import(pathToFileURL(loader).href).then(
      ({
        default: run,
      }: {
        default: (this: unknown, source: string) => void;
      }) =>
        run.call(context, readFileSync(join(directory, "main.sts"), "utf8")),
    );
  });

  expect(reported).toBeInstanceOf(Error);
  expect(reported?.message).toContain("No rule for macro twice");
  // And with the position, as the command line reports it.
  expect(reported?.message).toMatch(/main\.sts:2:\d+/u);
});
