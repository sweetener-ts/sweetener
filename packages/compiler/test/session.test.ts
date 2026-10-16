import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import * as ts from "typescript";
import { describe, expect, test, vi } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  createSweetenerSession,
  type DefaultProjectExpansionProvider,
  type ExpansionFileSystem,
  type LoadedSweetProject,
  type SweetenerSession,
  type SweetenerTransformResult,
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

  test("expands a source its config reaches through a linked directory", async () => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), "sweet-linked-")),
    );
    const elsewhere = join(directory, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(directory, "project", "src"), { recursive: true });
    writeFileSync(
      join(elsewhere, "macros.sts"),
      `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, $value] } }\n`,
    );
    const source = `import { duplicate } from "./macros.sts" for syntax;\nexport const answer = duplicate(21);\n`;
    writeFileSync(join(elsewhere, "main.sts"), source);
    symlinkSync(elsewhere, join(directory, "project", "src", "linked"));
    const config = join(directory, "project", "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["src"],
      }),
    );
    const session = createSweetenerSession();
    // A host may name the source by the link, as the config lists it, or by
    // where the link leads, as a bundler that resolves links does.
    for (const filename of [
      join(directory, "project", "src", "linked", "main.sts"),
      join(elsewhere, "main.sts"),
    ]) {
      const result = await session.transform({
        code: source,
        filename,
        configFile: config,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.code).toContain("[21, 21]");
    }
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
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const main = await transform(session, fixture.main, fixture.config);
    const second = await transform(session, other, fixture.config);
    const mainAgain = await transform(session, fixture.main, fixture.config);

    expect(counting.expansions()).toBe(1);
    expect(main.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(main.code).toContain("[21, 21]");
    expect(second.code).toContain("[7, 7]");
    expect(mainAgain).toBe(main);

    writeFileSync(
      fixture.macros,
      `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, $value, $value] } }\n`,
    );
    const rebuilt = await transform(session, fixture.main, fixture.config);
    expect(counting.expansions()).toBe(2);
    expect(rebuilt.code).toContain("[21, 21, 21]");
    const otherAfter = await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(2);
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
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const first = await transform(session, fixture.main, fixture.config);
    await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(1);
    expect(first.dependencies).toContain(realpathSync(base));

    session.invalidate([base]);
    await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(2);

    writeFileSync(
      base,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2020" },
      }),
    );
    const afterConfigChange = await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(3);
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
    writeFormsPackage(packageRoot);
    writeFileSync(
      join(packageRoot, "forms2.sts"),
      `export syntax packaged:expr { rule { packaged($value:tt) } => { [$value, $value, $value] } }\n`,
    );
    writeFileSync(fixture.main, formsSource(21));
    writeFileSync(other, formsSource(7));
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["main.sts", "other.sts"],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const first = await transform(session, fixture.main, fixture.config);
    await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(1);
    expect(first.code).toContain("[21, 21]");

    const packageJson = join(packageRoot, "package.json");
    session.invalidate([packageJson]);
    await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(2);

    writeFileSync(
      packageJson,
      JSON.stringify({
        name: "@acme/forms",
        version: "2.0.0",
        sweetMacros: "./sweet-macros.json",
      }),
    );
    await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(3);

    writeFileSync(
      join(packageRoot, "sweet-macros.json"),
      formsManifest("./forms2.sts"),
    );
    const afterManifestChange = await transform(
      session,
      fixture.main,
      fixture.config,
    );
    expect(counting.expansions()).toBe(4);
    expect(afterManifestChange.code).toContain("[21, 21, 21]");
    await session.close();
  });

  test("answers a file as a fresh session does once another joins the project", async () => {
    const fixture = project();
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["*.sts"],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    await transform(session, fixture.main, fixture.config);

    const added = join(fixture.directory, "added.sts");
    writeFileSync(
      added,
      `import { dup } from "./missing.sts" for syntax;\nexport const added = 1;\n`,
    );
    // The new file's mistake is its own: this file still expands as it did,
    // which is what a session that never saw the project without it says.
    const again = await transform(session, fixture.main, fixture.config);
    expect(counting.expansions()).toBe(1);
    expect(answer(again)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );

    const joined = await transform(session, added, fixture.config);
    expect(counting.expansions()).toBe(2);
    expect(String(joined.diagnostics[0]?.messageText)).toContain(
      "Cannot resolve macro module ./missing.sts",
    );
    expect(answer(joined)).toEqual(
      answer(await freshly(added, fixture.config)),
    );
    await session.close();
  });

  test("answers a file as a fresh session does once another leaves the project", async () => {
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    const leaving = join(fixture.directory, "leaving.sts");
    writeFileSync(other, readFile(fixture.main).replace("21", "7"));
    writeFileSync(leaving, readFile(fixture.main).replace("21", "3"));
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["*.sts"],
      }),
    );
    const session = createSweetenerSession();
    await transform(session, fixture.main, fixture.config);

    rmSync(leaving);
    expect(
      answer(await transform(session, fixture.main, fixture.config)),
    ).toEqual(answer(await freshly(fixture.main, fixture.config)));

    // Left out by the config while it is still on disk.
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts"],
      }),
    );
    expect(
      answer(await transform(session, fixture.main, fixture.config)),
    ).toEqual(answer(await freshly(fixture.main, fixture.config)));
    await expect(transform(session, other, fixture.config)).rejects.toThrow(
      /is not opted into Sweetener expansion/u,
    );
    await session.close();
  });

  test("reports a file's mistake for that file, and keeps the others", async () => {
    const fixture = project();
    const broken = join(fixture.directory, "broken.sts");
    writeFileSync(
      broken,
      `import { duplicate } from "./macros.sts" for syntax;\nexport const broken = duplicate(1, 2);\n`,
    );
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "broken.sts"],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const main = await transform(session, fixture.main, fixture.config);
    expect(main.diagnostics).toEqual([]);
    expect(main.code).toContain("[21, 21]");

    const failed = await transform(session, broken, fixture.config);
    expect(failed.diagnostics.length).toBeGreaterThan(0);
    expect(answer(failed)).toEqual(
      answer(await freshly(broken, fixture.config)),
    );
    // Expanding again for the failed file made this one's anew, so it is
    // answered from that without another expansion.
    const expansions = counting.expansions();
    const mainAgain = await transform(session, fixture.main, fixture.config);
    expect(counting.expansions()).toBe(expansions);
    expect(answer(mainAgain)).toEqual(answer(main));
    await session.close();
  });

  test("reports a package manifest's mistakes to the file importing it", async () => {
    const fixture = formsProject();
    writeFormsPackage(fixture.packageRoot);
    writeFileSync(
      join(fixture.packageRoot, "sweet-macros.json"),
      JSON.stringify({
        ...JSON.parse(formsManifest("./forms.sts")),
        formatVersion: 99,
      }),
    );
    // The manifest is not a source, so what is wrong with it points at no
    // file; it belongs to the import that read it.
    const session = createSweetenerSession();
    const result = await transform(session, fixture.main, fixture.config);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([5001, 5002]);
    expect(String(result.diagnostics[0]?.messageText)).toContain(
      "Invalid macro manifest",
    );
    await session.close();
  });

  test("expands again when a file joins a project whose macros name binding literals", async () => {
    // TypeScript resolves a binding literal over every source in the project,
    // so there each file's expansion depends on which files there are.
    const fixture = project();
    writeFileSync(
      fixture.macros,
      [
        "export syntax typeof:expr shadows core {",
        "  literal globalThis.NaN as NaN;",
        '  rule { typeof NaN } => { "NaN" }',
        "  fallback rule { typeof $value:expr } => { #core(typeof $value) }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      fixture.main,
      'import { typeof } from "./macros.sts" for syntax shadows core;\nexport const kind = typeof NaN;\n',
    );
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["*.sts"],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const first = await transform(session, fixture.main, fixture.config);
    expect(first.code).toContain('"NaN"');
    expect(await transform(session, fixture.main, fixture.config)).toBe(first);
    expect(counting.expansions()).toBe(1);

    writeFileSync(
      join(fixture.directory, "added.sts"),
      "export const added = 1;\n",
    );
    const again = await transform(session, fixture.main, fixture.config);
    expect(counting.expansions()).toBe(2);
    expect(answer(again)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );
    await session.close();
  });

  test("serves each source its own output, whatever its name shares with another", async () => {
    // `a.sts` and `a.stsx` expand to `a.ts` and `a.tsx`, and a file
    // opted in with a directive keeps its own name: matching sources to
    // output by name with the extension taken off gave one of the first two
    // the other's code, and found no output at all for the third.
    const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-names-"));
    writeFileSync(
      join(directory, "m.sts"),
      "export syntax duplicate:expr { rule { duplicate($v:tt) } => { [$v, $v] } }\n",
    );
    writeFileSync(join(directory, "a.sts"), "export const fromSts = 1;\n");
    writeFileSync(
      join(directory, "a.stsx"),
      "export const fromStsx = <div />;\n",
    );
    writeFileSync(
      join(directory, "d.ts"),
      '"use sweetener";\nimport { duplicate } from "./m.sts" for syntax;\nexport const x = duplicate(1);\n',
    );
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          jsx: "preserve",
        },
        include: ["*"],
      }),
    );
    const session = createSweetenerSession();
    const sts = await transform(session, join(directory, "a.sts"), config);
    const stsx = await transform(session, join(directory, "a.stsx"), config);
    const directive = await transform(session, join(directory, "d.ts"), config);
    expect(sts.code).toContain("fromSts = 1");
    expect(sts.virtualFilename).toMatch(/a\.ts$/u);
    expect(stsx.code).toContain("fromStsx = <div />");
    expect(stsx.virtualFilename).toMatch(/a\.tsx$/u);
    expect(directive.code).toContain("[1, 1]");
    expect(directive.virtualFilename).toMatch(/d\.ts$/u);
    await session.close();
  });

  test("keeps an expansion for each config it serves", async () => {
    const first = project();
    const second = project();
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    await transform(session, first.main, first.config);
    await transform(session, second.main, second.config);
    await transform(session, first.macros, first.config);
    await transform(session, second.macros, second.config);
    expect(counting.expansions()).toBe(2);
    await session.close();
  });

  test("sees a macro module rewritten at the same size straight after it was read", async () => {
    // Written within one tick of the file system's clock, the second version
    // can carry the first one's size and modification time, so a stat alone
    // cannot tell them apart.
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    writeFileSync(other, readFile(fixture.main));
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    writeFileSync(
      fixture.macros,
      `export syntax duplicate:expr { rule { duplicate($value:tt) } => { ($value, $value) } }\n`,
    );
    const after = await transform(session, other, fixture.config);
    expect(before.code).toContain("[21, 21]");
    expect(after.code).toContain("(21, 21)");
    await session.close();
  });

  test("sees a settled macro module rewritten at the same size with its modification time put back", async () => {
    // What `rsync -t` and `tar` do: new bytes, the old size and modification
    // time. Only the change time, which nothing can set back, still differs
    // from the stat the macro module was confirmed under.
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    writeFileSync(other, readFile(fixture.main));
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    // A whole second, which every file system's stamp can hold exactly.
    const modified = new Date("2026-01-01T00:00:00Z");
    utimesSync(fixture.macros, modified, modified);
    // Far enough on that every file just written reads as settled, so the
    // session confirms each by its stat and does not read it again.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10_000);
      const session = createSweetenerSession();
      const before = await transform(session, fixture.main, fixture.config);
      writeFileSync(
        fixture.macros,
        `export syntax duplicate:expr { rule { duplicate($value:tt) } => { ($value, $value) } }\n`,
      );
      utimesSync(fixture.macros, modified, modified);
      const after = await transform(session, other, fixture.config);
      expect(before.code).toContain("[21, 21]");
      expect(after.code).toContain("(21, 21)");
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * What one long-lived session answers after the project on disk changes under
 * it. Each case ends where a fresh session would give a different answer from
 * one that kept the expansion it had, so each is a way a kept expansion went
 * stale: every file expansion looked for -- found or not, and under the path
 * it looked, not where a symlink led -- decides its result.
 */
describe("a session after the project changes", () => {
  test.each([
    ["written within the window", 0n],
    ["written long ago, then changed within the window", 10_000_000_000n],
  ])(
    "reads a file whose stat cannot yet stand for its text: %s",
    async (_, age) => {
      // On a file system stamping writes coarsely, a file rewritten at the
      // same size within one tick keeps its stat. Here every stat stays the
      // same however the file changes, with the change time -- and with it,
      // in the first case, the modification time -- inside the window in
      // which a stat cannot stand for the text, so the file is read.
      const fixture = project();
      const other = join(fixture.directory, "other.sts");
      writeFileSync(other, readFile(fixture.main));
      writeFileSync(
        fixture.config,
        JSON.stringify({
          compilerOptions: { module: "ESNext", target: "ES2022" },
          files: ["macros.sts", "main.sts", "other.sts"],
        }),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const now = BigInt(Date.now()) * 1_000_000n;
        const target = createDefaultProjectExpansionProvider();
        const { system, stat } = target.fileSystem;
        if (stat === undefined)
          throw new Error(
            "The default provider reads the disk, which has stats",
          );
        const unchanging: ExpansionFileSystem = {
          system,
          stat: (path) => {
            const stats = stat(path);
            if (stats === undefined) return undefined;
            const fixed: Record<PropertyKey, bigint> = {
              ino: 1n,
              size: 1n,
              mtimeNs: now - age,
              ctimeNs: now,
            };
            return new Proxy(stats, {
              get: (stats, property) =>
                fixed[property] ?? Reflect.get(stats, property),
            });
          },
        };
        const provider = new Proxy(target, {
          get(target, property) {
            if (property === "fileSystem") return unchanging;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const session = createSweetenerSession({ provider });
        expect(
          (await transform(session, fixture.main, fixture.config)).code,
        ).toContain("[21, 21]");
        writeFileSync(
          fixture.macros,
          `export syntax duplicate:expr { rule { duplicate($value:tt) } => { ($value, $value) } }\n`,
        );
        expect(
          (await transform(session, other, fixture.config)).code,
        ).toContain("(21, 21)");
        await session.close();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  describe("a config extending a package", () => {
    // The package's config says where `@m/*` leads, and so which macro
    // module `main.sts` expands with. Each case changes only what one kind
    // of lookup resolving the `extends` saw.
    const extending = () => {
      const directory = realpathSync(
        mkdtempSync(join(tmpdir(), "sweet-compiler-extends-")),
      );
      for (const [name, value] of [
        ["one", 1],
        ["two", 2],
      ] as const) {
        mkdirSync(join(directory, name));
        writeFileSync(
          join(directory, name, "m.sts"),
          `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, ${value}] } }\n`,
        );
      }
      const app = join(directory, "app");
      mkdirSync(app);
      const config = join(app, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          extends: "@tsconfig/base/tsconfig.json",
          compilerOptions: { module: "ESNext", target: "ES2022" },
          files: ["main.sts"],
        }),
      );
      const main = join(app, "main.sts");
      writeFileSync(
        main,
        'import { duplicate } from "@m/m.sts" for syntax;\nexport const answer = duplicate(10);\n',
      );
      const base = (root: string, target: string) => {
        mkdirSync(root, { recursive: true });
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ name: "@tsconfig/base", version: "1.0.0" }),
        );
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              paths: { "@m/*": [join(directory, target, "*")] },
            },
          }),
        );
      };
      return { directory, app, config, main, base };
    };
    const expectFresh = async (
      session: SweetenerSession,
      main: string,
      config: string,
      expected: string,
    ) => {
      const result = await transform(session, main, config);
      expect(result.code).toContain(expected);
      expect(answer(result)).toEqual(answer(await freshly(main, config)));
    };

    test("follows a nearer node_modules that appears", async () => {
      // TypeScript looks in no directory that is not there, so only whether
      // it was there says the nearer copy was not looked for.
      const fixture = extending();
      fixture.base(
        join(fixture.directory, "node_modules", "@tsconfig", "base"),
        "one",
      );
      const session = createSweetenerSession();
      await expectFresh(session, fixture.main, fixture.config, "[10, 1]");
      fixture.base(
        join(fixture.app, "node_modules", "@tsconfig", "base"),
        "two",
      );
      await expectFresh(session, fixture.main, fixture.config, "[10, 2]");
      await session.close();
    });

    test("follows the config appearing in a package it looked in", async () => {
      // The nearer package is there from the start, without its config: only
      // the look for that file says it was not found.
      const fixture = extending();
      fixture.base(
        join(fixture.directory, "node_modules", "@tsconfig", "base"),
        "one",
      );
      const nearer = join(fixture.app, "node_modules", "@tsconfig", "base");
      fixture.base(nearer, "two");
      const config = readFile(join(nearer, "tsconfig.json"));
      rmSync(join(nearer, "tsconfig.json"));
      const session = createSweetenerSession();
      await expectFresh(session, fixture.main, fixture.config, "[10, 1]");
      writeFileSync(join(nearer, "tsconfig.json"), config);
      await expectFresh(session, fixture.main, fixture.config, "[10, 2]");
      await session.close();
    });

    test("follows a package link pointed at a new version", async () => {
      // Both versions read the same through the link; each extends an
      // `inner.json` beside it, found from where the link leads.
      const fixture = extending();
      const version = (name: string) =>
        join(
          fixture.directory,
          "node_modules",
          ".pnpm",
          name,
          "node_modules",
          "@tsconfig",
          "base",
        );
      for (const [name, target] of [
        ["base@1", "one"],
        ["base@2", "two"],
      ] as const) {
        const root = version(name);
        fixture.base(root, target);
        writeFileSync(
          join(root, "inner.json"),
          readFile(join(root, "tsconfig.json")),
        );
        writeFileSync(
          join(root, "tsconfig.json"),
          JSON.stringify({ extends: "./inner.json" }),
        );
      }
      const link = join(fixture.app, "node_modules", "@tsconfig", "base");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(version("base@1"), link);
      const session = createSweetenerSession();
      await expectFresh(session, fixture.main, fixture.config, "[10, 1]");
      rmSync(link);
      symlinkSync(version("base@2"), link);
      await expectFresh(session, fixture.main, fixture.config, "[10, 2]");
      await session.close();
    });
  });

  test("resolves a package from each importer, whatever else the project lists", async () => {
    // Node resolves a package from the importing file's own directory, so a
    // file outside `sub` never reaches `sub/node_modules`. One location
    // kept per package name for the whole project made `a.sts` expand with
    // whichever copy the last importer found, so deleting or adding
    // `sub/g.sts` changed `a.sts` without changing anything it read.
    const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-nearest-"));
    writeFormsPackage(join(directory, "node_modules", "@acme", "forms"), {
      rule: "[$value, 1]",
    });
    writeFormsPackage(
      join(directory, "sub", "node_modules", "@acme", "forms"),
      { rule: "[$value, 2]" },
    );
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["**/*.sts"],
        exclude: ["node_modules", "sub/node_modules"],
      }),
    );
    const a = join(directory, "a.sts");
    const g = join(directory, "sub", "g.sts");
    writeFileSync(a, formsSource(10));
    writeFileSync(g, formsSource(20));
    const session = createSweetenerSession();
    expect((await transform(session, a, config)).code).toContain("[10, 1]");
    expect((await transform(session, g, config)).code).toContain("[20, 2]");

    rmSync(g);
    const deleted = await transform(session, a, config);
    expect(deleted.code).toContain("[10, 1]");
    expect(answer(deleted)).toEqual(answer(await freshly(a, config)));

    writeFileSync(g, formsSource(20));
    const added = await transform(session, a, config);
    expect(added.code).toContain("[10, 1]");
    expect(answer(added)).toEqual(answer(await freshly(a, config)));
    await session.close();
  });

  test("takes the first alias target that is there, whatever other files import", async () => {
    // TypeScript tries `paths` targets in order and takes the first that is
    // there. Counting every target some other file happened to load made
    // `f.sts`'s import ambiguous the moment another file imported the second.
    const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-targets-"));
    const macro = (n: number) =>
      `export syntax duplicate:expr { rule { duplicate($value:tt) } => { [$value, ${n}] } }\n`;
    mkdirSync(join(directory, "a"));
    mkdirSync(join(directory, "b"));
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "a", "m.sts"), macro(1));
    writeFileSync(join(directory, "b", "m.sts"), macro(2));
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          paths: { "@m/*": ["./a/*", "./b/*"] },
        },
        include: ["src/**/*.sts"],
      }),
    );
    const f = join(directory, "src", "f.sts");
    writeFileSync(
      f,
      'import { duplicate } from "@m/m.sts" for syntax;\nexport const answer = duplicate(10);\n',
    );
    const session = createSweetenerSession();
    expect((await transform(session, f, config)).code).toContain("[10, 1]");

    writeFileSync(
      join(directory, "src", "g.sts"),
      'import { duplicate } from "../b/m.sts" for syntax;\nexport const other = duplicate(20);\n',
    );
    const after = await transform(session, f, config);
    expect(after.diagnostics).toEqual([]);
    expect(after.code).toContain("[10, 1]");
    expect(answer(after)).toEqual(answer(await freshly(f, config)));
    await session.close();
  });

  test.each([
    ["0.1.0", []],
    ["0.5.0", ["SWR5003"]],
  ] as const)(
    "checks a package's declared dependency from the package (base needs %s)",
    async (minimum, codes) => {
      // `@acme/forms` expands through `@acme/base`, which only its export
      // source imports. The manifest declares the dependency for the package,
      // so it leads where an import in the package's entry would, and the
      // dependency's own compiler range is checked there.
      const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-declared-"));
      const modules = join(directory, "node_modules", "@acme");
      const manifest = (
        name: string,
        exported: string,
        dependencies: readonly unknown[],
      ) =>
        JSON.stringify({
          formatVersion: 1,
          name,
          languageVersion: "1",
          compiler: {
            minimum: name === "@acme/base" ? minimum : "0.1.0",
            maximum: "0.9.x",
          },
          entry: "./macros.sts",
          exports: {
            [exported]: {
              source: "./exported.sts",
              category: "expr",
              phase: 1,
            },
          },
          dependencies,
        });
      for (const [name, exported, dependencies, source] of [
        [
          "base",
          "base",
          [],
          "export syntax base:expr { rule { base($value:tt) } => { [$value, $value] } }\n",
        ],
        [
          "forms",
          "packaged",
          [{ specifier: "@acme/base", kind: "macro", exports: ["base"] }],
          'import { base } from "@acme/base" for syntax;\nexport syntax packaged:expr { rule { packaged($value:tt) } => { base($value) } }\n',
        ],
      ] as const) {
        const root = join(modules, name);
        mkdirSync(root, { recursive: true });
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({
            name: `@acme/${name}`,
            version: "1.0.0",
            sweetMacros: "./sweet-macros.json",
          }),
        );
        writeFileSync(
          join(root, "sweet-macros.json"),
          manifest(`@acme/${name}`, exported, dependencies),
        );
        writeFileSync(
          join(root, "macros.sts"),
          `export const metadata = "macro package entry";\n`,
        );
        writeFileSync(join(root, "exported.sts"), source);
      }
      const main = join(directory, "main.sts");
      writeFileSync(main, formsSource(3));
      const config = join(directory, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: { module: "ESNext", target: "ES2022" },
          files: ["main.sts"],
        }),
      );
      const result = await freshly(main, config);
      expect(
        result.diagnostics.map(({ code }) => `SWR${String(code)}`),
      ).toEqual(codes);
      if (codes.length === 0) expect(result.code).toContain("[3, 3]");
    },
  );

  test("expands once a manifest's missing entry is created", async () => {
    const fixture = formsProject();
    writeFormsPackage(fixture.packageRoot, { entry: false });
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(String(before.diagnostics[0]?.messageText)).toContain(
      "entry or export source does not exist",
    );

    writeFileSync(
      join(fixture.packageRoot, "macros.sts"),
      `export const metadata = "macro package entry";\n`,
    );
    const after = await transform(session, fixture.other, fixture.config);
    expect(after.diagnostics).toEqual([]);
    expect(after.code).toContain("[2, 2]");
    await session.close();
  });

  test("expands once a missing package is installed", async () => {
    const fixture = formsProject();
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(String(before.diagnostics[0]?.messageText)).toContain(
      "Cannot resolve macro module @acme/forms",
    );

    writeFormsPackage(fixture.packageRoot);
    const after = await transform(session, fixture.other, fixture.config);
    expect(after.diagnostics).toEqual([]);
    expect(after.code).toContain("[2, 2]");
    // Where it was looked for, so a host can watch for it to appear.
    expect(before.missingDependencies).toContain(
      join(
        realpathSync(fixture.directory),
        "node_modules/@acme/forms/package.json",
      ),
    );
    await session.close();
  });

  test("follows a package link pointed at a new version", async () => {
    // How pnpm upgrades: the link moves and the old version stays in its
    // store, unchanged, until it is pruned.
    const fixture = formsProject();
    const store = join(fixture.directory, "node_modules", ".pnpm");
    const version = (name: string) =>
      join(store, name, "node_modules", "@acme", "forms");
    writeFormsPackage(version("forms@1"));
    writeFormsPackage(version("forms@2"), {
      rule: "[$value, $value, $value]",
    });
    mkdirSync(dirname(fixture.packageRoot), { recursive: true });
    symlinkSync(version("forms@1"), fixture.packageRoot);
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(before.code).toContain("[1, 1]");

    rmSync(fixture.packageRoot);
    symlinkSync(version("forms@2"), fixture.packageRoot);
    const after = await transform(session, fixture.other, fixture.config);
    expect(after.code).toContain("[2, 2, 2]");
    await session.close();
  });

  test("resolves to an earlier alias target once it appears", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-alias-"));
    mkdirSync(join(directory, "fallback"));
    mkdirSync(join(directory, "override"));
    writeFileSync(
      join(directory, "fallback", "m.sts"),
      `export syntax dup:expr { rule { dup($v:tt) } => { [$v, $v] } }\n`,
    );
    const source = (value: number) =>
      `import { dup } from "@m/m.sts" for syntax;\nexport const answer = dup(${value});\n`;
    const a = join(directory, "a.sts");
    const b = join(directory, "b.sts");
    writeFileSync(a, source(1));
    writeFileSync(b, source(2));
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          paths: { "@m/*": ["./override/*", "./fallback/*"] },
        },
        files: ["a.sts", "b.sts"],
      }),
    );
    const session = createSweetenerSession();
    const before = await transform(session, a, config);
    expect(before.code).toContain("[1, 1]");

    writeFileSync(
      join(directory, "override", "m.sts"),
      `export syntax dup:expr { rule { dup($v:tt) } => { [$v, $v, $v] } }\n`,
    );
    const after = await transform(session, b, config);
    expect(after.code).toContain("[2, 2, 2]");
    await session.close();
  });

  test("expands a file again once the macro module it lacked is created", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-outside-"));
    mkdirSync(join(directory, "src"));
    const main = join(directory, "src", "main.sts");
    writeFileSync(
      main,
      `import { dup } from "../shared/m.sts" for syntax;\nexport const answer = dup(1);\n`,
    );
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["src"],
      }),
    );
    const session = createSweetenerSession();
    const before = await transform(session, main, config);
    expect(String(before.diagnostics[0]?.messageText)).toContain(
      "Cannot resolve macro module ../shared/m.sts",
    );

    mkdirSync(join(directory, "shared"));
    writeFileSync(
      join(directory, "shared", "m.sts"),
      `export syntax dup:expr { rule { dup($v:tt) } => { [$v, $v] } }\n`,
    );
    const after = await transform(session, main, config);
    expect(after.diagnostics).toEqual([]);
    expect(after.code).toContain("[1, 1]");
    await session.close();
  });

  test("expands the rest of a project one of whose sources cannot be read", async () => {
    // TypeScript reports a listed source it cannot read, as it does one that
    // is not there. Nothing else reads it to expand, so the rest expand as a
    // fresh session expands them.
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    writeFileSync(other, "export const other = 2;\n");
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    const session = createSweetenerSession();
    await transform(session, fixture.main, fixture.config);
    chmodSync(other, 0o000);
    try {
      const after = await transform(session, fixture.main, fixture.config);
      expect(after.code).toContain("[21, 21]");
      expect(answer(after)).toEqual(
        answer(await freshly(fixture.main, fixture.config)),
      );
    } finally {
      chmodSync(other, 0o644);
    }
    await session.close();
  });

  test("answers from its own expansion after another config's expansion throws", async () => {
    const working = project();
    const other = join(working.directory, "other.sts");
    writeFileSync(other, readFile(working.main).replace("21", "7"));
    writeFileSync(
      working.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    // The provider expands the other project -- which replaces what it holds
    // about the last one -- and then fails.
    const broken = project();
    const target = createDefaultProjectExpansionProvider();
    const provider = new Proxy(target, {
      get(target, property) {
        if (property === "expandProject")
          return (project: LoadedSweetProject) => {
            const expanded = target.expandProject(project);
            if (project.configPath === realpathSync(broken.config))
              throw new Error("Expanding the broken project failed");
            return expanded;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const session = createSweetenerSession({ provider });
    await transform(session, working.main, working.config);
    await expect(
      transform(session, broken.main, broken.config),
    ).rejects.toThrow(/broken project failed/u);
    const after = await transform(session, other, working.config);
    expect(after.diagnostics).toEqual([]);
    expect(after.code).toContain("[7, 7]");
    await session.close();
  });
});

/**
 * A macro naming a binding literal is resolved by a TypeScript program over
 * the project, which reads what TypeScript's own resolution reaches: `.ts`
 * files the sources import, packages and their types, where a package link
 * leads, the type roots it lists. Each case changes one thing only that
 * program read, and ends where a fresh session answers differently from one
 * that kept the expansion it had.
 */
describe("a session after what TypeScript read for binding literals changes", () => {
  test("expands again once a `.ts` file a source imports changes", async () => {
    const fixture = shapesProject('import { Shape } from "./shapes";');
    const shapes = join(fixture.directory, "shapes.ts");
    writeFileSync(
      shapes,
      "export const Circle = 1;\nexport { Circle as Shape };\n",
    );
    writeFileSync(
      fixture.macros,
      shapesMacros('import { Circle } from "./shapes";', "Circle"),
    );
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(before.code).toContain('"circle"');

    writeFileSync(
      shapes,
      "export const Circle = 1;\nexport const Shape = 2;\n",
    );
    const after = await transform(session, fixture.main, fixture.config);
    expect(after.code).toContain('"other"');
    expect(answer(after)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );
    await session.close();
  });

  test("expands again once an `@types` package is installed", async () => {
    const fixture = shapesProject('import { Shape } from "shapes";');
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(before.code).toContain('"other"');

    const types = join(fixture.directory, "node_modules", "@types", "shapes");
    mkdirSync(types, { recursive: true });
    writeFileSync(
      join(types, "index.d.ts"),
      `export { Circle as Shape } from "${relative(types, fixture.local).replaceAll("\\", "/")}";\n`,
    );
    const after = await transform(session, fixture.main, fixture.config);
    expect(after.code).toContain('"circle"');
    expect(answer(after)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );
    await session.close();
  });

  test("follows a package link TypeScript resolved through, pointed at a new version", async () => {
    // Both versions read the same through the link -- the same package.json,
    // the same index.d.ts -- and differ in a file the index reaches from
    // where the link leads. Only where the link leads tells them apart.
    const fixture = shapesProject('import { Shape } from "shapes";');
    const store = join(fixture.directory, "node_modules", ".pnpm");
    const version = (name: string) =>
      join(store, name, "node_modules", "shapes");
    for (const [name, shape] of [
      [
        "shapes@1",
        (root: string) =>
          `export { Circle as Shape } from "${relative(root, fixture.local).replaceAll("\\", "/")}";\n`,
      ],
      ["shapes@2", () => "export declare const Shape: number;\n"],
    ] as const) {
      const root = version(name);
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "shapes",
          version: "1.0.0",
          types: "index.d.ts",
        }),
      );
      writeFileSync(join(root, "index.d.ts"), 'export * from "./shape";\n');
      writeFileSync(join(root, "shape.d.ts"), shape(root));
    }
    const link = join(fixture.directory, "node_modules", "shapes");
    symlinkSync(version("shapes@1"), link);
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(before.code).toContain('"circle"');

    rmSync(link);
    symlinkSync(version("shapes@2"), link);
    const after = await transform(session, fixture.main, fixture.config);
    expect(after.code).toContain('"other"');
    expect(answer(after)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );
    await session.close();
  });

  test("expands again once a package appears in a type root TypeScript listed", async () => {
    const fixture = shapesProject("", { types: ["*"] });
    const typeRoot = join(fixture.directory, "node_modules", "@types");
    mkdirSync(join(typeRoot, "shape-names"), { recursive: true });
    writeFileSync(
      join(typeRoot, "shape-names", "index.d.ts"),
      "declare namespace Shapes {\n  const Circle: number;\n}\n",
    );
    writeFileSync(fixture.macros, shapesMacros("", "Shapes.Circle"));
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(before.code).toContain('"other"');

    mkdirSync(join(typeRoot, "shape-alias"));
    writeFileSync(
      join(typeRoot, "shape-alias", "index.d.ts"),
      "import Shape = Shapes.Circle;\n",
    );
    const after = await transform(session, fixture.main, fixture.config);
    expect(after.code).toContain('"circle"');
    expect(answer(after)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );
    await session.close();
  });

  test("expands again once a `.ts` file opts in with a directive", async () => {
    // Opting in makes the file a source of the program that resolves the
    // literal, so its augmentation of `virtual-shapes` starts to count --
    // with the project's file list and every file expansion read unchanged
    // but for the directive, which is read like any other source.
    const fixture = shapesProject('import { Shape } from "virtual-shapes";', {
      moduleResolution: "bundler",
    });
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          target: "ES2022",
          moduleResolution: "bundler",
        },
        include: ["*.sts", "aug.ts"],
      }),
    );
    // An ambient module re-exports through a package, never a relative path.
    const shapes = join(fixture.directory, "node_modules", "local-shapes");
    mkdirSync(shapes, { recursive: true });
    writeFileSync(
      join(shapes, "package.json"),
      JSON.stringify({ name: "local-shapes", types: "index.d.ts" }),
    );
    writeFileSync(
      join(shapes, "index.d.ts"),
      "export declare const Circle: number;\n",
    );
    writeFileSync(
      fixture.macros,
      shapesMacros('import { Circle } from "local-shapes";', "Circle"),
    );
    const augmentation =
      'declare module "virtual-shapes" { export { Circle as Shape } from "local-shapes"; }\n';
    const aug = join(fixture.directory, "aug.ts");
    writeFileSync(aug, augmentation);
    const session = createSweetenerSession();
    const before = await transform(session, fixture.main, fixture.config);
    expect(before.code).toContain('"other"');

    writeFileSync(aug, `"use sweetener";\n${augmentation}`);
    const after = await transform(session, fixture.main, fixture.config);
    expect(after.code).toContain('"circle"');
    expect(answer(after)).toEqual(
      answer(await freshly(fixture.main, fixture.config)),
    );
    await session.close();
  });
});

/**
 * Requests made together are answered together, after the last of them was
 * made, so one check of what their expansions read serves them all.
 */
describe("a session answering requests made together", () => {
  test("checks what files share once for all the requests made together", async () => {
    const fixture = project();
    writeFileSync(
      fixture.macros,
      [
        "export syntax typeof:expr shadows core {",
        "  literal globalThis.NaN as NaN;",
        '  rule { typeof NaN } => { "NaN" }',
        "  fallback rule { typeof $value:expr } => { #core(typeof $value) }",
        "}",
        "",
      ].join("\n"),
    );
    const files = Array.from({ length: 5 }, (_, index) => {
      const fileName = join(fixture.directory, `file${index}.sts`);
      writeFileSync(
        fileName,
        `import { typeof } from "./macros.sts" for syntax shadows core;\nexport const kind${index} = typeof NaN;\n`,
      );
      return fileName;
    });
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", ...files.map((fileName) => basename(fileName))],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const all = () =>
      Promise.all(
        files.map((fileName) => transform(session, fileName, fixture.config)),
      );
    for (const result of await all()) expect(result.code).toContain('"NaN"');
    expect(counting.expansions()).toBe(1);

    // Every file's expansion depends on everything the project read, which
    // the files made together check once, and the files made one at a time
    // check once each.
    let before = counting.stats();
    await all();
    const together = counting.stats() - before;
    before = counting.stats();
    for (const fileName of files)
      session.transformSync({
        code: readFile(fileName),
        filename: fileName,
        configFile: fixture.config,
        mode: "test",
      });
    const apart = counting.stats() - before;
    expect(together).toBeGreaterThan(0);
    expect(apart).toBe(together * files.length);
    expect(counting.expansions()).toBe(1);
    await session.close();
  });

  test("checks an input many files read once for all the requests made together", async () => {
    // Two files read the same macro module. Made together, the module is
    // checked once for both; made one at a time, once each.
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    writeFileSync(other, readFile(fixture.main));
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const files = [fixture.main, other];
    await Promise.all(
      files.map((fileName) => transform(session, fileName, fixture.config)),
    );
    let before = counting.stats();
    for (const fileName of files)
      session.transformSync({
        code: readFile(fileName),
        filename: fileName,
        configFile: fixture.config,
        mode: "test",
      });
    const apart = counting.stats() - before;
    before = counting.stats();
    await Promise.all(
      files.map((fileName) => transform(session, fileName, fixture.config)),
    );
    const together = counting.stats() - before;
    expect(together).toBe(apart - 1);
    expect(counting.expansions()).toBe(1);
    await session.close();
  });

  test("expands once for all the requests made together that need it", async () => {
    // Neither file can be kept -- both fail -- and the one expansion made
    // for the first answers the second: it read everything after both were
    // made.
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    const broken = `import { duplicate } from "./macros.sts" for syntax;\nexport const broken = duplicate(1, 2);\n`;
    writeFileSync(fixture.main, broken);
    writeFileSync(other, broken);
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        files: ["macros.sts", "main.sts", "other.sts"],
      }),
    );
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    const results = await Promise.all(
      [fixture.main, other].map((fileName) =>
        transform(session, fileName, fixture.config),
      ),
    );
    for (const result of results) expect(result.diagnostics).not.toEqual([]);
    expect(counting.expansions()).toBe(1);
    await session.close();
  });

  test("loads a config once for all the requests made together", async () => {
    // Each file of a project whose macros name binding literals depends on
    // which files the config lists, so each asks for the config to be loaded
    // and its `include` walked; made together, they share one walk.
    const fixture = project();
    writeFileSync(
      fixture.macros,
      [
        "export syntax typeof:expr shadows core {",
        "  literal globalThis.NaN as NaN;",
        '  rule { typeof NaN } => { "NaN" }',
        "  fallback rule { typeof $value:expr } => { #core(typeof $value) }",
        "}",
        "",
      ].join("\n"),
    );
    const files = Array.from({ length: 3 }, (_, index) => {
      const fileName = join(fixture.directory, `file${index}.sts`);
      writeFileSync(
        fileName,
        `import { typeof } from "./macros.sts" for syntax shadows core;\nexport const kind${index} = typeof NaN;\n`,
      );
      return fileName;
    });
    writeFileSync(
      fixture.config,
      JSON.stringify({
        compilerOptions: { module: "ESNext", target: "ES2022" },
        include: ["*.sts"],
      }),
    );
    const session = createSweetenerSession();
    const all = () =>
      Promise.all(
        files.map((fileName) => transform(session, fileName, fixture.config)),
      );
    await all();
    const walks = vi.spyOn(ts.sys, "readDirectory");
    try {
      await all();
      expect(walks).toHaveBeenCalledTimes(1);
    } finally {
      walks.mockRestore();
    }
    await session.close();
  });

  test("answers a request made before a change with what came after it", async () => {
    // Checked when it is answered, not when it was made, so a request made
    // before a change and one made after it answer alike.
    const fixture = shapesProject('import { Shape } from "./shapes";');
    const shapes = join(fixture.directory, "shapes.ts");
    writeFileSync(
      shapes,
      "export const Circle = 1;\nexport { Circle as Shape };\n",
    );
    writeFileSync(
      fixture.macros,
      shapesMacros('import { Circle } from "./shapes";', "Circle"),
    );
    const session = createSweetenerSession();
    expect(
      (await transform(session, fixture.main, fixture.config)).code,
    ).toContain('"circle"');

    const before = transform(session, fixture.main, fixture.config);
    writeFileSync(
      shapes,
      "export const Circle = 1;\nexport const Shape = 2;\n",
    );
    const after = transform(session, fixture.main, fixture.config);
    expect((await before).code).toContain('"other"');
    expect((await after).code).toContain('"other"');
    await session.close();
  });
});

/**
 * A session keeps an expansion only for a config that can still use it, so
 * one that lives through many projects does not keep them all.
 */
describe("a session dropping what it can no longer serve", () => {
  test("drops a config whose file is gone once another config is loaded", async () => {
    const kept = project();
    const gone = project();
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    await transform(session, gone.main, gone.config);
    const texts = [gone.config, gone.macros, gone.main].map(
      (fileName) => [fileName, readFile(fileName)] as const,
    );
    rmSync(gone.directory, { recursive: true });
    await transform(session, kept.main, kept.config);
    expect(counting.expansions()).toBe(2);

    // The same project made again: a session that had kept the first would
    // find every file it read saying the same, and serve it unexpanded.
    mkdirSync(gone.directory);
    for (const [fileName, text] of texts) writeFileSync(fileName, text);
    await transform(session, gone.main, gone.config);
    expect(counting.expansions()).toBe(3);
    await session.close();
  });

  test("drops the expansion of a file its config stops listing", async () => {
    // Listed again, the file is expanded again: nothing of it was kept.
    const fixture = project();
    const other = join(fixture.directory, "other.sts");
    writeFileSync(other, readFile(fixture.main));
    const listing = (files: readonly string[]) =>
      writeFileSync(
        fixture.config,
        JSON.stringify({
          compilerOptions: { module: "ESNext", target: "ES2022" },
          files,
        }),
      );
    listing(["macros.sts", "main.sts", "other.sts"]);
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    await transform(session, other, fixture.config);
    listing(["macros.sts", "main.sts"]);
    await transform(session, fixture.main, fixture.config);
    listing(["macros.sts", "main.sts", "other.sts"]);
    await transform(session, other, fixture.config);
    expect(counting.expansions()).toBe(2);
    await session.close();
  });

  test("drops the expansion of another config's source that is gone", async () => {
    // Loading one config sweeps what is kept for the others: the source's
    // expansion goes with the source, so made again it is expanded again.
    const kept = project();
    const swept = project();
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    await transform(session, swept.main, swept.config);
    const text = readFile(swept.main);
    rmSync(swept.main);
    await transform(session, kept.main, kept.config);
    writeFileSync(swept.main, text);
    await transform(session, swept.main, swept.config);
    expect(counting.expansions()).toBe(3);
    await session.close();
  });

  test("drops a config a host says was deleted", async () => {
    const fixture = project();
    const counting = countingProvider();
    const session = createSweetenerSession({ provider: counting.provider });
    await transform(session, fixture.main, fixture.config);
    const config = readFile(fixture.config);
    rmSync(fixture.config);
    session.invalidate([fixture.config]);

    writeFileSync(fixture.config, config);
    await transform(session, fixture.main, fixture.config);
    expect(counting.expansions()).toBe(2);
    await session.close();
  });
});

/** Macros whose `kind(x)` says whether `x` is the binding `reference` names. */
function shapesMacros(imports: string, reference: string): string {
  return [
    imports,
    "export syntax kind:expr {",
    `  literal ${reference} as Circle;`,
    '  rule { kind(Circle) } => { "circle" }',
    '  fallback rule { kind($value:expr) } => { "other" }',
    "}",
    "",
  ].join("\n");
}

/**
 * A project whose `main.sts` asks `kind(Shape)`, with `Shape` brought in by
 * `imports`, and whose macros ask after `Circle` from `local.ts`.
 */
function shapesProject(
  imports: string,
  compilerOptions: Record<string, unknown> = {},
): {
  directory: string;
  config: string;
  main: string;
  macros: string;
  local: string;
} {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "sweet-compiler-literals-")),
  );
  const main = join(directory, "main.sts");
  const macros = join(directory, "macros.sts");
  const local = join(directory, "local");
  const config = join(directory, "tsconfig.json");
  writeFileSync(`${local}.ts`, "export const Circle = 1;\n");
  writeFileSync(
    macros,
    shapesMacros('import { Circle } from "./local";', "Circle"),
  );
  writeFileSync(
    main,
    `import { kind } from "./macros.sts" for syntax;\n${imports}\nexport const answer = kind(Shape);\n`,
  );
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        target: "ES2022",
        ...compilerOptions,
      },
      files: ["macros.sts", "main.sts"],
    }),
  );
  return { directory, config, main, macros, local };
}

function readFile(fileName: string): string {
  return readFileSync(fileName, "utf8");
}

/**
 * The default provider, counting how many times it expands a project and how
 * many times what an expansion read is checked by stat.
 */
function countingProvider(): {
  readonly provider: DefaultProjectExpansionProvider;
  readonly expansions: () => number;
  readonly stats: () => number;
} {
  let expansions = 0;
  let stats = 0;
  const target = createDefaultProjectExpansionProvider();
  const { system, stat } = target.fileSystem;
  if (stat === undefined)
    throw new Error("The default provider reads the disk, which has stats");
  const fileSystem: ExpansionFileSystem = {
    system,
    stat: (path) => {
      stats += 1;
      return stat(path);
    },
  };
  const provider = new Proxy(target, {
    get(target, property) {
      if (property === "expandProject")
        return (
          ...args: Parameters<DefaultProjectExpansionProvider["expandProject"]>
        ) => {
          expansions += 1;
          return target.expandProject(...args);
        };
      if (property === "fileSystem") return fileSystem;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { provider, expansions: () => expansions, stats: () => stats };
}

function transform(
  session: SweetenerSession,
  filename: string,
  configFile: string,
): Promise<SweetenerTransformResult> {
  return session.transform({
    code: readFile(filename),
    filename,
    configFile,
    mode: "test",
  });
}

/** A transform result as a fresh session for the same file has to give it. */
function answer(result: SweetenerTransformResult) {
  return {
    code: result.code,
    map: result.map,
    diagnostics: result.diagnostics.map(({ code, messageText, start }) => [
      code,
      ts.flattenDiagnosticMessageText(messageText, " "),
      start,
    ]),
    warnings: result.warnings.map(({ code, start }) => [code, start]),
    dependencies: result.dependencies,
    missingDependencies: result.missingDependencies,
  };
}

/** The same transform, from a session that has never seen the project. */
async function freshly(
  filename: string,
  configFile: string,
): Promise<SweetenerTransformResult> {
  const session = createSweetenerSession();
  try {
    return await transform(session, filename, configFile);
  } finally {
    await session.close();
  }
}

function formsManifest(source: string): string {
  return JSON.stringify({
    formatVersion: 1,
    name: "@acme/forms",
    languageVersion: "1",
    compiler: { minimum: "0.1.0", maximum: "0.9.x" },
    entry: "./macros.sts",
    exports: { packaged: { source, category: "expr", phase: 1 } },
    dependencies: [],
  });
}

/** An installed `@acme/forms` whose `packaged(x)` expands to `rule`. */
function writeFormsPackage(
  packageRoot: string,
  options: { readonly entry?: boolean; readonly rule?: string } = {},
): void {
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
    formsManifest("./forms.sts"),
  );
  if (options.entry ?? true)
    writeFileSync(
      join(packageRoot, "macros.sts"),
      `export const metadata = "macro package entry";\n`,
    );
  writeFileSync(
    join(packageRoot, "forms.sts"),
    `export syntax packaged:expr { rule { packaged($value:tt) } => { ${options.rule ?? "[$value, $value]"} } }\n`,
  );
}

function formsSource(value: number): string {
  return `import { packaged } from "@acme/forms" for syntax;\nexport const answer = packaged(${value});\n`;
}

/** Two files using `@acme/forms`, which is not installed yet. */
function formsProject(): {
  directory: string;
  config: string;
  main: string;
  other: string;
  packageRoot: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "sweet-compiler-forms-"));
  const main = join(directory, "main.sts");
  const other = join(directory, "other.sts");
  const config = join(directory, "tsconfig.json");
  writeFileSync(main, formsSource(1));
  writeFileSync(other, formsSource(2));
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: "ESNext", target: "ES2022" },
      files: ["main.sts", "other.sts"],
    }),
  );
  return {
    directory,
    config,
    main,
    other,
    packageRoot: join(directory, "node_modules", "@acme", "forms"),
  };
}

test("expands a failing file again each time it is asked for", async () => {
  // A failure may come of a limit or a deadline as much as of the source, so
  // it is never served from a cache: asked for again, unchanged, the file is
  // expanded again.
  const fixture = project();
  writeFileSync(
    fixture.main,
    `import { duplicate } from "./macros.sts" for syntax;\nexport const broken = duplicate(1, 2);\n`,
  );
  const counting = countingProvider();
  const session = createSweetenerSession({ provider: counting.provider });
  const first = await transform(session, fixture.main, fixture.config);
  expect(first.diagnostics).not.toEqual([]);
  await transform(session, fixture.main, fixture.config);
  expect(counting.expansions()).toBe(2);
  await session.close();
});

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
