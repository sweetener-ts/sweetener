// This entry is CommonJS on purpose, and it is the only reason Parcel builds
// with this plugin no longer start cold.
//
// Parcel loads a plugin through its own package manager. A CommonJS plugin is
// loaded with a patched `require`, so Parcel sees each dependency as it is
// asked for and knows exactly what to invalidate on. An ES module plugin is
// loaded with `import()`, which Parcel cannot intercept, so instead it parses
// the plugin's entire module graph ahead of time. This plugin's graph reaches
// the TypeScript compiler, whose bundle calls `require` on computed paths, and
// a graph Parcel cannot read statically is one it gives up on: it warns that
// the plugin "contains non-statically analyzable dependencies in its module
// graph" and invalidates its cache on every startup. There is no honest way to
// hide TypeScript from that analysis — Parcel follows literal `import`,
// `import()` and `require` alike, so deferring the load changes nothing, and
// naming the compiler through a variable only moves the warning onto this file.
// Being CommonJS skips the analysis altogether, and it is what Parcel asks for:
// it also warns that ES module plugins are experimental.
//
// The compiler is ES-module-only, which is why it is reached by `import()` from
// inside the hooks rather than by an import at the top. It is loaded once per
// process, on the first file transformed, so no file pays for it twice.
import PluginAPI = require("@parcel/plugin");
import SourceMapModule = require("@parcel/source-map");

type Compiler = typeof import("@sweetener/compiler");

interface LoadedCompiler {
  readonly session: ReturnType<Compiler["createSweetenerSession"]>;
  readonly describeDiagnostics: Compiler["describeDiagnostics"];
}

interface SweetenerTransformerConfig {
  readonly configFile?: string | undefined;
}

let loading: Promise<LoadedCompiler> | undefined;

const loadCompiler = (): Promise<LoadedCompiler> =>
  (loading ??= import("@sweetener/compiler").then((compiler) => ({
    session: compiler.createSweetenerSession(),
    describeDiagnostics: compiler.describeDiagnostics,
  })));

const transformer = new PluginAPI.Transformer({
  // Read from .sweetenerrc / a `sweetener` key, so a project whose macros are
  // described by something other than a tsconfig beside them can say where.
  // Without this there was no way to point the transformer at a config at all.
  async loadConfig({ config }) {
    const found = await config.getConfig<SweetenerTransformerConfig>(
      [".sweetenerrc", ".sweetenerrc.json"],
      { packageKey: "sweetener" },
    );
    return found?.contents ?? {};
  },

  async transform({ asset, options, config }) {
    const configFile = (config as SweetenerTransformerConfig | undefined)
      ?.configFile;
    const { session, describeDiagnostics } = await loadCompiler();
    const result = await session.transform({
      code: await asset.getCode(),
      filename: asset.filePath,
      ...(configFile === undefined ? {} : { configFile }),
      mode: options.mode === "production" ? "production" : "development",
    });
    if (result.diagnostics.length > 0)
      throw new Error(describeDiagnostics(result.diagnostics));
    for (const dependency of result.dependencies)
      asset.invalidateOnFileChange(dependency);
    asset.type = result.virtualFilename.endsWith("x") ? "tsx" : "ts";
    asset.setCode(result.code);
    const map = new SourceMapModule.default(options.projectRoot);
    map.addVLQMap({
      ...result.map,
      sources: [...result.map.sources],
      sourcesContent: [...(result.map.sourcesContent ?? [])],
      names: [...result.map.names],
    });
    asset.setMap(map);
    return [asset];
  },
});

export = transformer;
