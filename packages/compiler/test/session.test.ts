import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createSweetenerSession } from "../src/index.js";

function project(): {
  directory: string;
  config: string;
  main: string;
  macros: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-"));
  const macros = join(directory, "macros.sts");
  const main = join(directory, "main.sts");
  const config = join(directory, "tsconfig.json");
  writeFileSync(
    macros,
    `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, $value] } }\n`,
  );
  writeFileSync(
    main,
    `import { duplicate } from "./macros.sts" for syntax;\nexport const answer = duplicate(21);\n`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022" },
      files: ["macros.sts", "main.sts"],
    }),
  );
  return { directory, config, main, macros };
}

describe("public compiler session", () => {
  test("expands a project file and reports its complete watch set", async () => {
    const fixture = project();
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(fixture.main, "utf8"),
    );
    const session = createSweetenerSession();
    const result = await session.transform({
      code: source,
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("[21, 21]");
    expect(result.virtualFilename).toMatch(/main\.ts$/u);
    expect(result.dependencies).toEqual(
      [fixture.config, fixture.macros, fixture.main]
        .map((fileName) => realpathSync(fileName))
        .sort(),
    );
    expect(result.originMap.entries.length).toBeGreaterThan(0);
    expect(result.map.version).toBe(3);
    expect(result.map.mappings.length).toBeGreaterThan(0);
    expect(result.map.sources).toContain(realpathSync(fixture.main));
    expect(result.map.sourcesContent).toContain(source);
    expect(Array.isArray(result.trace)).toBe(true);
    await session.close();
  });

  test("caches stable transforms and invalidates macro dependents", async () => {
    const fixture = project();
    const source = readFile(fixture.main);
    const session = createSweetenerSession();
    const first = await session.transform({
      code: source,
      filename: fixture.main,
    });
    const cached = await session.transform({
      code: source,
      filename: fixture.main,
    });
    expect(cached).toBe(first);

    session.invalidate([fixture.macros]);
    const rebuilt = await session.transform({
      code: source,
      filename: fixture.main,
    });
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.code).toBe(first.code);
    await session.close();
  });

  test("rejects stale build-tool input and use after close", async () => {
    const fixture = project();
    const session = createSweetenerSession();
    await expect(
      session.transform({ code: "stale", filename: fixture.main }),
    ).rejects.toThrow(/changed before expansion/u);
    await session.close();
    await expect(
      session.transform({
        code: readFile(fixture.main),
        filename: fixture.main,
      }),
    ).rejects.toThrow(/closed/u);
  });

  test("names the config a build tool could not read, not the source", async () => {
    // A configFile that is not there parses as an empty project, in which every
    // file looks merely unlisted. Farm resolves a relative config against its
    // own bundled config directory, so an adapter reached this with a path that
    // did not exist and reported the .sts as not opted in.
    const fixture = project();
    const session = createSweetenerSession();
    await expect(
      session.transform({
        code: readFile(fixture.main),
        filename: fixture.main,
        configFile: join(fixture.directory, "nowhere", "sweetener.json"),
      }),
    ).rejects.toThrow(/nowhere.*Cannot read file/su);

    // The file really being left out still says so, and says where to add it.
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts"],
      }),
    );
    await expect(
      session.transform({
        code: readFile(fixture.main),
        filename: fixture.main,
        configFile: fixture.config,
      }),
    ).rejects.toThrow(
      /is not opted into Sweetener expansion by .*tsconfig\.json/u,
    );
    await session.close();
  });

  test("preserves constructor calls captured by a statement macro", async () => {
    const fixture = project();
    writeFileSync(
      fixture.macros,
      `export syntax unless:stmt { rule { unless($condition:expr) $body:stmt } => { if (!($condition)) $body } }\n`,
    );
    writeFileSync(
      fixture.main,
      `import { unless } from "./macros.sts" for syntax;\nexport function check(ok: boolean) { unless(ok) { throw new Error("nope"); } }\n`,
    );
    const session = createSweetenerSession();
    const result = await session.transform({
      code: readFile(fixture.main),
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('new Error("nope")');
    expect(result.code).not.toContain("new( Error");
    await session.close();
  });
});

function readFile(fileName: string): string {
  return readFileSync(fileName, "utf8");
}

test("does not cache an expansion that failed", async () => {
  // The public surface says a partial or failed result must not be cached.
  // That was stated of a class this pipeline does not use; this is the cache
  // it has. A remembered failure outlives the reason for it — fix the macro
  // and the old diagnostics come back.
  const fixture = project();
  const macros = fixture.main.replace("main.sts", "macros.sts");
  writeFileSync(
    macros,
    `export syntax twice:expr {\n  rule { twice($value:expr) } => { [$value] }\n}\n`,
    "utf8",
  );
  writeFileSync(
    fixture.main,
    `import { twice } from "./macros.sts" for syntax;\nexport const broken = twice(1, 2, 3);\n`,
    "utf8",
  );
  const session = createSweetenerSession();
  const failed = await session.transform({
    code: readFile(fixture.main),
    filename: fixture.main,
  });
  expect(failed.diagnostics.length).toBeGreaterThan(0);

  // Repair the macro so the same source now expands.
  writeFileSync(
    macros,
    `export syntax twice:expr {\n  rule { twice($($value:expr),*) } => { [$($value),*] }\n}\n`,
    "utf8",
  );
  const repaired = await session.transform({
    code: readFile(fixture.main),
    filename: fixture.main,
  });
  expect(repaired.diagnostics).toEqual([]);
  await session.close();
});
