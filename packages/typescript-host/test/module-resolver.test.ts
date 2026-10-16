import type { SourceId } from "@sweetener/shared";
import { describe, expect, test } from "vitest";
import {
  resolveMacroProject,
  resolveSourceMacroImports,
  type MacroModuleDependency,
  type MacroModuleSource,
} from "../src/index.js";

let nextSource = 900;
function module(
  path: string,
  dependencies: readonly MacroModuleDependency[] = [],
  exports: readonly string[] = [],
  languageVersion = "1",
): MacroModuleSource {
  return {
    path,
    sourceId: nextSource++ as SourceId,
    manifest: {
      formatVersion: 1,
      name: path,
      languageVersion,
      compiler: { minimum: "1.0.0", maximum: "2.0.0" },
      entry: path,
      exports: Object.fromEntries(
        exports.map((name) => [
          name,
          { source: path, category: "expr", phase: 1 },
        ]),
      ),
      dependencies,
    },
  };
}

function resolve(modules: readonly MacroModuleSource[], aliases = {}) {
  return resolveMacroProject({
    entry: "/app/main.sts",
    languageVersion: "1",
    compilerVersion: "1.5.0",
    modules,
    ...aliases,
  });
}

describe("macro module resolution", () => {
  test("binds source imports to manifest exports with aliases and exact origins", () => {
    const origin = {
      sourceId: 999 as SourceId,
      start: 12,
      end: 18,
    };
    const result = resolveSourceMacroImports({
      entry: "/app/main.sts",
      imports: [
        {
          specifier: "@forms/control",
          bindings: [
            { imported: "when", local: "ifForm", origin },
            { imported: "missing", local: "missing", origin },
          ],
        },
        {
          specifier: "@forms/control",
          bindings: [{ imported: "when", local: "ifForm", origin }],
        },
      ],
      aliases: [{ pattern: "@forms/*", targets: ["/macros/*.sts"] }],
      modules: [module("/macros/control.sts", [], ["when"])],
    });

    expect(result.bindings).toMatchObject([
      {
        modulePath: "/macros/control.sts",
        imported: "when",
        local: "ifForm",
        export: { category: "expr", phase: 1 },
        origin,
      },
    ]);
    expect(result.dependencies).toEqual([
      {
        specifier: "@forms/control",
        kind: "macro",
        exports: ["missing", "when"],
      },
      {
        specifier: "@forms/control",
        kind: "macro",
        exports: ["when"],
      },
    ]);
    expect(result.diagnostics).toMatchObject([
      { code: "SWR5004", primaryOrigin: origin },
      { code: "SWR5007", primaryOrigin: origin },
    ]);
  });

  test("resolves relative, alias, and package exports into separate graphs", () => {
    const result = resolve(
      [
        module("/app/main.sts", [
          { kind: "macro", specifier: "./local.sts", exports: ["local"] },
          {
            kind: "macro",
            specifier: "@local/control.sts",
            exports: ["ifElse"],
          },
          { kind: "macro", specifier: "@scope/forms", exports: ["doSteps"] },
          { kind: "runtime", specifier: "./runtime.ts", exports: [] },
        ]),
        module("/app/local.sts", [], ["local"]),
        module("/macros/control.sts", [], ["ifElse"]),
        module("/vendor/forms.sts", [], ["doSteps"]),
        module("/app/runtime.ts"),
      ],
      {
        aliases: [{ pattern: "@local/*", targets: ["/macros/*"] }],
        packages: [
          { name: "@scope/forms", exports: { ".": "/vendor/forms.sts" } },
        ],
      },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.modules.map(({ path }) => path)).toEqual([
      "/app/local.sts",
      "/app/main.sts",
      "/macros/control.sts",
      "/vendor/forms.sts",
    ]);
    expect(result.macroGraph.edges).toHaveLength(3);
    expect(result.runtimeGraph.edges).toEqual([
      { from: "/app/main.sts", to: "/app/runtime.ts" },
    ]);
  });

  test("reports exact missing, export, and version diagnostic codes", () => {
    const result = resolve([
      module("/app/main.sts", [
        { kind: "macro", specifier: "./old.sts", exports: ["missing"] },
        { kind: "macro", specifier: "./absent.sts", exports: [] },
      ]),
      module("/app/old.sts", [], ["present"], "0"),
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "SWR5004",
      "SWR5003",
      "SWR5002",
    ]);
  });

  test("rejects ambiguous aliases and macro cycles but permits runtime cycles", () => {
    const result = resolve(
      [
        module("/app/main.sts", [
          { kind: "macro", specifier: "./b.sts", exports: [] },
          { kind: "runtime", specifier: "./main.sts", exports: [] },
          { kind: "macro", specifier: "forms", exports: [] },
        ]),
        module("/app/b.sts", [
          { kind: "macro", specifier: "./main.sts", exports: [] },
        ]),
        module("/x.sts"),
        module("/y.sts"),
      ],
      { aliases: [{ pattern: "forms", targets: ["/x.sts", "/y.sts"] }] },
    );
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      "SWR5005",
      "SWR5006",
    ]);
    expect(result.runtimeGraph.edges).toContainEqual({
      from: "/app/main.sts",
      to: "/app/main.sts",
    });
  });

  test("takes a host's answer for each module in place of aliases and packages", () => {
    // Two modules import "forms" and the host found it in different places
    // for each; aliases naming both targets would have made it ambiguous.
    const found = new Map([
      ["/app/main.sts", new Map([["forms", "/x.sts"]])],
      ["/app/b.sts", new Map([["forms", "/y.sts"]])],
    ]);
    const result = resolveMacroProject({
      entry: "/app/main.sts",
      languageVersion: "1",
      compilerVersion: "1.5.0",
      modules: [
        module("/app/main.sts", [
          { kind: "macro", specifier: "forms", exports: [] },
          { kind: "macro", specifier: "./b.sts", exports: [] },
        ]),
        module("/app/b.sts", [
          { kind: "macro", specifier: "forms", exports: [] },
        ]),
        module("/x.sts"),
        module("/y.sts"),
      ],
      aliases: [{ pattern: "forms", targets: ["/x.sts", "/y.sts"] }],
      resolve: (from, specifier) =>
        specifier === "./b.sts"
          ? "/app/b.sts"
          : found.get(from)?.get(specifier),
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.macroGraph.edges).toEqual([
      { from: "/app/b.sts", to: "/y.sts" },
      { from: "/app/main.sts", to: "/app/b.sts" },
      { from: "/app/main.sts", to: "/x.sts" },
    ]);
  });

  test("prefers the longest matching path alias and checks compiler ranges", () => {
    const main = module("/app/main.sts", [
      { kind: "macro", specifier: "@forms/specific/value.sts", exports: [] },
    ]);
    const compatibleMain: MacroModuleSource = {
      ...main,
      manifest: {
        ...main.manifest,
        compiler: { minimum: "1.0.0", maximum: "4.0.0" },
      },
    };
    const result = resolveMacroProject({
      entry: "/app/main.sts",
      languageVersion: "1",
      compilerVersion: "3.0.0",
      aliases: [
        { pattern: "@forms/*", targets: ["/broad/*"] },
        { pattern: "@forms/specific/*", targets: ["/specific/*"] },
      ],
      modules: [
        compatibleMain,
        module("/broad/specific/value.sts"),
        module("/specific/value.sts"),
      ],
    });
    expect(result.macroGraph.edges).toEqual([
      { from: "/app/main.sts", to: "/specific/value.sts" },
    ]);
    expect(result.diagnostics).toMatchObject([
      { code: "SWR5003", stage: "modules" },
    ]);
  });
});
