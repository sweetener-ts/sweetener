import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createSweetenerSession,
  describeDiagnostics,
} from "@sweetener/compiler";
import ts from "typescript";

const sweetExtension = /\.s(?:ts|js)x?$/u;

export interface SweetenerHooks {
  resolve(
    specifier: string,
    context: { readonly parentURL?: string | undefined },
    nextResolve: (
      specifier: string,
      context: unknown,
    ) => { readonly url: string },
  ): { readonly url: string; readonly shortCircuit?: boolean };
  load(
    url: string,
    context: unknown,
    nextLoad: (
      url: string,
      context: unknown,
    ) => { readonly source?: string | undefined },
  ): {
    readonly format?: string | undefined;
    readonly source?: string | undefined;
    readonly shortCircuit?: boolean;
  };
}

/**
 * Loader hooks that expand Sweetener sources as they are imported.
 *
 * Synchronous throughout, because the loader hooks Deno implements cannot
 * await. Expansion is synchronous work anyway — it reads from disk and runs
 * the compiler — so nothing is given up by saying so.
 */
export function createSweetenerHooks(
  options: { readonly configFile?: string | undefined } = {},
): SweetenerHooks {
  const session = createSweetenerSession();
  return {
    resolve(specifier, context, nextResolve) {
      // A relative import of a Sweetener source resolves like any other file;
      // without this the runtime rejects the extension before the load hook
      // is ever reached.
      if (sweetExtension.test(specifier))
        return {
          url: new URL(specifier, context.parentURL ?? import.meta.url).href,
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const filename = url.startsWith("file:") ? fileURLToPath(url) : url;
      if (!sweetExtension.test(filename)) return nextLoad(url, context);
      const expanded = session.transformSync({
        code: readFileSync(filename, "utf8"),
        filename,
        ...(options.configFile === undefined
          ? {}
          : { configFile: options.configFile }),
        mode: "development",
      });
      if (expanded.diagnostics.length > 0)
        throw new Error(
          expanded.diagnostics
            .map(
              ({ code, messageText }) =>
                `SWR${String(code)} ${String(messageText)}`,
            )
            .join("\n"),
        );
      // Nothing on this path resolves names, so a sentence expansion holds
      // about a name it left standing is said here or nowhere. It does not
      // refuse the module: see `SweetenerTransformResult.warnings`.
      if (expanded.warnings.length > 0)
        process.emitWarning(describeDiagnostics(expanded.warnings));
      // The hook must hand back something the runtime will execute, and what
      // expansion produces is TypeScript.
      const emitted = ts.transpileModule(expanded.code, {
        fileName: expanded.virtualFilename,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2024,
          jsx: ts.JsxEmit.ReactJSX,
          sourceMap: false,
        },
      });
      return {
        format: "module",
        source: emitted.outputText,
        shortCircuit: true,
      };
    },
  };
}
