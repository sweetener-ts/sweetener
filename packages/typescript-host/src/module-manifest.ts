import type { Diagnostic, SourceId } from "@sweetener/shared";
import type { SyntaxCategory } from "@sweetener/syntax";
import {
  invalidMacroManifestCode,
  moduleDiagnosticRegistry,
} from "./module-diagnostics.js";

export const macroModuleFormatVersion = 1 as const;

export type MacroDependencyKind = "macro" | "runtime";

export interface MacroModuleExport {
  readonly source: string;
  readonly category: SyntaxCategory;
  readonly phase: number;
}

export interface MacroModuleDependency {
  readonly specifier: string;
  readonly kind: MacroDependencyKind;
  readonly exports: readonly string[];
}

export interface DeclarativeMacroManifest {
  readonly formatVersion: typeof macroModuleFormatVersion;
  readonly name: string;
  readonly languageVersion: string;
  readonly compiler: { readonly minimum: string; readonly maximum: string };
  readonly entry: string;
  readonly exports: Readonly<Record<string, MacroModuleExport>>;
  readonly dependencies: readonly MacroModuleDependency[];
}

export interface ParseMacroModuleManifestResult {
  readonly manifest: DeclarativeMacroManifest | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const categories = new Set<SyntaxCategory>([
  "item",
  "stmt",
  "expr",
  "type",
  "binding",
  "classElement",
  "typeMember",
  "jsxChild",
  "token",
  "tt",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function version(value: unknown, wildcard = false): value is string {
  return (
    typeof value === "string" &&
    (wildcard ? /^\d+\.\d+\.(?:\d+|x)$/u : /^\d+\.\d+\.\d+$/u).test(value)
  );
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): readonly string[] {
  const accepted = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !accepted.has(key))
    .sort();
}

export function parseMacroModuleManifest(
  value: unknown,
  options: { readonly sourceId: SourceId; readonly label?: string },
): ParseMacroModuleManifestResult {
  const problems: string[] = [];
  if (!record(value)) problems.push("manifest must be an object");
  const input = record(value) ? value : {};
  for (const key of unknownKeys(input, [
    "formatVersion",
    "name",
    "languageVersion",
    "compiler",
    "entry",
    "exports",
    "dependencies",
  ]))
    problems.push(`unknown field ${key}`);
  if (input["formatVersion"] !== macroModuleFormatVersion)
    problems.push(`formatVersion must be ${macroModuleFormatVersion}`);
  for (const field of ["name", "languageVersion", "entry"] as const)
    if (!nonempty(input[field])) problems.push(`${field} must be nonempty`);
  const compiler = record(input["compiler"]) ? input["compiler"] : {};
  if (!version(compiler["minimum"]) || !version(compiler["maximum"], true))
    problems.push("compiler minimum and maximum must be semantic versions");
  for (const key of unknownKeys(compiler, ["minimum", "maximum"]))
    problems.push(`unknown compiler field ${key}`);
  const exportInput = record(input["exports"]) ? input["exports"] : {};
  const exports: Record<string, MacroModuleExport> = {};
  for (const [name, candidate] of Object.entries(exportInput).sort()) {
    if (
      !nonempty(name) ||
      !record(candidate) ||
      !nonempty(candidate["source"]) ||
      !categories.has(candidate["category"] as SyntaxCategory) ||
      !Number.isSafeInteger(candidate["phase"]) ||
      (candidate["phase"] as number) < 0
    ) {
      problems.push(`invalid export ${name}`);
      continue;
    }
    for (const key of unknownKeys(candidate, ["source", "category", "phase"]))
      problems.push(`unknown export ${name} field ${key}`);
    exports[name] = Object.freeze({
      source: candidate["source"],
      category: candidate["category"] as SyntaxCategory,
      phase: candidate["phase"] as number,
    });
  }
  const dependencyInput = Array.isArray(input["dependencies"])
    ? input["dependencies"]
    : [];
  const dependencies: MacroModuleDependency[] = [];
  for (const [index, candidate] of dependencyInput.entries()) {
    if (
      !record(candidate) ||
      !nonempty(candidate["specifier"]) ||
      (candidate["kind"] !== "macro" && candidate["kind"] !== "runtime") ||
      !Array.isArray(candidate["exports"]) ||
      !candidate["exports"].every(nonempty)
    ) {
      problems.push(`invalid dependency ${String(index)}`);
      continue;
    }
    for (const key of unknownKeys(candidate, ["specifier", "kind", "exports"]))
      problems.push(`unknown dependency ${String(index)} field ${key}`);
    dependencies.push(
      Object.freeze({
        specifier: candidate["specifier"],
        kind: candidate["kind"],
        exports: Object.freeze([...candidate["exports"]].sort()),
      }),
    );
  }
  if (problems.length > 0) {
    return Object.freeze({
      manifest: undefined,
      diagnostics: Object.freeze(
        problems.map((problem) =>
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: { sourceId: options.sourceId, start: 0, end: 0 },
            messageArguments: [options.label ?? "<manifest>", problem],
          }),
        ),
      ),
    });
  }
  return Object.freeze({
    manifest: Object.freeze({
      formatVersion: macroModuleFormatVersion,
      name: input["name"] as string,
      languageVersion: input["languageVersion"] as string,
      compiler: Object.freeze({
        minimum: compiler["minimum"] as string,
        maximum: compiler["maximum"] as string,
      }),
      entry: input["entry"] as string,
      exports: Object.freeze(exports),
      dependencies: Object.freeze(dependencies),
    }),
    diagnostics: Object.freeze([]),
  });
}
