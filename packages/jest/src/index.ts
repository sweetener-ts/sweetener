import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { transformAsync, type PluginAPI, type PluginObject } from "@babel/core";
import typescript from "@babel/preset-typescript";
import {
  createSweetenerSession,
  describeDiagnostics,
  discoverSweetConfig,
  loadSweetProject,
  type SweetenerSession,
} from "@sweetener/compiler";

/** The governing config, or nothing when the file has none to find. */
function discoverSweetConfigFor(sourcePath: string): string | undefined {
  try {
    return discoverSweetConfig(sourcePath);
  } catch {
    return undefined;
  }
}

/**
 * A Babel plugin that has the module say `sentences` before anything else in
 * it runs.
 *
 * Jest keeps what a transformer returned and serves it without calling the
 * transformer again until the file or its macros change, so anything said
 * while transforming was said on the first run and never after. Said by the
 * module, it travels with the cached code and is printed wherever a test
 * loads it -- ahead of the error its name throws, if it throws. Inserted by
 * Babel, after any directive and with the source map kept, rather than
 * prepended to the text.
 */
function warnWhenLoaded(sentences: string) {
  return ({ types: t }: PluginAPI): PluginObject => ({
    visitor: {
      Program(path) {
        path.unshiftContainer(
          "body",
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier("console"), t.identifier("warn")),
              [t.stringLiteral(sentences)],
            ),
          ),
        );
      },
    },
  });
}

interface TransformerConfig {
  readonly configFile?: string | undefined;
}

interface JestTransformOptions {
  readonly config: { readonly rootDir: string };
  readonly transformerConfig: TransformerConfig;
}

/**
 * The session a worker expands through. A file's cache key is computed from
 * the expansion it is then transformed with, and the session keeps that
 * expansion, so the second ask reads nothing again.
 */
let workerSession: SweetenerSession | undefined;
const sessionFor = (): SweetenerSession =>
  (workerSession ??= createSweetenerSession());

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
    // text, whether the config was passed or discovered. Hashed only for a
    // passed configFile, a project without one would serve an expansion from
    // before its macros were edited, and keep passing tests that should fail.
    const configFile =
      options.transformerConfig.configFile ??
      discoverSweetConfigFor(sourcePath);
    if (configFile !== undefined) {
      const project = loadSweetProject(configFile);
      hash.update(readFileSync(configFile));
      for (const file of [...project.typescript.fileNames].sort())
        hash.update(readFileSync(file));
    }
    // A macro module the config does not list -- one an installed or a
    // workspace package exports -- is read all the same, and so is whatever
    // it imports; and a module looked for and not found may appear. Each is
    // an input the key has to change with, and only the expansion knows
    // them.
    const expanded = await sessionFor().transform({
      code: sourceText,
      filename: sourcePath,
      configFile: options.transformerConfig.configFile,
      mode: "test",
    });
    for (const file of [...expanded.dependencies].sort()) {
      hash.update(file);
      hash.update(readFileSync(file));
    }
    for (const missing of [...expanded.missingDependencies].sort())
      hash.update(missing);
    return hash.digest("hex");
  },
  async processAsync(
    sourceText: string,
    sourcePath: string,
    options: JestTransformOptions,
  ): Promise<{ code: string; map?: unknown }> {
    const expanded = await sessionFor().transform({
      code: sourceText,
      filename: sourcePath,
      configFile: options.transformerConfig.configFile,
      mode: "test",
    });
    if (expanded.diagnostics.length > 0)
      throw new Error(describeDiagnostics(expanded.diagnostics));
    // Nothing on this path resolves names, so a sentence expansion holds
    // about a name it left standing is said here or nowhere. It does not
    // fail the file: see `SweetenerTransformResult.warnings`.
    const warnings =
      expanded.warnings.length > 0
        ? [warnWhenLoaded(describeDiagnostics(expanded.warnings))]
        : [];
    const babel = await transformAsync(expanded.code, {
      filename: expanded.virtualFilename,
      presets: [typescript],
      plugins: warnings,
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
  },
};

export default transformer;
