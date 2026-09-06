import { dirname, relative } from "node:path";
import type {
  SourceMapComposer,
  VirtualTypeScriptFile,
} from "@sweetener/typescript-host";
import {
  composeSourceMap,
  createVirtualProgram,
} from "@sweetener/typescript-host";
import * as ts from "typescript";
import {
  loadSweetProject,
  type LoadedSweetProject,
  type SweetConfigurationProblem,
} from "./configuration.js";
import { createDefaultProjectExpansionProvider } from "./default-expansion-provider.js";
import type { ExpansionInspectionProvider } from "./expansion-tools.js";
import { selectSweetSources } from "./source-kind.js";

export type ConfiguredProjectCommand = "check" | "build";

export interface ProjectExpansionProvider {
  /** Return expanded files under their virtual `.ts`/`.tsx` names. */
  expandProject(
    project: LoadedSweetProject,
  ): ProjectExpansionOutput | readonly VirtualTypeScriptFile[];
  macroDependencies?(project: LoadedSweetProject): readonly string[];
  debugState?(): unknown;
}

export interface ProjectExpansionOutput {
  readonly files: readonly VirtualTypeScriptFile[];
  readonly diagnostics: readonly ts.Diagnostic[];
}

export interface ConfiguredProjectCommandResult {
  readonly command: ConfiguredProjectCommand;
  readonly exitCode: 0 | 1;
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly outputs: ReadonlyMap<string, string>;
  readonly virtualFiles: readonly VirtualTypeScriptFile[];
  readonly debugState: unknown;
}

function configurationDiagnostic(
  problem: SweetConfigurationProblem,
): ts.Diagnostic {
  return Object.freeze({
    category: ts.DiagnosticCategory.Error,
    code: 6101,
    file: undefined,
    start: undefined,
    length: undefined,
    messageText: `${problem.code} ${problem.path} ${problem.message}`,
  });
}

function remapGeneratedDiagnostics(options: {
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly provider: ProjectExpansionProvider;
  readonly virtualBySource: ReadonlyMap<string, string>;
  readonly target: ts.ScriptTarget;
}): readonly ts.Diagnostic[] {
  if (!("inspectSource" in options.provider)) return options.diagnostics;
  const inspectionProvider = options.provider as ProjectExpansionProvider &
    ExpansionInspectionProvider;
  const sourceByVirtual = new Map(
    [...options.virtualBySource].map(([source, virtual]) => [virtual, source]),
  );
  const inspections = new Map(
    [...options.virtualBySource.keys()].flatMap((source) => {
      const inspection = inspectionProvider.inspectSource(source);
      return inspection === undefined ? [] : [[source, inspection] as const];
    }),
  );
  const sourceById = new Map(
    [...inspections].map(([source, inspection]) => [
      inspection.sourceId,
      source,
    ]),
  );
  const sourceFiles = new Map<string, ts.SourceFile>();
  /**
   * Where in the sources a position in a generated file came from, or nothing
   * when it came from nowhere the sources can name.
   */
  const locate = (
    file: ts.SourceFile | undefined,
    generatedStart: number | undefined,
    generatedLength: number | undefined,
  ):
    | {
        readonly file: ts.SourceFile;
        readonly start: number;
        readonly length: number;
      }
    | undefined => {
    const virtualName = file?.fileName;
    if (virtualName === undefined || generatedStart === undefined)
      return undefined;
    const originalOwner = sourceByVirtual.get(virtualName);
    const inspection =
      originalOwner === undefined ? undefined : inspections.get(originalOwner);
    const mapped = inspection?.index.generatedToOriginal(generatedStart)[0];
    if (mapped === undefined) return undefined;
    const sourceName = sourceById.get(mapped.primary.sourceId);
    if (sourceName === undefined) return undefined;
    const sourceInspection = inspections.get(sourceName);
    if (sourceInspection === undefined) return undefined;
    let sourceFile = sourceFiles.get(sourceName);
    if (sourceFile === undefined) {
      sourceFile = ts.createSourceFile(
        sourceName,
        sourceInspection.sourceText,
        options.target,
        true,
        sourceName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      sourceFiles.set(sourceName, sourceFile);
    }
    const start = mapped.projectedOriginalOffset;
    return {
      file: sourceFile,
      start,
      length: Math.max(
        0,
        Math.min(
          mapped.primary.span.end - start,
          generatedLength ?? mapped.primary.span.end - start,
        ),
      ),
    };
  };
  return options.diagnostics.map((diagnostic) => {
    const located = locate(
      diagnostic.file,
      diagnostic.start,
      diagnostic.length,
    );
    // A diagnostic's related locations are positions in the same generated
    // file, and were carried through untouched: they named the virtual `.ts`,
    // which no `check` ever writes, at offsets into text nobody had. "'size'
    // was also declared here" pointed into a file the author could not open.
    const related = (diagnostic.relatedInformation ?? []).map((entry) => {
      const entryLocation = locate(entry.file, entry.start, entry.length);
      return entryLocation === undefined
        ? entry
        : Object.freeze({ ...entry, ...entryLocation });
    });
    const remapped =
      located === undefined ? diagnostic : { ...diagnostic, ...located };
    return Object.freeze(
      related.length === 0
        ? remapped
        : { ...remapped, relatedInformation: related },
    );
  });
}

/**
 * Rewrite the maps TypeScript emits so they describe the sources on disk.
 *
 * TypeScript is handed expanded TypeScript under a virtual `.ts` name, so the
 * maps it emits name that file and carry positions inside it. Left alone they
 * point a debugger at a path that does not exist, at lines that belong to a
 * text nobody has. The expansion already knows where every generated region
 * came from, so composing the two gives a map that reaches the `.sts` — and
 * carries its text, since a build output is often read somewhere the sources
 * are not.
 *
 * Returns nothing when the provider cannot be inspected, which leaves the
 * previous behaviour in place rather than emitting a map that is wrong in a
 * new way.
 */
function sourceMapComposerFor(
  provider: ProjectExpansionProvider,
  virtualBySource: ReadonlyMap<string, string>,
): SourceMapComposer | undefined {
  if (!("inspectSource" in provider)) return undefined;
  const inspect = (
    provider as ProjectExpansionProvider & ExpansionInspectionProvider
  ).inspectSource.bind(provider);
  const sourceBySourceId = new Map<number, { name: string; text: string }>();
  const sourceByVirtual = new Map<string, string>();
  for (const [source, virtual] of virtualBySource) {
    sourceByVirtual.set(virtual, source);
    const inspected = inspect(source);
    if (inspected !== undefined)
      sourceBySourceId.set(inspected.sourceId as number, {
        name: source,
        text: inspected.sourceText,
      });
  }
  if (sourceBySourceId.size === 0) return undefined;
  return ({ mapFileName, virtualFileName, map }) => {
    const source = sourceByVirtual.get(virtualFileName);
    if (source === undefined) return undefined;
    const inspected = inspect(source);
    if (inspected === undefined) return undefined;
    const directory = dirname(mapFileName);
    try {
      return composeSourceMap({
        typescriptMap: map,
        generatedSource: inspected.generated.text,
        generated: inspected.generated,
        origins: inspected.origins,
        sourceName: (sourceId) => {
          const known = sourceBySourceId.get(sourceId as number);
          const path = relative(directory, known?.name ?? source);
          return path.startsWith(".") ? path : `./${path}`;
        },
        sourceText: (sourceId) =>
          sourceBySourceId.get(sourceId as number)?.text,
      });
    } catch {
      // A map that cannot be composed is left as TypeScript emitted it. It is
      // no worse than before, and refusing to emit would fail the build over
      // a debugging aid.
      return undefined;
    }
  };
}

export function runConfiguredProjectCommand(options: {
  readonly command: ConfiguredProjectCommand;
  readonly configPath: string;
  readonly expansionProvider?: ProjectExpansionProvider | undefined;
  readonly writeThrough?: boolean;
}): ConfiguredProjectCommandResult {
  const expansionProvider =
    options.expansionProvider ?? createDefaultProjectExpansionProvider();
  const project = loadSweetProject(options.configPath);
  const configurationDiagnostics = [
    ...project.typescript.errors,
    ...project.problems.map(configurationDiagnostic),
  ];
  if (configurationDiagnostics.length > 0)
    return Object.freeze({
      command: options.command,
      exitCode: 1,
      diagnostics: Object.freeze(configurationDiagnostics),
      outputs: new Map(),
      virtualFiles: Object.freeze([]),
      debugState: expansionProvider.debugState?.(),
    });
  let expanded: ProjectExpansionOutput | readonly VirtualTypeScriptFile[];
  try {
    expanded = expansionProvider.expandProject(project);
  } catch (error) {
    return Object.freeze({
      command: options.command,
      exitCode: 1,
      diagnostics: Object.freeze([
        Object.freeze({
          category: ts.DiagnosticCategory.Error,
          code: 6201,
          file: undefined,
          start: undefined,
          length: undefined,
          messageText: `SWR6201: Project expansion failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      ]),
      outputs: new Map(),
      virtualFiles: Object.freeze([]),
      debugState: expansionProvider.debugState?.(),
    });
  }
  const expansionOutput: ProjectExpansionOutput = Array.isArray(expanded)
    ? { files: expanded, diagnostics: Object.freeze([]) }
    : (expanded as ProjectExpansionOutput);
  if (expansionOutput.diagnostics.length > 0)
    return Object.freeze({
      command: options.command,
      exitCode: 1,
      diagnostics: Object.freeze([...expansionOutput.diagnostics]),
      outputs: new Map(),
      virtualFiles: Object.freeze([...expansionOutput.files]),
      debugState: expansionProvider.debugState?.(),
    });
  const virtualFiles = Object.freeze([...expansionOutput.files]);
  // Map each opted-in source to the virtual file the expander produced for it.
  // A macro-extension source is renamed (`a.sts` -> `a.ts`); a source that
  // opted in with a directive keeps its name, and its virtual file shadows it.
  const virtualNames = new Set(virtualFiles.map(({ fileName }) => fileName));
  const virtualBySource = new Map(
    selectSweetSources({
      fileNames: project.typescript.fileNames,
      macroExtensions: project.sweet.macroExtensions,
    }).flatMap(({ fileName, kind }) =>
      virtualNames.has(kind.virtualFileName)
        ? [[fileName, kind.virtualFileName] as const]
        : [],
    ),
  );
  const rootNames = project.typescript.fileNames.map(
    (fileName) => virtualBySource.get(fileName) ?? fileName,
  );
  const composer = sourceMapComposerFor(expansionProvider, virtualBySource);
  const created = createVirtualProgram({
    rootNames,
    compilerOptions: {
      ...project.typescript.options,
      ...(options.command === "check" ? { noEmit: true } : {}),
    },
    files: virtualFiles,
    ...(composer === undefined ? {} : { composeSourceMap: composer }),
    ...(project.typescript.projectReferences === undefined
      ? {}
      : { projectReferences: project.typescript.projectReferences }),
    ...(options.writeThrough === undefined
      ? {}
      : { writeThrough: options.writeThrough }),
  });
  let diagnostics = [...ts.getPreEmitDiagnostics(created.program)];
  const emit =
    options.command === "build" && diagnostics.length === 0
      ? created.program.emit()
      : undefined;
  diagnostics.push(...(emit?.diagnostics ?? []));
  diagnostics = [
    ...remapGeneratedDiagnostics({
      diagnostics,
      provider: expansionProvider,
      virtualBySource,
      target: project.typescript.options.target ?? ts.ScriptTarget.Latest,
    }),
  ];
  return Object.freeze({
    command: options.command,
    exitCode: diagnostics.length === 0 && emit?.emitSkipped !== true ? 0 : 1,
    diagnostics: Object.freeze(diagnostics),
    outputs: created.virtualHost.outputs,
    virtualFiles,
    debugState: expansionProvider.debugState?.(),
  });
}

export interface WatchProject {
  readonly result: ConfiguredProjectCommandResult;
  close(): void;
}

/** How long to wait for a burst of writes to settle before rebuilding. */
const rebuildDelayMilliseconds = 50;

/** Extensions a change to which can change what the project builds. */
const watchedExtensions = [".ts", ".tsx", ".sts", ".stsx", ".json"];

export function watchConfiguredProject(options: {
  readonly configPath: string;
  readonly expansionProvider?: ProjectExpansionProvider | undefined;
  readonly onResult: (result: ConfiguredProjectCommandResult) => void;
  readonly system?: ts.System;
  readonly writeThrough?: boolean;
  /**
   * Wait before rebuilding, so a burst of writes builds once. Tests pass 0 to
   * rebuild on the next tick instead of after a delay.
   */
  readonly debounceMilliseconds?: number | undefined;
}): WatchProject {
  const system = options.system ?? ts.sys;
  const expansionProvider =
    options.expansionProvider ?? createDefaultProjectExpansionProvider();
  const delay = options.debounceMilliseconds ?? rebuildDelayMilliseconds;
  const build = () =>
    runConfiguredProjectCommand({
      command: "build",
      configPath: options.configPath,
      expansionProvider,
      ...(options.writeThrough === undefined
        ? {}
        : { writeThrough: options.writeThrough }),
    });

  let result = build();
  options.onResult(result);

  const fileWatchers = new Map<string, ts.FileWatcher>();
  const directoryWatchers = new Map<string, ts.FileWatcher>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  /**
   * What the project reads now, which is not what it read when the watch
   * began: a file added to the project, or a macro module a file has newly
   * imported, was never watched, so editing it rebuilt nothing. The set is
   * taken again after every build.
   */
  const follow = (): void => {
    if (closed) return;
    const project = loadSweetProject(options.configPath);
    const wanted = new Set([
      project.configPath,
      ...project.typescript.fileNames,
      ...(expansionProvider.macroDependencies?.(project) ?? []),
    ]);
    for (const [fileName, watcher] of fileWatchers)
      if (!wanted.has(fileName)) {
        watcher.close();
        fileWatchers.delete(fileName);
      }
    for (const fileName of wanted)
      if (!fileWatchers.has(fileName))
        fileWatchers.set(fileName, system.watchFile!(fileName, schedule));
    // A file the project has yet to see has no watcher to fire, so the
    // directories it could appear in are watched as well.
    if (system.watchDirectory === undefined) return;
    const directories = new Set(
      [...wanted].map((fileName) => dirname(fileName)),
    );
    for (const [directory, watcher] of directoryWatchers)
      if (!directories.has(directory)) {
        watcher.close();
        directoryWatchers.delete(directory);
      }
    for (const directory of directories)
      if (!directoryWatchers.has(directory))
        directoryWatchers.set(
          directory,
          system.watchDirectory(directory, (changed) => {
            if (
              !changed.includes("node_modules") &&
              watchedExtensions.some((extension) => changed.endsWith(extension))
            )
              schedule();
          }),
        );
  };

  function schedule(): void {
    if (closed) return;
    // An editor writing one file in two steps, or a save across several files,
    // used to start a build for each write. Only the last one is wanted.
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      if (closed) return;
      result = build();
      options.onResult(result);
      follow();
    }, delay);
    pending.unref?.();
  }

  follow();
  return {
    get result() {
      return result;
    },
    close: () => {
      closed = true;
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
      for (const watcher of fileWatchers.values()) watcher.close();
      for (const watcher of directoryWatchers.values()) watcher.close();
      fileWatchers.clear();
      directoryWatchers.clear();
    },
  };
}
