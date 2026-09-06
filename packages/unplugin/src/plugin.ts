import { createSweetenerSession, stripTypes } from "@sweetener/compiler";
import { createUnplugin } from "unplugin";

export interface SweetenerPluginOptions {
  readonly configFile?: string | undefined;
  readonly include?: RegExp | undefined;
}

const defaultInclude = /\.s(?:ts|js)x?(?:\?.*)?$/u;

/** The loader name a host that understands TypeScript should read output as. */
function loaderFor(filename: string): "ts" | "tsx" | "js" | "jsx" {
  if (/\.stsx$/u.test(filename)) return "tsx";
  if (/\.sts$/u.test(filename)) return "ts";
  if (/\.sjsx$/u.test(filename)) return "jsx";
  return "js";
}

/**
 * Hosts that cannot read the TypeScript expansion produces.
 *
 * Expansion emits TypeScript, and only some hosts can take it from here. Vite
 * runs its own Oxc transform in the entry point beside this one; esbuild and
 * Bun are told the loader to use and strip types themselves. The rest have no
 * TypeScript at all, and were handed `export const x: T = ...` — which they
 * reported as `'const' declarations must be initialized`, an error naming
 * neither Sweetener nor types. Their fixtures were untyped, so nothing caught
 * it. These hosts get the types stripped for them.
 */
const stripsTypeScript = new Set([
  "rollup",
  "rolldown",
  "webpack",
  "rspack",
  "rsbuild",
  "farm",
  "unloader",
]);

export const sweetenerUnplugin = createUnplugin<
  SweetenerPluginOptions | undefined
>((options = {}, meta) => {
  const session = createSweetenerSession();
  const include = options.include ?? defaultInclude;
  return {
    name: "sweetener",
    enforce: "pre",
    bun: {
      loader(_code, id) {
        return loaderFor(id.replace(/[?#].*$/u, ""));
      },
    },
    // esbuild reads what a plugin returns with the loader named here, so it
    // strips the expansion's types itself rather than being handed JavaScript
    // and losing its own target and JSX settings.
    esbuild: {
      loader(_code, id) {
        return loaderFor(id.replace(/[?#].*$/u, ""));
      },
    },
    async transform(code, id) {
      const filename = id.replace(/[?#].*$/u, "");
      if (!include.test(id)) return;
      try {
        const result = await session.transform({
          code,
          filename,
          configFile: options.configFile,
          mode: "development",
        });
        for (const dependency of result.dependencies)
          this.addWatchFile(dependency);
        if (result.diagnostics.length > 0) {
          const message = result.diagnostics
            .map(
              ({ code: diagnosticCode, messageText }) =>
                `SWR${String(diagnosticCode)} ${String(messageText)}`,
            )
            .join("\n");
          this.error(message);
        }
        const emitted = stripsTypeScript.has(meta.framework)
          ? stripTypes(result, {
              filename,
              configFile: options.configFile,
            })
          : { code: result.code, map: undefined };
        const map = emitted.map ?? result.map;
        return {
          code: emitted.code,
          // Build tools commonly enrich maps in place, so do not expose the
          // compiler session's immutable cached value directly.
          map: {
            ...map,
            sources: [...map.sources],
            sourcesContent: [...(map.sourcesContent ?? [])],
            names: [...map.names],
          },
        };
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.error(meta.framework === "farm" ? normalized.message : normalized);
      }
    },
    watchChange(id) {
      session.invalidate([id]);
    },
  };
});

export const vite = sweetenerUnplugin.vite;
export const rollup = sweetenerUnplugin.rollup;
export const rolldown = sweetenerUnplugin.rolldown;
export const webpack = sweetenerUnplugin.webpack;
export const rspack = sweetenerUnplugin.rspack;
export const rsbuild = sweetenerUnplugin.rsbuild;
export const esbuild = sweetenerUnplugin.esbuild;
export const bun = sweetenerUnplugin.bun;
