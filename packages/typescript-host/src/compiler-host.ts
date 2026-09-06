import { dirname, resolve } from "node:path";
import type { PrintedExpandedFile } from "@sweetener/printer";
import type { RawSourceMap } from "./source-map.js";
import ts from "typescript";
import { scriptKindForFileName } from "./script-kind.js";

export interface VirtualTypeScriptFile {
  readonly fileName: string;
  readonly generated: PrintedExpandedFile;
}

export interface VirtualCompilerHost {
  readonly host: ts.CompilerHost;
  readonly outputs: ReadonlyMap<string, string>;
  generatedFor(fileName: string): PrintedExpandedFile | undefined;
}

/**
 * Rewrites a source map TypeScript emitted for a virtual file.
 *
 * TypeScript maps its output back to the expanded TypeScript it was given,
 * which is a file that exists only in memory: emitting that map unchanged
 * named a `.ts` beside the source that nobody can open, at positions in a text
 * nobody has. Composing it with the expansion's own origins is what makes the
 * emitted map describe the `.sts` the author wrote.
 */
export type SourceMapComposer = (request: {
  /** The `.js.map` or `.d.ts.map` being written. */
  readonly mapFileName: string;
  /** The virtual `.ts`/`.tsx` file the output was emitted from. */
  readonly virtualFileName: string;
  readonly map: RawSourceMap;
}) => RawSourceMap | undefined;

function canonical(fileName: string): string {
  return resolve(fileName).replaceAll("\\", "/");
}

/**
 * Parsed default-library files, shared across every program in the process.
 *
 * Each program re-read and re-parsed the whole of `lib.es2022.d.ts` and its
 * dependents — megabytes of declarations — because each got a fresh compiler
 * host with nothing behind it. They are the same files every time and they do
 * not change while the process runs: a watch rebuild, a project reference, and
 * every adapter session paid for them again. The key carries the target so two
 * projects compiled for different ones do not share a parse.
 */
const libraryFiles = new Map<string, ts.SourceFile>();
const libraryDirectory = canonical(
  dirname(ts.getDefaultLibFilePath({})),
).toLowerCase();

/** Whether a path is one of TypeScript's own immutable library declarations. */
function isLibraryFile(fileName: string): boolean {
  return canonical(fileName).toLowerCase().startsWith(`${libraryDirectory}/`);
}

export function createVirtualCompilerHost(options: {
  readonly compilerOptions: ts.CompilerOptions;
  readonly files: readonly VirtualTypeScriptFile[];
  readonly delegate?: ts.CompilerHost;
  /** Also persist emitted files through the underlying host. */
  readonly writeThrough?: boolean;
  readonly projectReferences?: readonly ts.ProjectReference[];
  readonly composeSourceMap?: SourceMapComposer | undefined;
}): VirtualCompilerHost {
  const delegate =
    options.delegate ?? ts.createCompilerHost(options.compilerOptions, true);
  const files = new Map(
    options.files.map(({ fileName, generated }) => [
      canonical(fileName),
      generated,
    ]),
  );
  if (files.size !== options.files.length)
    throw new RangeError("Duplicate virtual TypeScript file");
  const directories = new Set<string>();
  for (const fileName of files.keys()) {
    let directory = dirname(fileName);
    while (!directories.has(directory)) {
      directories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const outputs = new Map<string, string>();
  const sourceFiles = new Map<string, ts.SourceFile>();

  /** The composed text for an emitted map, or nothing to write it as it is. */
  const composed = (
    fileName: string,
    text: string,
    emittedFrom: readonly ts.SourceFile[] | undefined,
  ): string | undefined => {
    const compose = options.composeSourceMap;
    if (compose === undefined || !fileName.endsWith(".map")) return undefined;
    // Which virtual file the output came from. TypeScript hands it over, and
    // guessing from the output's name instead would not survive `outFile`.
    const virtualFileName = emittedFrom?.[0]?.fileName;
    if (virtualFileName === undefined || !files.has(canonical(virtualFileName)))
      return undefined;
    let map: RawSourceMap;
    try {
      map = JSON.parse(text) as RawSourceMap;
    } catch {
      return undefined;
    }
    const result = compose({ mapFileName: fileName, virtualFileName, map });
    return result === undefined ? undefined : JSON.stringify(result);
  };
  const host: ts.CompilerHost = {
    ...delegate,
    fileExists: (fileName) =>
      files.has(canonical(fileName)) || delegate.fileExists(fileName),
    readFile: (fileName) =>
      files.get(canonical(fileName))?.text ?? delegate.readFile(fileName),
    directoryExists: (directoryName) =>
      directories.has(canonical(directoryName)) ||
      delegate.directoryExists?.(directoryName) === true,
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNew) => {
      const path = canonical(fileName);
      const virtual = files.get(path);
      if (virtual === undefined) {
        const shared =
          shouldCreateNew !== true && isLibraryFile(fileName)
            ? `${path}\u0000${JSON.stringify(languageVersion)}`
            : undefined;
        if (shared !== undefined) {
          const cached = libraryFiles.get(shared);
          if (cached !== undefined) return cached;
        }
        const loaded = delegate.getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNew,
        );
        if (shared !== undefined && loaded !== undefined)
          libraryFiles.set(shared, loaded);
        return loaded;
      }
      if (shouldCreateNew !== true) {
        const cached = sourceFiles.get(path);
        if (cached !== undefined) return cached;
      }
      const source = ts.createSourceFile(
        fileName,
        virtual.text,
        languageVersion,
        true,
        scriptKindForFileName(fileName),
      );
      sourceFiles.set(path, source);
      return source;
    },
    getCanonicalFileName: (fileName) =>
      delegate.useCaseSensitiveFileNames()
        ? canonical(fileName)
        : canonical(fileName).toLowerCase(),
    writeFile: (fileName, text, bom, onError, sourceFiles, data) => {
      const emitted = composed(fileName, text, sourceFiles) ?? text;
      outputs.set(canonical(fileName), emitted);
      if (options.writeThrough !== false)
        delegate.writeFile(fileName, emitted, bom, onError, sourceFiles, data);
    },
  };
  return Object.freeze({
    host,
    outputs,
    generatedFor: (fileName: string) => files.get(canonical(fileName)),
  });
}

export function createVirtualProgram(options: {
  readonly rootNames: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
  readonly files: readonly VirtualTypeScriptFile[];
  readonly oldProgram?: ts.Program;
  readonly delegate?: ts.CompilerHost;
  readonly writeThrough?: boolean;
  readonly projectReferences?: readonly ts.ProjectReference[];
  readonly composeSourceMap?: SourceMapComposer | undefined;
}): {
  readonly program: ts.Program;
  readonly virtualHost: VirtualCompilerHost;
} {
  const virtualHost = createVirtualCompilerHost(options);
  const program = ts.createProgram({
    rootNames: [...options.rootNames],
    options: options.compilerOptions,
    host: virtualHost.host,
    ...(options.oldProgram === undefined
      ? {}
      : { oldProgram: options.oldProgram }),
    ...(options.projectReferences === undefined
      ? {}
      : { projectReferences: [...options.projectReferences] }),
  });
  return Object.freeze({ program, virtualHost });
}
