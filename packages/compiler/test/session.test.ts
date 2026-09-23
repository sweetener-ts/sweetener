import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  createSweetenerSession,
  type DefaultProjectExpansionProvider,
} from "../src/index.js";

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

/**
 * A file may import one macro module twice: once plainly, and once
 * `for syntax shadows core` for a name that intercepts a core form. The
 * authorization comes from the import declaring the name, not the first import
 * naming the module; otherwise a plain import written above a shadowing one
 * silently cancels it -- `typeof NaN` keeps its built-in meaning, and which
 * import comes first decides the program's meaning.
 */
describe("core shadowing across several imports of one module", () => {
  function shadowProject(mainSource: string): {
    directory: string;
    config: string;
    main: string;
  } {
    const directory = mkdtempSync(join(tmpdir(), "sweet-shadow-"));
    writeFileSync(
      join(directory, "macros.sts"),
      [
        "export syntax keepit:expr { rule { keepit($v:expr) } => { [$v] } }",
        "export syntax typeof:expr shadows core {",
        "  literal globalThis.NaN as NaN;",
        '  rule { typeof NaN } => { "NaN" }',
        "  fallback rule { typeof $value:expr } => { #core(typeof $value) }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(join(directory, "main.sts"), mainSource);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts"],
      }),
    );
    return {
      directory,
      config: join(directory, "tsconfig.json"),
      main: join(directory, "main.sts"),
    };
  }

  test.each([
    [
      "a plain import written first",
      'import { keepit } from "./macros.sts" for syntax;\nimport { typeof } from "./macros.sts" for syntax shadows core;\nexport const kind = typeof NaN;\nexport const kept = keepit(1);\n',
    ],
    [
      "a plain import written second",
      'import { typeof } from "./macros.sts" for syntax shadows core;\nimport { keepit } from "./macros.sts" for syntax;\nexport const kind = typeof NaN;\nexport const kept = keepit(1);\n',
    ],
    [
      "one import naming both",
      'import { keepit, typeof } from "./macros.sts" for syntax shadows core;\nexport const kind = typeof NaN;\nexport const kept = keepit(1);\n',
    ],
  ])("intercepts the core form with %s", async (_, mainSource) => {
    const fixture = shadowProject(mainSource);
    const session = createSweetenerSession();
    const result = await session.transform({
      code: mainSource,
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain('"NaN"');
    expect(result.code).toContain("[1]");
    await session.close();
  });

  test("still leaves the core form alone without the shadowing import", async () => {
    const mainSource =
      'import { keepit } from "./macros.sts" for syntax;\nexport const kind = typeof NaN;\nexport const kept = keepit(1);\n';
    const fixture = shadowProject(mainSource);
    const session = createSweetenerSession();
    const result = await session.transform({
      code: mainSource,
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.code).not.toContain('"NaN"');
    expect(result.code).toContain("typeof NaN");
    await session.close();
  });
});

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

  test("expands the project once when several files are transformed", async () => {
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    writeFileSync(
      other,
      `import { duplicate } from "./macros.sts" for syntax;\nexport const other = duplicate(7);\n`,
    );
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    const inner = createDefaultProjectExpansionProvider();
    let expansions = 0;
    const counting = new Proxy(inner, {
      get(target, property) {
        if (property === "expandProject")
          return (
            project: Parameters<
              DefaultProjectExpansionProvider["expandProject"]
            >[0],
          ) => {
            expansions += 1;
            return target.expandProject(project);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = createSweetenerSession({ provider: counting });
    const main = await session.transform({
      code: readFile(fixture.main),
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    const second = await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    const mainAgain = await session.transform({
      code: readFile(fixture.main),
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });

    expect(expansions).toBe(1);
    expect(main.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(main.code).toContain("[21, 21]");
    expect(second.code).toContain("[7, 7]");
    expect(mainAgain).toBe(main);

    writeFileSync(
      fixture.macros,
      `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, $value, $value] } }\n`,
    );
    const rebuilt = await session.transform({
      code: readFile(fixture.main),
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(2);
    expect(rebuilt.code).toContain("[21, 21, 21]");
    const otherAfter = await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(2);
    expect(otherAfter.code).toContain("[7, 7, 7]");
    await session.close();
  });

  test("re-expands after an extended config changes", async () => {
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    const base = join(fixture.directory, "base.json");
    writeFileSync(other, readFile(fixture.main));
    writeFileSync(
      base,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
      }),
    );
    writeFileSync(
      fixture.config,
      JSON.stringify({
        extends: "./base.json",
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    const inner = createDefaultProjectExpansionProvider();
    let expansions = 0;
    const provider = new Proxy(inner, {
      get(target, property) {
        if (property === "expandProject")
          return (...args: Parameters<typeof inner.expandProject>) => {
            expansions += 1;
            return target.expandProject(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = createSweetenerSession({ provider });
    await session.transform({
      code: readFile(fixture.main),
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(1);

    session.invalidate([base]);
    await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(2);

    writeFileSync(
      base,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2020" },
      }),
    );
    const afterConfigChange = await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(3);
    expect(afterConfigChange.diagnostics).toEqual([]);
    await session.close();
  });

  test("re-expands after package metadata changes", async () => {
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    const packageRoot = join(
      fixture.directory,
      "node_modules",
      "@acme",
      "forms",
    );
    const packageJson = join(packageRoot, "package.json");
    const manifest = join(packageRoot, "sweet-macros.json");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(other, readFile(fixture.main));
    writeFileSync(
      packageJson,
      JSON.stringify({
        name: "@acme/forms",
        version: "1.0.0",
        sweetMacros: "./sweet-macros.json",
      }),
    );
    writeFileSync(
      manifest,
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
    writeFileSync(
      join(packageRoot, "macros.sts"),
      `export const metadata = "macro package entry";\n`,
    );
    writeFileSync(
      join(packageRoot, "forms.sts"),
      `export syntax packaged:expr { rule { packaged($value:tt) } => { [$value, $value] } }\n`,
    );
    writeFileSync(
      join(packageRoot, "forms2.sts"),
      `export syntax packaged:expr { rule { packaged($value:tt) } => { [$value, $value, $value] } }\n`,
    );
    const source = `import { packaged } from "@acme/forms" for syntax;\nexport const answer = packaged(21);\n`;
    writeFileSync(fixture.main, source);
    writeFileSync(other, source.replace("21", "7"));
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["main.sts", "other.sts"],
      }),
    );
    const inner = createDefaultProjectExpansionProvider();
    let expansions = 0;
    const provider = new Proxy(inner, {
      get(target, property) {
        if (property === "expandProject")
          return (...args: Parameters<typeof inner.expandProject>) => {
            expansions += 1;
            return target.expandProject(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = createSweetenerSession({ provider });
    const first = await session.transform({
      code: source,
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(1);
    expect(first.code).toContain("[21, 21]");

    session.invalidate([packageJson]);
    await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(2);

    writeFileSync(
      packageJson,
      JSON.stringify({
        name: "@acme/forms",
        version: "2.0.0",
        sweetMacros: "./sweet-macros.json",
      }),
    );
    await session.transform({
      code: readFile(other),
      filename: other,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(3);

    writeFileSync(
      manifest,
      JSON.stringify({
        formatVersion: 1,
        name: "@acme/forms",
        languageVersion: "1",
        compiler: { minimum: "0.1.0", maximum: "0.9.x" },
        entry: "./macros.sts",
        exports: {
          packaged: { source: "./forms2.sts", category: "expr", phase: 1 },
        },
        dependencies: [],
      }),
    );
    const afterManifestChange = await session.transform({
      code: source,
      filename: fixture.main,
      configFile: fixture.config,
      mode: "test",
    });
    expect(expansions).toBe(4);
    expect(afterManifestChange.code).toContain("[21, 21, 21]");
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
    // own bundled config directory, so an adapter can reach this with a path
    // that does not exist, and must not report the .sts as merely not opted in.
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
  // The public surface says a partial or failed result must not be cached,
  // and this is the cache the pipeline has. A remembered failure outlives the
  // reason for it — fix the macro and the old diagnostics come back.
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

/**
 * A build tool expands and runs; nothing on that path resolves names. So the
 * sentence expansion holds about a name it left standing has nowhere else to
 * go: dropped here, `node --import @sweetener/node/register ./main.sts` loaded
 * a module whose first line is a `ReferenceError` and said nothing about why.
 *
 * It is a warning rather than an error because the claim it cannot make -- that
 * nothing else defines the name -- is the one that would justify refusing to
 * expand, and a macro spelled like a global leaves that global standing.
 */
test("says what it knows about a name it left standing", async () => {
  const fixture = project();
  writeFileSync(
    fixture.main,
    `import { duplicate } from "./macros.sts" for syntax;\nexport const held = duplicate;\n`,
    "utf8",
  );
  const session = createSweetenerSession();
  const result = await session.transform({
    code: readFile(fixture.main),
    filename: fixture.main,
    configFile: fixture.config,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.warnings.map(({ code, category }) => [code, category])).toEqual(
    [[4024, ts.DiagnosticCategory.Warning]],
  );
  expect(result.code).toContain("held = duplicate");
  await session.close();
});
