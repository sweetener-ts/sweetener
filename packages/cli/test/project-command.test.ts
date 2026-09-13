import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import type { PrintedExpandedFile } from "@sweetener/printer";
import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import type { Diagnostic } from "@sweetener/shared";
import {
  createDefaultProjectExpansionProvider,
  formatDiagnosticMessage,
  loadSweetProject,
  runConfiguredProjectCommand,
  type ProjectExpansionProvider,
} from "../src/index.js";

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-cli-"));
  const input = join(directory, "main.sts");
  const config = join(directory, "tsconfig.json");
  writeFileSync(input, source);
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        declaration: true,
        outDir: "dist",
        rootDir: ".",
        target: "ES2022",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["main.sts"],
    }),
  );
  return { config, input };
}

function provider(input: string, text: string): ProjectExpansionProvider {
  const generated: PrintedExpandedFile = Object.freeze({
    text,
    originMap: Object.freeze({ schemaVersion: 1, entries: Object.freeze([]) }),
    tokenSpans: Object.freeze([]),
    trace: Object.freeze([]),
    serializedTrace: "[]\n",
  });
  return {
    expandProject: () => [
      { fileName: input.replace(/\.sts$/u, ".ts"), generated },
    ],
    debugState: () => ({ hits: 1 }),
  };
}

describe("project commands", () => {
  test("fails before expansion when the config file cannot be read", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-missing-config-"));
    let expanded = false;
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: join(directory, "missing.json"),
      expansionProvider: {
        expandProject: () => {
          expanded = true;
          return [];
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 5083 })]),
    );
    expect(expanded).toBe(false);
  });

  test("loads every declarative playground family through the production frontend", () => {
    const fixtureRoot = resolve(
      import.meta.dirname,
      "../../../fixtures/acceptance/playground",
    );
    const families = [
      "adt",
      "core-rewrites",
      "csp",
      "currying",
      "do-notation",
      "implicit-return",
      "multi-part-methods",
      "new-language",
      "operators",
      "protocols",
      "rewritten-if",
      "threading",
    ];
    for (const family of families) {
      const directory = mkdtempSync(join(tmpdir(), `sweet-${family}-cli-`));
      const config = join(directory, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          sweet: { macroExtensions: [".sts"] },
          files: [
            join(fixtureRoot, family, "declarative.sts"),
            join(fixtureRoot, family, "acceptance.sts"),
          ],
        }),
      );
      const provider = createDefaultProjectExpansionProvider();
      let expanded;
      try {
        expanded = provider.expandProject(loadSweetProject(config));
      } catch (error) {
        throw new Error(`${family}: ${String(error)}`, { cause: error });
      }
      if (expanded.diagnostics.length > 0)
        throw new Error(
          `${family}: ${JSON.stringify(
            expanded.diagnostics.map(({ code, messageText }) => ({
              code,
              messageText,
            })),
          )} trace=${JSON.stringify(
            provider.inspectSource(join(fixtureRoot, family, "acceptance.sts"))
              ?.trace,
          )}`,
        );
      expect(expanded.files).toHaveLength(2);
      const generated = expanded.files.find(({ fileName }) =>
        fileName.endsWith("acceptance.ts"),
      )?.generated.text;
      expect(generated, family).toBeDefined();
      const transpiled = ts.transpileModule(generated!, {
        compilerOptions: {
          strict: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
        reportDiagnostics: true,
      });
      const transpileDiagnostics = (transpiled.diagnostics ?? []).map(
        ({ code, messageText }) => ({
          code,
          messageText:
            typeof messageText === "string"
              ? messageText
              : messageText.messageText,
        }),
      );
      if (transpileDiagnostics.length > 0)
        throw new Error(
          `${family}: ${JSON.stringify(transpileDiagnostics)} trace=${JSON.stringify(provider.inspectSource(join(fixtureRoot, family, "acceptance.sts"))?.trace)} generated=${generated}`,
        );
      const moduleRecord: { exports: Record<string, unknown> } = {
        exports: {},
      };
      try {
        runInNewContext(transpiled.outputText, {
          exports: moduleRecord.exports,
          module: moduleRecord,
          require: (specifier: string) => {
            if (specifier === "./runtime.js")
              return {
                IF: <T>(
                  predicate: boolean,
                  trueBranch: () => T,
                  falseBranch: () => T,
                ) => (predicate ? trueBranch : falseBranch),
              };
            throw new Error(`unexpected runtime import ${specifier}`);
          },
        });
      } catch (error) {
        throw new Error(`${family}: ${String(error)} generated=${generated}`, {
          cause: error,
        });
      }
      const expectedRuntime = JSON.parse(
        readFileSync(
          join(fixtureRoot, family, "expected.runtime.json"),
          "utf8",
        ),
      ) as { exports: { result: unknown } };
      expect(
        JSON.parse(JSON.stringify(moduleRecord.exports["result"])),
        family,
      ).toEqual(expectedRuntime.exports.result);
    }
  });

  test("enforces source-ordered local macro visibility", () => {
    const project = fixture(`
      export const before = later!;
      syntax later:expr { rule { later! } => { 42 } }
      export const after = later!;
      export const beforeOperator = 1 %% 2;
      export operator (%%):expr {
        fixity infix;
        associativity left;
        precedence 120;
        rule { $left:expr %% $right:expr } => { $left + $right }
      }
      export const afterOperator = 1 %% 2;
    `);

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      writeThrough: false,
    });

    const generated = result.virtualFiles[0]?.generated.text;
    expect(generated).toContain("before = later!");
    expect(generated).toContain("after = 42");
    expect(generated).toContain("beforeOperator = 1 %% 2");
    expect(generated).toMatch(/afterOperator\s*=\s*\(?\s*1\)?\s*\+\s*2/u);
    // The use above the definition is reported by expansion, which knows the
    // macro is defined below. It used to reach TypeScript as 2552, a missing
    // name, which said nothing about the definition underneath it.
    expect(result.diagnostics.map(({ code }) => code)).toContain(4017);
  });

  test("recursively expands every template substitution without rewriting literal segments", () => {
    const project = fixture(`
      syntax twice:expr {
        rule { twice($value:expr) } => { $value + $value }
      }
      export const text = String.raw\`before \${twice(1)} middle \${
        \`nested \${twice(2)}\`
      } after\`;
    `);

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      writeThrough: false,
    });

    expect(result.diagnostics).toEqual([]);
    const generated = result.virtualFiles[0]?.generated.text ?? "";
    expect(generated).toContain("String.raw`before ${");
    expect(generated).toMatch(/middle\s+\$\{\s*`nested\s+\$\{/u);
    expect(generated).toContain("} after`");
    expect(generated).not.toContain("twice(");
    const compact = generated.replace(/[\s()]/gu, "");
    expect(compact.match(/1\+1/gu)).toHaveLength(1);
    expect(compact.match(/2\+2/gu)).toHaveLength(1);
  });

  test("synthesizes and hygienically aliases definition-site runtime imports", () => {
    const family = resolve(
      import.meta.dirname,
      "../../../fixtures/acceptance/playground/rewritten-if",
    );
    const directory = mkdtempSync(join(tmpdir(), "sweet-runtime-import-cli-"));
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        sweet: { macroExtensions: [".sts"] },
        files: [join(family, "declarative.sts"), join(family, "hygiene.sts")],
      }),
    );
    const expansion = createDefaultProjectExpansionProvider().expandProject(
      loadSweetProject(config),
    );
    const generated = expansion.files.find(({ fileName }) =>
      fileName.endsWith("hygiene.ts"),
    )?.generated.text;

    expect(expansion.diagnostics).toEqual([]);
    expect(generated).toContain('import { IF as IF_1 } from "./runtime.js";');
    expect(generated).toContain('const IF = "call-site IF"');
    expect(generated).toContain("IF_1(");
  });

  test("reports every malformed playground family through the production frontend", () => {
    const fixtureRoot = resolve(
      import.meta.dirname,
      "../../../fixtures/acceptance/playground",
    );
    for (const family of [
      "adt",
      "core-rewrites",
      "csp",
      "currying",
      "do-notation",
      "implicit-return",
      "multi-part-methods",
      "new-language",
      "operators",
      "protocols",
      "rewritten-if",
      "threading",
    ]) {
      const directory = mkdtempSync(join(tmpdir(), `sweet-${family}-bad-cli-`));
      const config = join(directory, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          sweet: { macroExtensions: [".sts"] },
          files: [
            join(fixtureRoot, family, "declarative.sts"),
            join(fixtureRoot, family, "malformed.sts"),
          ],
        }),
      );
      const diagnostics = createDefaultProjectExpansionProvider().expandProject(
        loadSweetProject(config),
      ).diagnostics;
      const expected = JSON.parse(
        readFileSync(
          join(fixtureRoot, family, "expected.malformed.diagnostics.json"),
          "utf8",
        ),
      ) as readonly { code: string; messageArguments: readonly string[] }[];

      expect(
        diagnostics.map(({ code, messageText }) => ({
          code: `SWR${String(code)}`,
          messageText: String(messageText),
        })),
        family,
      ).toEqual(
        expected.map(({ code, messageArguments }) => ({
          code,
          messageText: formatDiagnosticMessage(
            code as Diagnostic["code"],
            messageArguments,
          ),
        })),
      );
    }
  });

  test("preserves every playground hygiene contract through the production frontend", () => {
    const fixtureRoot = resolve(
      import.meta.dirname,
      "../../../fixtures/acceptance/playground",
    );
    const execute = (source: string) => {
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
        reportDiagnostics: true,
      });
      expect(transpiled.diagnostics ?? []).toEqual([]);
      const executable = transpiled.outputText
        .replace(
          /import\s*\{\s*IF(?:\s+as\s+(\w+))?\s*\}\s*from\s*["']\.\/runtime\.js["'];?/gu,
          (_match, alias: string | undefined) =>
            `const ${alias ?? "IF"} = __runtimeIF;`,
        )
        .replace(/^import\s+[^;]+;\s*$/gmu, "")
        .replace(/\bexport\s+/gu, "");
      const result = runInNewContext(
        `(function () { ${executable}\nreturn hygieneResult; })();`,
        {
          __runtimeIF: <T>(
            predicate: boolean,
            trueBranch: () => T,
            falseBranch: () => T,
          ) => (predicate ? trueBranch : falseBranch),
        },
      );
      return JSON.parse(JSON.stringify(result)) as unknown;
    };
    for (const family of [
      "adt",
      "core-rewrites",
      "csp",
      "currying",
      "do-notation",
      "implicit-return",
      "multi-part-methods",
      "new-language",
      "operators",
      "protocols",
      "rewritten-if",
      "threading",
    ]) {
      const directory = mkdtempSync(
        join(tmpdir(), `sweet-${family}-hygiene-cli-`),
      );
      const config = join(directory, "tsconfig.json");
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true },
          sweet: { macroExtensions: [".sts"] },
          files: [
            join(fixtureRoot, family, "declarative.sts"),
            join(fixtureRoot, family, "hygiene.sts"),
          ],
        }),
      );
      const expansion = createDefaultProjectExpansionProvider().expandProject(
        loadSweetProject(config),
      );
      const generated = expansion.files.find(({ fileName }) =>
        fileName.endsWith("hygiene.ts"),
      )?.generated.text;
      expect(expansion.diagnostics, family).toEqual([]);
      expect(generated, family).toBeDefined();
      expect(execute(generated!), family).toEqual(
        execute(
          readFileSync(
            join(fixtureRoot, family, "expected.hygiene.ts"),
            "utf8",
          ),
        ),
      );
    }
  });

  test("matches declared binding literals by TypeScript symbol identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-literal-cli-"));
    const macros = join(directory, "core.sts");
    const input = join(directory, "main.sts");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      macros,
      `export syntax typeof:expr shadows core {
         literal globalThis.NaN as NaN;
         rule { typeof NaN } => { "global NaN" }
         fallback rule { typeof $value:expr } => { #core(typeof $value) }
       }`,
    );
    writeFileSync(
      input,
      `import { typeof } from "./core.sts" for syntax shadows core;
       export const globalKind = typeof NaN;
       export const localKind = (NaN: number) => typeof NaN;`,
    );
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        sweet: { macroExtensions: [".sts"] },
        files: ["core.sts", "main.sts"],
      }),
    );

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });

    expect(result.diagnostics).toEqual([]);
    const generated = result.virtualFiles.find(({ fileName }) =>
      fileName.endsWith("main.ts"),
    )?.generated.text;
    expect(generated).toContain('"global NaN"');
    // Parenthesised because `typeof` binds against what follows it.
    expect(generated).toMatch(/=>\s*\(?\s*typeof\s+NaN/u);

    writeFileSync(
      macros,
      `export syntax typeof:expr shadows core {
         literal missingNamespace.NaN as NaN;
         rule { typeof NaN } => { "bad" }
       }`,
    );
    const unresolved = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(unresolved.diagnostics.map(({ code }) => code)).toContain(4009);
  });

  test("derives generator context for declarative macro admission", () => {
    const project = fixture(`
      syntax emit:stmt {
        rule { emit $value:expr; }
        context generator;
        => { yield $value; }
      }
      export function* values() { emit 7; }
    `);

    const accepted = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      writeThrough: false,
    });
    expect(accepted.diagnostics).toEqual([]);
    expect(accepted.virtualFiles[0]?.generated.text).toMatch(
      /yield\s*\(?\s*7/u,
    );

    writeFileSync(
      project.input,
      `syntax emit:stmt {
         rule { emit $value:expr; }
         context generator;
         => { yield $value; }
       }
       export function values() { emit 7; }`,
    );
    const rejected = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      writeThrough: false,
    });
    expect(rejected.diagnostics.map(({ code }) => code)).toContain(4001);
  });

  test("registers generated declarative definitions in source order", () => {
    const project = fixture(`
      syntax define:item {
        rule { define $name:ident; } => {
          #syntax {
            syntax $name:expr {
              rule { $name! } => { 42 }
            }
          }
        }
      }
      define answer;
      export const result = answer!;
    `);

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      writeThrough: false,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.virtualFiles[0]?.generated.text).toContain(
      "export const result = 42",
    );
  });

  test("requires both definition and import opt-in for core interception", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-core-cli-"));
    const macros = join(directory, "core.sts");
    const input = join(directory, "main.sts");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      macros,
      `export syntax if:stmt shadows core {
         rule { if ($condition:expr) $body:stmt } => { return; }
       }`,
    );
    const source = (optIn: boolean) =>
      `import { if } from "./core.sts" for syntax${optIn ? " shadows core" : ""};
       export function choose() { if (true) { throw new Error(); } }`;
    writeFileSync(input, source(false));
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true },
        sweet: { macroExtensions: [".sts"] },
        files: ["core.sts", "main.sts"],
      }),
    );

    const ordinary = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(ordinary.diagnostics).toEqual([]);
    expect(
      ordinary.virtualFiles.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text,
    ).toContain("if (true)");

    writeFileSync(input, source(true));
    const intercepted = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(intercepted.diagnostics).toEqual([]);
    expect(
      intercepted.virtualFiles.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      )?.generated.text,
    ).toContain("return;");
    const inspectionProvider = createDefaultProjectExpansionProvider();
    inspectionProvider.expandProject(loadSweetProject(config));
    const trace = inspectionProvider.inspectSource(input)?.trace as
      | readonly {
          readonly coreInterception?:
            | {
                readonly decision?: unknown;
                readonly importOrigin?: unknown;
              }
            | undefined;
        }[]
      | undefined;
    expect(
      trace?.some(
        ({ coreInterception }) =>
          coreInterception?.decision === "shadow-macro" &&
          coreInterception.importOrigin !== undefined,
      ),
    ).toBe(true);

    writeFileSync(
      macros,
      `export syntax if:stmt { rule { if ($condition:expr) $body:stmt } => { return; } }`,
    );
    const unauthorized = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(unauthorized.diagnostics.map(({ code }) => code)).toContain(4003);
  });

  test("expands .stsx files through the default frontend", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-tsx-cli-"));
    const input = join(directory, "component.stsx");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      input,
      `syntax value:expr { rule { value! } => { 42 } }
       syntax div:expr { rule { div } => { "not a tag" } }
       declare namespace JSX { interface IntrinsicElements { div: {}; } }
       export const answer = value!;
       export const view = <div>{value!}</div>;`,
    );
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noImplicitAny: false,
          jsx: "preserve",
          noEmit: true,
        },
        sweet: { macroExtensions: [".stsx"] },
        files: ["component.stsx"],
      }),
    );

    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.virtualFiles[0]?.fileName).toBe(
      input.replace(/\.stsx$/u, ".tsx"),
    );
    expect(result.virtualFiles[0]?.generated.text).toContain("42");
    expect(result.virtualFiles[0]?.generated.text).toMatch(
      /<div>\{\s*42\s*\}<\/div>/u,
    );
  });

  test("discovers an installed package macro manifest and package-root export", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-package-cli-"));
    const packageRoot = join(directory, "node_modules/@acme/forms");
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
        entry: "./macros.sts",
        exports: {
          packaged: { source: "./forms.sts", category: "expr", phase: 1 },
        },
        dependencies: [],
      }),
    );
    writeFileSync(
      join(packageRoot, "macros.sts"),
      `export const metadata = "macro package entry";`,
    );
    writeFileSync(
      join(packageRoot, "forms.sts"),
      `export syntax packaged:expr {
        rule { packaged($value:tt) } => { [$value, $value] }
      }`,
    );
    const input = join(directory, "main.sts");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      input,
      `import { packaged } from "@acme/forms" for syntax;
       export const result = packaged(9);`,
    );
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          declaration: true,
          outDir: "dist",
          target: "ES2022",
          module: "ESNext",
        },
        sweet: { macroExtensions: [".sts"] },
        files: ["main.sts"],
      }),
    );

    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: config,
      writeThrough: false,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.virtualFiles).toHaveLength(1);
    expect(result.virtualFiles[0]?.generated.text).toContain("[9, 9]");

    const expansionProvider = createDefaultProjectExpansionProvider();
    const project = loadSweetProject(config);
    expansionProvider.expandProject(project);
    expect(expansionProvider.macroDependencies(project)).toContain(
      join(packageRoot, "forms.sts"),
    );

    writeFileSync(
      join(packageRoot, "sweet-macros.json"),
      JSON.stringify({
        formatVersion: 1,
        name: "@acme/forms",
        languageVersion: "1",
        compiler: { minimum: "0.1.0", maximum: "0.9.x" },
        entry: "./macros.sts",
        exports: {
          missing: { source: "./forms.sts", category: "expr", phase: 1 },
        },
        dependencies: [],
      }),
    );
    const invalidExport = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(invalidExport.exitCode).toBe(1);
    expect(invalidExport.diagnostics.map(({ code }) => code)).toContain(5001);

    writeFileSync(join(packageRoot, "sweet-macros.json"), "{");
    const malformedJson = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(malformedJson.exitCode).toBe(1);
    expect(malformedJson.diagnostics.map(({ code }) => code)).toContain(5001);
    expect(malformedJson.diagnostics.map(({ code }) => code)).not.toContain(
      6201,
    );

    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@acme/forms",
        version: "1.0.0",
        sweetMacros: "../../outside.json",
      }),
    );
    const escaped = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(escaped.exitCode).toBe(1);
    expect(escaped.diagnostics.map(({ code }) => code)).toContain(5001);
  });

  test("builds a declarative macro project through the default frontend", () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-default-cli-"));
    const base = join(directory, "base.sts");
    const macros = join(directory, "macros.sts");
    const input = join(directory, "main.sts");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      base,
      `export syntax wrap:expr {
        rule { wrap($value:tt) } => { [$value, $value] }
      }
      export operator (%%):expr {
        fixity infix;
        associativity left;
        precedence 140;
        rule { $left:expr %% $right:expr } => { $left + $right }
      }`,
    );
    writeFileSync(
      macros,
      `import { wrap as inner, (%%) } from "./base.sts" for syntax;
      export syntax duplicate:expr {
        rule { duplicate($value:tt) } => { inner($value) }
      }
      export syntax calculated:expr {
        rule { calculated($value:tt) } => { 1 %% $value }
      }
      export syntax guard:stmt {
        rule { guard($condition:expr) $body:stmt } => { return; }
      }
      export syntax maybe:type {
        rule { maybe<$value:type> } => { $value | undefined }
      }
      export syntax secret:expr {
        rule { secret($value:tt) } => { "leaked" }
      }
      export operator (***):expr {
        fixity infix;
        associativity left;
        precedence 140;
        rule { $left:expr *** $right:expr } => { hidden($left, $right) }
      }`,
    );
    const applicationSource = `import { duplicate as twice, calculated, guard, maybe } from "@forms/macros.sts" for syntax;
       export const answer: maybe<number[]> = twice(21);
       export const calculatedAnswer = calculated(20);
       export function checked(ok: boolean) { guard(ok) { throw new Error(); } }`;
    writeFileSync(input, applicationSource);
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          declaration: true,
          outDir: "dist",
          rootDir: ".",
          target: "ES2022",
          module: "ESNext",
          baseUrl: ".",
          paths: { "@forms/*": ["*"] },
          ignoreDeprecations: "6.0",
        },
        sweet: { macroExtensions: [".sts"] },
        files: ["base.sts", "macros.sts", "main.sts"],
      }),
    );
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: config,
      writeThrough: false,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(
      result.virtualFiles.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text,
    ).toContain("[21, 21]");
    const mainGenerated = result.virtualFiles.find(({ fileName }) =>
      fileName.endsWith("main.ts"),
    )?.generated.text;
    expect(mainGenerated).toMatch(
      /calculatedAnswer\s*=\s*\(?\s*1\s*\)?\s*\+\s*20/u,
    );
    expect(
      result.virtualFiles.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text,
    ).toContain("number[] | undefined");
    expect(
      result.virtualFiles.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text,
    ).toContain("return;");
    expect(
      [...result.outputs.keys()].some((name) => name.endsWith("main.js")),
    ).toBe(true);
    expect(
      [...result.outputs.keys()].some((name) => name.endsWith("main.d.ts")),
    ).toBe(true);

    writeFileSync(
      input,
      `${applicationSource}\nexport const mustNotExpand = secret(1);`,
    );
    const isolated = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(
      isolated.virtualFiles.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text,
    ).toContain("secret(1)");
    expect(isolated.exitCode).toBe(1);
    expect(isolated.diagnostics.map(({ code }) => code)).toContain(2304);

    writeFileSync(
      input,
      `${applicationSource}\nexport const hiddenOperator = 2 *** 3;`,
    );
    const operatorIsolation = runConfiguredProjectCommand({
      command: "check",
      configPath: config,
      writeThrough: false,
    });
    expect(operatorIsolation.exitCode).toBe(1);
    expect(operatorIsolation.diagnostics.map(({ code }) => code)).not.toContain(
      6201,
    );
    expect(
      operatorIsolation.virtualFiles.find(({ fileName }) =>
        fileName.endsWith("main.ts"),
      )?.generated.text,
    ).toContain("***");
  });

  test("checks expanded virtual TypeScript without emitting", () => {
    const project = fixture("not valid TypeScript macro syntax");
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      expansionProvider: provider(
        project.input,
        "export const answer: number = 42;",
      ),
      writeThrough: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.outputs.size).toBe(0);
    expect(result.debugState).toEqual({ hits: 1 });
  });

  test("builds JavaScript and declarations through the official emitter", () => {
    const project = fixture("custom form");
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: project.config,
      expansionProvider: provider(
        project.input,
        "export const answer: number = 42;",
      ),
      writeThrough: false,
    });
    expect(result.exitCode).toBe(0);
    expect(
      [...result.outputs.keys()].some((name) => name.endsWith("main.js")),
    ).toBe(true);
    expect(
      [...result.outputs.keys()].some((name) => name.endsWith("main.d.ts")),
    ).toBe(true);
  });

  test("returns TypeScript errors without emitting a broken build", () => {
    const project = fixture("custom form");
    const result = runConfiguredProjectCommand({
      command: "build",
      configPath: project.config,
      expansionProvider: provider(
        project.input,
        'const value: number = "wrong";',
      ),
      writeThrough: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.map(({ code }) => code)).toContain(2322);
    expect(result.outputs.size).toBe(0);
  });

  test("returns a structured project diagnostic when a provider fails", () => {
    const project = fixture("export const value = 1;");
    const result = runConfiguredProjectCommand({
      command: "check",
      configPath: project.config,
      expansionProvider: {
        expandProject: () => {
          throw new Error("deliberate expansion failure");
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.diagnostics).toMatchObject([
      { code: 6201, messageText: expect.stringContaining("deliberate") },
    ]);
    expect(result.outputs.size).toBe(0);
  });
});
