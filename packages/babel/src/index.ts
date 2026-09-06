import { readFile } from "node:fs/promises";
import {
  transformAsync,
  type FileResult,
  type InputOptions,
} from "@babel/core";
import {
  createSweetenerSession,
  describeDiagnostics,
} from "@sweetener/compiler";

export interface SweetenerBabelOptions {
  readonly configFile?: string | undefined;
  readonly babel?: InputOptions | undefined;
}

export async function transformSweetenerFile(
  filename: string,
  options: SweetenerBabelOptions = {},
): Promise<FileResult> {
  const session = createSweetenerSession();
  try {
    const expanded = await session.transform({
      code: await readFile(filename, "utf8"),
      filename,
      configFile: options.configFile,
      mode: "production",
    });
    if (expanded.diagnostics.length > 0)
      throw new Error(describeDiagnostics(expanded.diagnostics));
    const transformed = await transformAsync(expanded.code, {
      ...options.babel,
      filename: expanded.virtualFilename,
      inputSourceMap: {
        ...expanded.map,
        file: expanded.map.file ?? expanded.virtualFilename,
        sources: [...expanded.map.sources],
        sourcesContent: (expanded.map.sourcesContent ?? []).map(
          (content) => content ?? "",
        ),
        names: [...expanded.map.names],
      },
      sourceMaps: options.babel?.sourceMaps ?? true,
    });
    if (transformed === null) throw new Error("Babel produced no result");
    return transformed;
  } finally {
    await session.close();
  }
}
