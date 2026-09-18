import { readFile } from "node:fs/promises";
import type { BunPlugin, Loader } from "bun";
import {
  createSweetenerSession,
  describeDiagnostics,
} from "@sweetener/compiler";
import type { SweetenerPluginOptions } from "./plugin.js";

const sweetExtension = /\.s(?:ts|js)x?$/u;

function loader(filename: string): Loader {
  if (filename.endsWith(".stsx")) return "tsx";
  if (filename.endsWith(".sts")) return "ts";
  if (filename.endsWith(".sjsx")) return "jsx";
  return "js";
}

/** A synchronous-setup plugin that works with both Bun.build and Bun.plugin. */
export default function sweetener(
  options: SweetenerPluginOptions = {},
): BunPlugin {
  const session = createSweetenerSession();
  const include = options.include ?? sweetExtension;
  return {
    name: "sweetener",
    setup(build) {
      build.onLoad({ filter: include }, async ({ path }) => {
        const code = await readFile(path, "utf8");
        const result = await session.transform({
          code,
          filename: path,
          configFile: options.configFile,
          mode: "development",
        });
        if (result.diagnostics.length > 0)
          throw new Error(
            result.diagnostics
              .map(
                ({ code: diagnosticCode, messageText }) =>
                  `SWR${String(diagnosticCode)} ${String(messageText)}`,
              )
              .join("\n"),
          );
        // Nothing on this path resolves names, so a sentence expansion
        // holds about a name it left standing is said here or nowhere. It is
        // a warning: see `SweetenerTransformResult.warnings`.
        if (result.warnings.length > 0)
          process.emitWarning(describeDiagnostics(result.warnings));
        return { contents: result.code, loader: loader(path) };
      });
    },
  };
}
