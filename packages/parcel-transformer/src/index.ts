import SourceMapModule from "@parcel/source-map";
import { Transformer } from "@parcel/plugin";
import {
  createSweetenerSession,
  describeDiagnostics,
} from "@sweetener/compiler";

const session = createSweetenerSession();

interface SweetenerTransformerConfig {
  readonly configFile?: string | undefined;
}

export default new Transformer({
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
