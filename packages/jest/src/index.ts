import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { transformAsync, type PluginAPI, type PluginObject } from "@babel/core";
import typescript from "@babel/preset-typescript";
import {
  createSweetenerSession,
  describeDiagnostics,
  discoverSweetConfig,
  loadSweetProject,
  type SweetenerSession,
} from "@sweetener/compiler";
import { packageIdentity } from "./package-identity.js";

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
  readonly config: {
    readonly rootDir: string;
    readonly cacheDirectory?: string | undefined;
  };
  readonly transformerConfig: TransformerConfig;
}

/** What one expansion of a file read, and looked for and did not find. */
interface ReadInputs {
  readonly dependencies: readonly string[];
  readonly missingDependencies: readonly string[];
}

/**
 * What a file's last expansion read, kept in Jest's cache directory beside
 * the transforms it keys.
 *
 * A key has to cover every file the expansion reads, and only an expansion
 * knows them; expanded to answer every key, a warm run expanded the whole
 * project in each worker before Jest could serve one cached transform. The
 * record is trusted while what it was written from holds -- the file's text,
 * its config and the files the config lists, which `inputs` hashes. An
 * expansion is decided by what it reads, so while those and every file it
 * read hold, and every file it looked for is still missing, it reads the
 * same files again, and the record names them.
 */
function recordPath(
  cacheDirectory: string,
  sourcePath: string,
  configFile: string | undefined,
): string {
  const name = createHash("sha256")
    .update(sourcePath)
    .update("\0")
    .update(configFile ?? "")
    .digest("hex");
  return join(cacheDirectory, "sweetener-jest", `${name}.json`);
}

function readRecord(path: string, inputs: string): ReadInputs | undefined {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Missing, or not a record at all -- damaged on disk -- which is a
    // miss, rewritten once the file is expanded, rather than a key that
    // fails on every run until the cache is cleared.
    return undefined;
  }
  return isRecord(record) && record.inputs === inputs ? record : undefined;
}

function isRecord(
  value: unknown,
): value is ReadInputs & { readonly inputs: string } {
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((each) => typeof each === "string");
  return (
    typeof value === "object" &&
    value !== null &&
    "inputs" in value &&
    typeof value.inputs === "string" &&
    "dependencies" in value &&
    strings(value.dependencies) &&
    "missingDependencies" in value &&
    strings(value.missingDependencies)
  );
}

/**
 * Written whole under a name of its own and renamed into place, so a worker
 * reading the record while another writes it reads one record or the other.
 * The name is the writer's alone: Jest's workers may be threads of one
 * process, and named by the process, two writing one record at once wrote
 * one file and renamed it twice.
 */
function writeRecord(path: string, inputs: string, read: ReadInputs): void {
  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true });
  const partial = `${path}.${String(process.pid)}.${String(threadId)}.${randomUUID()}.partial`;
  try {
    writeFileSync(
      partial,
      JSON.stringify({
        inputs,
        dependencies: [...read.dependencies],
        missingDependencies: [...read.missingDependencies],
      }),
    );
    renameSync(partial, path);
  } finally {
    // Renamed, there is nothing left to remove; failing part way, what was
    // written is not left behind in the cache directory.
    rmSync(partial, { force: true });
  }
}

/**
 * The session a worker expands through. A file's cache key is computed from
 * the expansion it is then transformed with, and the session keeps that
 * expansion, so the second ask reads nothing again.
 */
let workerSession: SweetenerSession | undefined;
const sessionFor = (): SweetenerSession =>
  (workerSession ??= createSweetenerSession());

/**
 * This transformer's release and the compiler's it expands with. Jest keeps a
 * transform until its key changes, and what a file expands to changes with
 * either: upgraded, a project was served the expansions of the release before
 * until its cache was cleared. Each package is published at one version,
 * pinning the others at it, so the versions say which code ran.
 */
let releases: string | undefined;
const releasesExpandingWith = (): string =>
  (releases ??= [
    packageIdentity(import.meta.url),
    packageIdentity(import.meta.resolve("@sweetener/compiler")),
  ].join("\0"));

/** The hash of what a record is written from; see `recordPath`. */
function inputsOf(
  sourceText: string,
  sourcePath: string,
  configFile: string | undefined,
): string {
  const hash = createHash("sha256");
  hash.update(releasesExpandingWith());
  hash.update(sourceText);
  hash.update(sourcePath);
  // The macros a file expands through are as much of its input as its own
  // text, whether the config was passed or discovered. Hashed only for a
  // passed configFile, a project without one would serve an expansion from
  // before its macros were edited, and keep passing tests that should fail.
  if (configFile !== undefined) {
    const project = loadSweetProject(configFile);
    hash.update(readFileSync(configFile));
    for (const file of [...project.typescript.fileNames].sort())
      hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

interface Record {
  readonly inputs: string;
  readonly path: string | undefined;
}

/**
 * The record the last key was computed from, and what it was asked for.
 * Jest asks for a file's key and then, where it has no transform under it,
 * for the transform, and both need the record: hashed again for the
 * transform, the config and every file it lists were read twice for each
 * file transformed. The transform takes it, and only the transform: a key
 * is always computed afresh, or a run in watch mode would key a file from
 * what its macros were the run before. One is kept, so nothing builds up
 * for the files Jest has a transform for.
 */
let lastRecord:
  | {
      readonly sourceText: string;
      readonly sourcePath: string;
      readonly configFile: string | undefined;
      readonly cacheDirectory: string | undefined;
      readonly record: Record;
    }
  | undefined;

/** Where a file's record is kept and what it is trusted against. */
function recordOf(
  sourceText: string,
  sourcePath: string,
  options: JestTransformOptions,
  reuse: "for-the-transform" | "never",
): Record {
  const { configFile: passed } = options.transformerConfig;
  const { cacheDirectory } = options.config;
  const kept = lastRecord;
  lastRecord = undefined;
  if (
    reuse === "for-the-transform" &&
    kept !== undefined &&
    kept.sourceText === sourceText &&
    kept.sourcePath === sourcePath &&
    kept.configFile === passed &&
    kept.cacheDirectory === cacheDirectory
  )
    return kept.record;
  const configFile = passed ?? discoverSweetConfigFor(sourcePath);
  const record = {
    inputs: inputsOf(sourceText, sourcePath, configFile),
    path:
      cacheDirectory === undefined
        ? undefined
        : recordPath(cacheDirectory, sourcePath, configFile),
  };
  if (reuse === "never")
    lastRecord = {
      sourceText,
      sourcePath,
      configFile: passed,
      cacheDirectory,
      record,
    };
  return record;
}

const expand = (
  sourceText: string,
  sourcePath: string,
  options: JestTransformOptions,
) =>
  sessionFor().transform({
    code: sourceText,
    filename: sourcePath,
    configFile: options.transformerConfig.configFile,
    mode: "test",
  });

const transformer = {
  async getCacheKeyAsync(
    sourceText: string,
    sourcePath: string,
    options: JestTransformOptions,
  ): Promise<string> {
    const { inputs, path } = recordOf(sourceText, sourcePath, options, "never");
    // A macro module the config does not list -- one an installed or a
    // workspace package exports -- is read all the same, and so is whatever
    // it imports; and a module looked for and not found may appear. Each is
    // an input the key has to change with, and only the expansion knows
    // them, so they are what it last read where that is recorded.
    const recorded = path === undefined ? undefined : readRecord(path, inputs);
    const read = recorded ?? (await expand(sourceText, sourcePath, options));
    if (path !== undefined && recorded === undefined)
      writeRecord(path, inputs, read);
    const hash = createHash("sha256");
    hash.update(inputs);
    for (const file of [...read.dependencies].sort()) {
      hash.update(file);
      // A file read and since removed is a change like any other.
      hash.update(existsSync(file) ? readFileSync(file) : "\0missing");
    }
    for (const missing of [...read.missingDependencies].sort()) {
      hash.update(missing);
      hash.update(existsSync(missing) ? "\0found" : "\0missing");
    }
    return hash.digest("hex");
  },
  async processAsync(
    sourceText: string,
    sourcePath: string,
    options: JestTransformOptions,
  ): Promise<{ code: string; map?: unknown }> {
    const expanded = await expand(sourceText, sourcePath, options);
    // Jest transforms where it has nothing under the key: nothing cached
    // yet, or the file or something it read changed. What this expansion
    // read is the record from now on, or a file it reads that the last did
    // not would go unwatched.
    const { inputs, path } = recordOf(
      sourceText,
      sourcePath,
      options,
      "for-the-transform",
    );
    if (path !== undefined) writeRecord(path, inputs, expanded);
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
