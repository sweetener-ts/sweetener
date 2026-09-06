import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import {
  createSweetenerSession,
  describeDiagnostics,
  discoverSweetConfig,
  loadSweetProject,
} from "@sweetener/compiler";

/** The governing config, or nothing when the file has none to find. */
function discoverSweetConfigFor(sourcePath: string): string | undefined {
  try {
    return discoverSweetConfig(sourcePath);
  } catch {
    return undefined;
  }
}

interface TransformerConfig {
  readonly configFile?: string | undefined;
}

interface JestTransformOptions {
  readonly config: { readonly rootDir: string };
  readonly transformerConfig: TransformerConfig;
}

const transformer = {
  async getCacheKeyAsync(
    sourceText: string,
    sourcePath: string,
    options: JestTransformOptions,
  ): Promise<string> {
    const hash = createHash("sha256");
    hash.update(sourceText);
    hash.update(sourcePath);
    // The macros a file expands through are as much of its input as its own
    // text. Hashing these only when a configFile was passed meant a project
    // without one served an expansion from before its macros were edited, and
    // kept passing tests that should have changed.
    const configFile =
      options.transformerConfig.configFile ??
      discoverSweetConfigFor(sourcePath);
    if (configFile !== undefined) {
      const project = loadSweetProject(configFile);
      hash.update(readFileSync(configFile));
      for (const file of [...project.typescript.fileNames].sort())
        hash.update(readFileSync(file));
    }
    return hash.digest("hex");
  },
  async processAsync(
    sourceText: string,
    sourcePath: string,
    options: JestTransformOptions,
  ): Promise<{ code: string; map?: unknown }> {
    const session = createSweetenerSession();
    try {
      const expanded = await session.transform({
        code: sourceText,
        filename: sourcePath,
        configFile: options.transformerConfig.configFile,
        mode: "test",
      });
      if (expanded.diagnostics.length > 0)
        throw new Error(describeDiagnostics(expanded.diagnostics));
      const babel = await transformAsync(expanded.code, {
        filename: expanded.virtualFilename,
        presets: [typescript],
        sourceMaps: true,
        inputSourceMap: {
          ...expanded.map,
          file: expanded.map.file ?? expanded.virtualFilename,
          sources: [...expanded.map.sources],
          sourcesContent: (expanded.map.sourcesContent ?? []).map(
            (content) => content ?? "",
          ),
          names: [...expanded.map.names],
        },
      });
      if (babel?.code === undefined || babel.code === null)
        throw new Error("Babel produced no Jest transform");
      return { code: babel.code, map: babel.map };
    } finally {
      await session.close();
    }
  },
};

export default transformer;
