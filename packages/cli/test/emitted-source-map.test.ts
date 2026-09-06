import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceMapConsumer } from "@jridgewell/source-map";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * The maps a build writes to disk, read the way a debugger reads them.
 *
 * `source-map-fidelity.test.ts` covers the first stage — `.sts` to expanded
 * TypeScript — and that stage was always right. What nothing covered was the
 * map that actually ships. TypeScript emits its map against the virtual `.ts`
 * it was handed, so a build wrote `sources: ["../src/main.ts"]`: a file that
 * has never existed, at line and column positions belonging to a text nobody
 * has, with no `sourcesContent` to fall back on. The composition that fixes it
 * existed and was unit-tested, and no production path called it.
 */

function build(macros: string, main: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-emitted-map-"));
  writeFileSync(join(directory, "macros.sts"), macros, "utf8");
  writeFileSync(join(directory, "main.sts"), main, "utf8");
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        outDir: "dist",
        rootDir: ".",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
    "utf8",
  );
  const result = runConfiguredProjectCommand({
    command: "build",
    configPath: join(directory, "tsconfig.json"),
  });
  expect(
    result.diagnostics.map(({ messageText }) => messageText),
    "build reported diagnostics",
  ).toEqual([]);
  return {
    directory,
    read: (name: string) => readFileSync(join(directory, "dist", name), "utf8"),
  };
}

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { [$value, $value] }
}
`;

/** Where the given text in the generated output came from, one-based. */
function originOf(generated: string, map: SourceMapConsumer, needle: string) {
  const offset = generated.indexOf(needle);
  expect(offset, `${needle} is not in the generated output`).toBeGreaterThan(
    -1,
  );
  const before = generated.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1);
  return map.originalPositionFor({ line, column });
}

describe("the source map a build emits", () => {
  const main = `import { twice } from "./macros.sts" for syntax;

export const pair: readonly number[] = twice(21);

export function sum(values: readonly number[]): number {
  return values.reduce((total, next) => total + next, 0);
}
`;

  test("names the source the author wrote, and carries its text", () => {
    const { read } = build(macros, main);
    const map = JSON.parse(read("main.js.map")) as {
      sources: string[];
      sourcesContent?: (string | null)[];
    };
    expect(map.sources).toHaveLength(1);
    expect(map.sources[0]).toMatch(/main\.sts$/u);
    expect(map.sourcesContent?.[0]).toBe(main);
  });

  test("maps generated positions back to the .sts line they came from", () => {
    const { read } = build(macros, main);
    const generated = read("main.js");
    const map = new SourceMapConsumer(JSON.parse(read("main.js.map")) as never);

    // `export const pair` is the first line of the output and the third line
    // of the source: everything above it in the source is the compile-time
    // import and a blank line, neither of which survives.
    const pair = originOf(generated, map, "export const pair");
    expect(pair.source).toMatch(/main\.sts$/u);
    expect(pair.line).toBe(3);

    const sum = originOf(generated, map, "export function sum");
    expect(sum.source).toMatch(/main\.sts$/u);
    expect(sum.line).toBe(5);
  });

  test("composes the declaration map too", () => {
    const { read } = build(macros, main);
    const map = JSON.parse(read("main.d.ts.map")) as {
      sources: string[];
      sourcesContent?: (string | null)[];
    };
    expect(map.sources[0]).toMatch(/main\.sts$/u);
    expect(map.sourcesContent?.[0]).toBe(main);
  });
});
