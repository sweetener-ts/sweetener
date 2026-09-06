import type { PrintedExpandedFile } from "@sweetener/printer";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import {
  proveIncrementalEquivalence,
  type PreparedSweetProject,
  type ProjectCommandResult,
} from "../src/index.js";

function project(
  text: string,
  id = "app",
  references: readonly string[] = [],
): PreparedSweetProject {
  const generated: PrintedExpandedFile = {
    text,
    originMap: { schemaVersion: 1, entries: [] },
    tokenSpans: [],
    trace: [],
    serializedTrace: "[]\n",
  };
  return {
    id,
    rootNames: [`/virtual/equivalence/${id}.ts`],
    compilerOptions: {
      strict: true,
      declaration: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      outDir: `/virtual/equivalence/${id}-dist`,
    },
    files: [{ fileName: `/virtual/equivalence/${id}.ts`, generated }],
    references,
    dependencies:
      id === "app"
        ? [
            "call-site",
            "macro-definition",
            "runtime-only",
            "whitespace",
            "configuration",
            "typescript-version",
          ]
        : [],
  };
}

describe("incremental equivalence protocol", () => {
  test("matches clean artifacts and exact invalidation sets for every required edit class", () => {
    const cases = [
      ["call-site text", "call-site", "export const value = 2;"],
      ["macro definition", "macro-definition", "export const value = 3;"],
      ["unused macro export", "unused-macro-export", "export const value = 3;"],
      ["runtime-only dependency", "runtime-only", "export const value = 4;"],
      ["whitespace", "whitespace", "export  const value = 4;"],
      ["configuration", "configuration", "export const value = 5;"],
      ["TypeScript version", "typescript-version", "export const value = 6;"],
    ] as const;
    const steps = proveIncrementalEquivalence({
      initialProjects: [
        project("export const library = 10;", "lib"),
        project("export const value = 1;", "app", ["lib"]),
      ],
      edits: cases.map(([name, dependency, text]) => ({
        name,
        projects: [
          project("export const library = 10;", "lib"),
          project(text, "app", ["lib"]),
        ],
        changedDependencies: [dependency],
        expectedInvalidatedProjects:
          dependency === "unused-macro-export" ? [] : ["app"],
      })),
      runtime: (result: ProjectCommandResult) =>
        [...result.outputs.entries()]
          .filter(([name]) => name.endsWith(".js"))
          .map(([name, source]) => {
            const exports = {};
            runInNewContext(source, { exports, module: { exports } });
            return [name, exports];
          }),
    });
    expect(steps.map(({ name }) => name)).toEqual(cases.map(([name]) => name));
    expect(steps.every(({ runtime }) => Array.isArray(runtime))).toBe(true);
    // Still the slowest test in the suite — it builds a project clean and
    // again incrementally for every edit class — but sharing the parsed
    // library files across programs left it well inside this.
  }, 60_000);
});
