import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createSweetenerSession,
  describeDiagnostics,
} from "@sweetener/compiler";
import type { RawSourceMap } from "@sweetener/typescript-host";
import ts from "typescript";

const session = createSweetenerSession();
const sweetExtension = /\.s(?:ts|js)x?$/u;

/**
 * Resolve and load hooks for Sweetener sources.
 *
 * Synchronous, so the same two functions serve both ways Node installs hooks:
 * `module.registerHooks` runs them on the loading thread and requires them to
 * return directly, and `module.register` runs them on its own thread and
 * accepts a direct return as readily as a promise. Anything that is not a
 * Sweetener source is handed on untouched, and what the next hook returns —
 * a value under one, a promise under the other — goes back as it came.
 */
export function resolve<
  Context extends { readonly parentURL?: string | undefined },
  Next,
>(
  specifier: string,
  context: Context,
  nextResolve: (specifier: string, context: Context) => Next,
): Next | { readonly url: string; readonly shortCircuit: true } {
  if (sweetExtension.test(specifier))
    return {
      url: new URL(
        specifier,
        context.parentURL ?? pathToFileURL(`${process.cwd()}/`).href,
      ).href,
      shortCircuit: true,
    };
  return nextResolve(specifier, context);
}

export function load<Context, Next>(
  url: string,
  context: Context,
  nextLoad: (url: string, context: Context) => Next,
):
  | Next
  | {
      readonly format: "module";
      readonly source: string;
      readonly shortCircuit: true;
    } {
  const filename = url.startsWith("file:") ? fileURLToPath(url) : url;
  if (!sweetExtension.test(filename)) return nextLoad(url, context);
  const expanded = session.transformSync({
    code: readFileSync(filename, "utf8"),
    filename,
    mode: "development",
  });
  if (expanded.diagnostics.length > 0)
    throw new Error(
      expanded.diagnostics
        .map(({ messageText }) => String(messageText))
        .join("\n"),
    );
  // Nothing on this path resolves names, so a sentence expansion holds about a
  // name it left standing is said here or nowhere. It does not refuse the
  // module: see `SweetenerTransformResult.warnings`.
  if (expanded.warnings.length > 0)
    process.emitWarning(describeDiagnostics(expanded.warnings));
  const emitted = ts.transpileModule(expanded.code, {
    fileName: expanded.virtualFilename,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2024,
      sourceMap: true,
    },
  });
  return {
    format: "module",
    source: withSourceMap(expanded, emitted),
    shortCircuit: true,
  };
}

/**
 * Attach a map reaching the `.sts`, so a stack trace names a real line.
 *
 * Node is handed expanded, type-stripped JavaScript under the original file
 * name, and without a map `--enable-source-maps` has nothing to correct: every
 * frame would be reported at its position in the expansion, off by however
 * many lines the compile-time import and the macro definitions occupy, and the
 * frame Node prints would be read from the `.sts` at that wrong line.
 */
function withSourceMap(
  expanded: { composeMap(map: RawSourceMap): RawSourceMap | undefined },
  emitted: ts.TranspileOutput,
): string {
  if (emitted.sourceMapText === undefined) return emitted.outputText;
  let composed: RawSourceMap | undefined;
  try {
    composed = expanded.composeMap(
      JSON.parse(emitted.sourceMapText) as RawSourceMap,
    );
  } catch {
    composed = undefined;
  }
  if (composed === undefined) return emitted.outputText;
  const encoded = Buffer.from(JSON.stringify(composed), "utf8").toString(
    "base64",
  );
  // The map TypeScript emitted names a file nobody can open, so its own
  // comment has to go before ours is appended.
  return `${emitted.outputText.replace(/\n\/\/# sourceMappingURL=.*$/u, "")}\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`;
}
