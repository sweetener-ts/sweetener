import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSweetenerSession } from "@sweetener/compiler";
import type { RawSourceMap } from "@sweetener/typescript-host";
import ts from "typescript";

const session = createSweetenerSession();
const sweetExtension = /\.s(?:ts|js)x?$/u;

export async function resolve(
  specifier: string,
  context: { readonly parentURL?: string | undefined },
  nextResolve: (specifier: string, context: unknown) => Promise<unknown>,
): Promise<unknown> {
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

export async function load(
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => Promise<unknown>,
): Promise<unknown> {
  const filename = url.startsWith("file:") ? fileURLToPath(url) : url;
  if (!sweetExtension.test(filename)) return nextLoad(url, context);
  const expanded = await session.transform({
    code: await readFile(filename, "utf8"),
    filename,
    mode: "development",
  });
  if (expanded.diagnostics.length > 0)
    throw new Error(
      expanded.diagnostics
        .map(({ messageText }) => String(messageText))
        .join("\n"),
    );
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
 * frame was reported at its position in the expansion, off by however many
 * lines the compile-time import and the macro definitions occupied, and the
 * frame Node printed was read from the `.sts` at that wrong line.
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
