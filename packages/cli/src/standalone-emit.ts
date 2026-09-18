import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type * as ts from "typescript";
import { loadStandaloneProject } from "./configuration.js";
import { createDefaultProjectExpansionProvider } from "./default-expansion-provider.js";
import {
  warnAboutHeldNames,
  type ProjectExpansionOutput,
  type ProjectExpansionProvider,
} from "./project-command.js";

export interface StandaloneEmitResult {
  /** Absolute output path to expanded text. */
  readonly outputs: ReadonlyMap<string, string>;
  /**
   * Errors that stopped the expansion, and warnings about what it left
   * standing. Only an error means nothing was expanded; a warning is said
   * about output that was written.
   */
  readonly diagnostics: readonly ts.Diagnostic[];
}

/** Deepest directory containing every input, used to mirror the input tree. */
function commonDirectory(fileNames: readonly string[]): string {
  const parts = fileNames.map((fileName) => dirname(fileName).split(sep));
  const first = parts[0];
  if (first === undefined) return process.cwd();
  const shared: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index]!;
    if (!parts.every((candidate) => candidate[index] === segment)) break;
    shared.push(segment);
  }
  return shared.join(sep) || sep;
}

/**
 * Expand files and return the expanded sources, without running TypeScript.
 *
 * This is the config-free path: no `tsconfig.json`, no type checking, and no
 * downlevelling. The output is the expanded source under its ordinary
 * extension, which is what a JavaScript project that only wants macros needs.
 */
export function expandStandalone(options: {
  readonly fileNames: readonly string[];
  readonly outDir: string;
  readonly expansionProvider?: ProjectExpansionProvider | undefined;
}): StandaloneEmitResult {
  const fileNames = options.fileNames.map((fileName) => resolve(fileName));
  const provider =
    options.expansionProvider ?? createDefaultProjectExpansionProvider();
  const project = loadStandaloneProject(fileNames);
  const expanded = provider.expandProject(project);
  const output: ProjectExpansionOutput = Array.isArray(expanded)
    ? { files: expanded, diagnostics: Object.freeze([]) }
    : (expanded as ProjectExpansionOutput);
  if (output.diagnostics.length > 0)
    return Object.freeze({
      outputs: new Map<string, string>(),
      diagnostics: Object.freeze([...output.diagnostics]),
    });
  const root = commonDirectory(fileNames);
  const outDir = resolve(options.outDir);
  const outputs = new Map<string, string>();
  for (const file of output.files)
    outputs.set(
      join(outDir, relative(root, file.fileName)),
      file.generated.text,
    );
  // There is no checker on this path, so what expansion holds about a name it
  // left standing is all anyone will ever hear about it. See
  // `warnAboutHeldNames`: it is said, as a warning, and the output is written
  // either way because it is the same text either way.
  return Object.freeze({
    outputs,
    diagnostics: warnAboutHeldNames(output.unresolvedNameExplanations ?? []),
  });
}

/** Expand files and write the results under `outDir`. */
export function emitStandalone(options: {
  readonly fileNames: readonly string[];
  readonly outDir: string;
  readonly expansionProvider?: ProjectExpansionProvider | undefined;
}): StandaloneEmitResult {
  const result = expandStandalone(options);
  for (const [fileName, text] of result.outputs) {
    mkdirSync(dirname(fileName), { recursive: true });
    writeFileSync(fileName, text, "utf8");
  }
  return result;
}
