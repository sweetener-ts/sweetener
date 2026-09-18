import { readFile } from "node:fs/promises";
import {
  createSweetenerSession,
  describeDiagnostics,
} from "@sweetener/compiler";
import type {
  CompilationContext,
  JsPlugin,
  PluginLoadHookResult,
} from "@farmfe/core";
import type { SweetenerPluginOptions } from "./plugin.js";

const sweetExtension = /\.s(?:ts|js)x?$/u;

export default function sweetenerFarm(
  options: SweetenerPluginOptions = {},
): JsPlugin {
  const session = createSweetenerSession();
  const include = options.include ?? sweetExtension;

  const transform = async (
    code: string,
    filename: string,
    context: CompilationContext | undefined,
  ): Promise<PluginLoadHookResult | undefined> => {
    if (!include.test(filename)) return undefined;
    const result = await session.transform({
      code,
      filename,
      configFile: options.configFile,
      mode: "production",
    });
    if (result.diagnostics.length > 0)
      context?.error(
        result.diagnostics
          .map(({ messageText }) => String(messageText))
          .join("\n"),
      );
    // Nothing on this path resolves names, so a sentence expansion holds
    // about a name it left standing is said here or nowhere. It is a warning:
    // see `SweetenerTransformResult.warnings`.
    if (result.warnings.length > 0)
      context?.warn(describeDiagnostics(result.warnings));
    for (const dependency of result.dependencies)
      context?.addWatchFile(filename, dependency);
    return {
      content: result.code,
      moduleType: result.virtualFilename.endsWith("x") ? "tsx" : "ts",
      sourceMap: JSON.stringify(result.map),
    };
  };

  return {
    name: "sweetener",
    priority: 1_000,
    load: {
      filters: { resolvedPaths: [String.raw`\.s(?:ts|js)x?$`] },
      async executor({ resolvedPath }, context) {
        return transform(
          await readFile(resolvedPath, "utf8"),
          resolvedPath,
          context,
        );
      },
    },
    transform: {
      filters: { moduleTypes: ["ts", "tsx", "js", "jsx"] },
      executor({ content, resolvedPath }, context) {
        if (sweetExtension.test(resolvedPath)) return undefined;
        return transform(content, resolvedPath, context);
      },
    },
  };
}
