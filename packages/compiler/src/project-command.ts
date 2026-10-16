import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { SourceId } from "@sweetener/shared";
import type {
  SourceMapComposer,
  VirtualTypeScriptFile,
} from "@sweetener/typescript-host";
import {
  composeSourceMap,
  createVirtualProgram,
  remapGeneratedSpan,
} from "@sweetener/typescript-host";
import * as ts from "typescript";
import {
  loadSweetProject,
  type LoadedSweetProject,
  type SweetConfigurationProblem,
} from "./configuration.js";
import { createDefaultProjectExpansionProvider } from "./default-expansion-provider.js";
import type { ExpansionInput } from "./expansion-inputs.js";
import type { ExpansionInspectionProvider } from "./expansion-tools.js";
import { selectSweetSources } from "./source-kind.js";
import {
  explainUnresolvedNames,
  warnAboutHeldNames,
  type UnresolvedNameExplanation,
} from "./unresolved-names.js";

export type ConfiguredProjectCommand = "check" | "build";

export interface ProjectExpansionProvider {
  /** Return expanded files under their virtual `.ts`/`.tsx` names. */
  expandProject(
    project: LoadedSweetProject,
  ): ProjectExpansionOutput | readonly VirtualTypeScriptFile[];
  /**
   * What the last expansion of `project` asked of the file system, for a
   * watcher to watch: a different answer to any of them can change what it
   * produced.
   */
  expansionInputs?(project: LoadedSweetProject): readonly ExpansionInput[];
  debugState?(): unknown;
}

export interface ProjectExpansionOutput {
  readonly files: readonly VirtualTypeScriptFile[];
  readonly diagnostics: readonly ts.Diagnostic[];
  /**
   * What expansion can say about a name it left alone, for the places
   * TypeScript reports it cannot resolve one.
   *
   * These are not diagnostics of their own. Expansion knows the macros in
   * scope and the bindings a module writes; which names a program declares is
   * TypeScript's to answer, because `lib.d.ts`, an ambient declaration and a
   * `declare global` all declare names expansion never sees. Each of these is
   * written in place of the name TypeScript could not find at the same
   * position and under the same spelling, and dropped where TypeScript found
   * one -- except in a file TypeScript does not check, where nothing answers
   * and the sentence is said as a warning.
   */
  readonly unresolvedNameExplanations?: readonly UnresolvedNameExplanation[];
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

/**
 * `// @ts-check` or `// @ts-nocheck` written at the head of a file, which says
 * whether TypeScript checks it whatever its extension and `checkJs` say.
 * Undefined where neither is written.
 *
 * Read here rather than off `ts.SourceFile`, whose `checkJsDirective` the
 * TypeScript 6.0 public typings do not carry. The rules are TypeScript's, and
 * agree with it on every case tested: a `//` comment only, `///` allowed,
 * whitespace after the slashes allowed, anything after the directive allowed,
 * only among the comments in front of the first token, and the last of them
 * wins.
 */
function checkDirective(text: string | undefined): boolean | undefined {
  if (text === undefined) return undefined;
  let enabled: boolean | undefined;
  for (const range of ts.getLeadingCommentRanges(text, 0) ?? []) {
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
    const matched = checkDirectivePattern.exec(
      text.slice(range.pos, range.end),
    );
    if (matched !== null) enabled = matched[1] === "ts-check";
  }
  return enabled;
}

const checkDirectivePattern = /^\/\/\/?\s*@(ts-check|ts-nocheck)\b/u;

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
  /** The source a source id names, parsed the first time it is asked for. */
  const sourceFileFor = (sourceId: SourceId): ts.SourceFile | undefined => {
    const sourceName = sourceById.get(sourceId);
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
    return sourceFile;
  };
  /**
   * Where in the sources a span of a generated file is reported, and what else
   * in them it is about, or nothing when it came from nowhere the sources can
   * name. The language service reports through the same remap, so an editor
   * and `check` say the same thing about the same expansion. A related source
   * no inspected file holds, such as a macro module inside a package, has no
   * file to point into here and is left out.
   */
  const locate = (
    file: ts.SourceFile | undefined,
    generatedStart: number | undefined,
    generatedLength: number | undefined,
  ) => {
    const originalOwner =
      file === undefined ? undefined : sourceByVirtual.get(file.fileName);
    const inspection =
      originalOwner === undefined ? undefined : inspections.get(originalOwner);
    if (inspection === undefined || generatedStart === undefined)
      return undefined;
    const { primaryOrigin, relatedOrigins } = remapGeneratedSpan({
      generated: inspection.generated,
      origins: inspection.origins,
      start: generatedStart,
      length: generatedLength ?? 0,
    });
    if (primaryOrigin === undefined) return undefined;
    const sourceFile = sourceFileFor(primaryOrigin.sourceId);
    if (sourceFile === undefined) return undefined;
    return {
      file: sourceFile,
      start: primaryOrigin.start,
      length: primaryOrigin.end - primaryOrigin.start,
      related: relatedOrigins.flatMap(({ message, origin }) => {
        const relatedFile = sourceFileFor(origin.sourceId);
        return relatedFile === undefined
          ? []
          : [
              {
                category: ts.DiagnosticCategory.Message,
                file: relatedFile,
                start: origin.start,
                length: origin.end - origin.start,
                messageText: message,
              },
            ];
      }),
    };
  };
  return options.diagnostics.map((diagnostic) => {
    const located = locate(
      diagnostic.file,
      diagnostic.start,
      diagnostic.length,
    );
    // A diagnostic's related locations are positions in the same generated
    // file. Carried through untouched they would name the virtual `.ts`, which
    // no `check` ever writes, at offsets into text nobody has: "'size' was
    // also declared here" would point into a file the author cannot open.
    const related = (diagnostic.relatedInformation ?? []).map((entry) => {
      const entryLocation = locate(entry.file, entry.start, entry.length);
      return entryLocation === undefined
        ? entry
        : Object.freeze({
            ...entry,
            file: entryLocation.file,
            start: entryLocation.start,
            length: entryLocation.length,
          });
    });
    const relatedInformation = [
      ...related,
      ...(located?.related ?? []).map((entry) => ({
        ...entry,
        code: diagnostic.code,
      })),
    ];
    const remapped =
      located === undefined
        ? diagnostic
        : {
            ...diagnostic,
            file: located.file,
            start: located.start,
            length: located.length,
          };
    return Object.freeze(
      relatedInformation.length === 0
        ? remapped
        : { ...remapped, relatedInformation },
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

/** A declaration only gets rewritten when it changed, so watchers stay quiet. */
function readFileIfPresent(fileName: string): string | undefined {
  try {
    return readFileSync(fileName, "utf8");
  } catch {
    return undefined;
  }
}

function withoutOutputDirectories(
  compilerOptions: ts.CompilerOptions,
): ts.CompilerOptions {
  // These declarations go beside their sources, so the emitter must not be
  // told to redirect them anywhere. Deleting beats assigning undefined under
  // exactOptionalPropertyTypes.
  const rest = { ...compilerOptions };
  delete rest.outDir;
  delete rest.declarationDir;
  delete rest.rootDir;
  return rest;
}

/**
 * Write a declaration beside every macro source, as `main.d.sts.ts`.
 *
 * With `allowArbitraryExtensions`, TypeScript resolves
 * `import { x } from "./main.sts"` through exactly that name, so an ordinary
 * `.ts` or `.tsx` file gets the real types of a `.sts` module — from `tsc`,
 * from an editor, from another project — and those types follow the source
 * rather than a hand-written `declare module` that goes stale the moment a
 * type changes.
 *
 * Declarations are emitted from a program of their own, because a project that
 * leaves emit to a bundler sets `noEmit` and one that emits JavaScript should
 * not start emitting `.d.ts` into its output as a side effect of asking for
 * these.
 */
function writeSourceDeclarations(options: {
  readonly virtualBySource: ReadonlyMap<string, string>;
  readonly virtualFiles: readonly VirtualTypeScriptFile[];
  readonly project: LoadedSweetProject;
  readonly writeThrough: boolean;
}): void {
  if (options.virtualBySource.size === 0) return;
  const declarationBySource = new Map<string, string>();
  for (const [source, virtual] of options.virtualBySource) {
    // `main.sts` is declared by `main.d.sts.ts`, beside it: that is the name
    // TypeScript looks for, so it cannot go to an output directory.
    const match = /\.(s[a-z]+)$/u.exec(source);
    if (match === null) continue;
    declarationBySource.set(
      virtual,
      `${source.slice(0, -match[1]!.length - 1)}.d.${match[1]!}.ts`,
    );
  }
  const emitted = new Map<string, string>();
  const { program } = createVirtualProgram({
    rootNames: options.project.typescript.fileNames.map(
      (fileName) => options.virtualBySource.get(fileName) ?? fileName,
    ),
    compilerOptions: {
      ...withoutOutputDirectories(options.project.typescript.options),
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      declarationMap: false,
    },
    files: options.virtualFiles,
    writeThrough: false,
  });
  // Only the macro sources get one. An ordinary `.ts` in the project already
  // has a name TypeScript can resolve, and emitting a second declaration for
  // it beside the source would be a file nobody asked for.
  // Whatever TypeScript says about the sources is reported by the program that
  // checks them, mapped back to the `.sts`. Reporting it here as well would
  // say it twice, in terms of a virtual file.
  program.emit(
    undefined,
    (_fileName, text, _bom, _onError, sourceFiles) => {
      const virtual = sourceFiles?.[0]?.fileName;
      const target =
        virtual === undefined ? undefined : declarationBySource.get(virtual);
      if (target !== undefined) emitted.set(target, text);
    },
    undefined,
    true,
  );
  if (!options.writeThrough) return;
  for (const [fileName, text] of emitted)
    if (readFileIfPresent(fileName) !== text)
      writeFileSync(fileName, text, "utf8");
  removeStaleDeclarations(new Set(emitted.keys()), declarationBySource);
}

/**
 * Delete declarations whose source is gone.
 *
 * These sit beside the sources rather than in an output directory, and they
 * are what TypeScript resolves a `./main.sts` import through. A leftover one
 * therefore does not merely take up space: it keeps answering for a module
 * that no longer exists, so an import of a deleted file goes on type-checking
 * until the bundler fails on it.
 *
 * Only a `.d.sts.ts` whose own source is missing is removed, and only in a
 * directory this project has sources in, so nothing another tool put there is
 * touched.
 */
function removeStaleDeclarations(
  written: ReadonlySet<string>,
  declarationBySource: ReadonlyMap<string, string>,
): void {
  const directories = new Set(
    [...declarationBySource.values()].map((fileName) => dirname(fileName)),
  );
  const declaration = /^(.*)\.d\.(s[a-z]+)\.ts$/u;
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = declaration.exec(entry);
      if (match === null) continue;
      const fileName = join(directory, entry);
      if (written.has(fileName)) continue;
      // The source it stands for, which is the only thing it can be for.
      if (existsSync(join(directory, `${match[1]!}.${match[2]!}`))) continue;
      try {
        rmSync(fileName);
      } catch {
        // Another process may have removed it already, which is the outcome
        // this wanted.
      }
    }
  }
}

/**
 * One message per place, however many copies of it the expansion produced.
 *
 * A macro that repeats its argument repeats every error in it: `twice(1)` in a
 * `string[]` expanded to `[1, 1]`, TypeScript reported both elements, and both
 * remapped to the same span — the same sentence twice, about one mistake, at
 * one position.
 */
function deduplicateDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
): readonly ts.Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([
      diagnostic.file?.fileName,
      diagnostic.start,
      diagnostic.length,
      diagnostic.code,
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const heldExplanations = expansionOutput.unresolvedNameExplanations ?? [];
  /**
   * Whether expansion has a mistake of its own to report, which is why the
   * project is not checked: over text that never finished expanding TypeScript
   * says a great deal, all of it downstream of the expansion that failed.
   *
   * What is held against a position is a different matter. It is a sentence
   * about a name expansion left standing, and it is owed to whoever wrote that
   * name -- in this file or in any other. Ending the run here silenced every
   * one of them over a single unrelated macro error somewhere in the project.
   * So the program is still built when something is held, purely to ask
   * TypeScript which of those names it resolves; nothing else it says is kept,
   * and nothing is emitted.
   */
  const expansionFailed = expansionOutput.diagnostics.some(
    ({ category }) => category === ts.DiagnosticCategory.Error,
  );
  if (expansionFailed && heldExplanations.length === 0)
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
      readSource: (fileName) => ts.sys.readFile(fileName),
    }).flatMap(({ fileName, kind }) =>
      virtualNames.has(kind.virtualFileName)
        ? [[fileName, kind.virtualFileName] as const]
        : [],
    ),
  );
  const rootNames = project.typescript.fileNames.map(
    (fileName) => virtualBySource.get(fileName) ?? fileName,
  );
  // Before the program that checks the project, not after it. These are what
  // TypeScript resolves a `./main.sts` import through, so a `.ts` file that
  // imports one cannot be checked until they exist. Writing them only once the
  // check passed would never write them, because the check cannot pass
  // without them.
  // Not for a project that failed to expand: the declaration would describe
  // whatever the unexpanded text happens to read as, and be left on disk for
  // the next build to trust.
  if (project.sweet.sourceDeclarations && !expansionFailed)
    writeSourceDeclarations({
      virtualBySource,
      virtualFiles,
      project,
      writeThrough: options.writeThrough !== false,
    });
  const composer = sourceMapComposerFor(expansionProvider, virtualBySource);
  const created = createVirtualProgram({
    rootNames,
    compilerOptions: {
      // A macro module whose every item is a macro definition expands to
      // nothing, and TypeScript reads a file with no imports or exports as a
      // script: the emitted JavaScript would be a lone `"use strict";` and the
      // declaration would describe a global scope. Every Sweetener source is a
      // module, so say so unless the project has an opinion.
      moduleDetection: ts.ModuleDetectionKind.Force,
      ...project.typescript.options,
      ...(options.command === "check" || expansionFailed
        ? { noEmit: true }
        : {}),
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
    options.command === "build" &&
    !expansionFailed &&
    !diagnostics.some(
      ({ category }) => category === ts.DiagnosticCategory.Error,
    )
      ? created.program.emit()
      : undefined;
  diagnostics.push(...(emit?.diagnostics ?? []));
  const remapped = remapGeneratedDiagnostics({
    diagnostics,
    provider: expansionProvider,
    virtualBySource,
    target: project.typescript.options.target ?? ts.ScriptTarget.Latest,
  });
  const explained = explainUnresolvedNames(remapped, heldExplanations);
  /**
   * Whether TypeScript resolves the names in a source, which is the whole
   * reason a sentence about one is held rather than said.
   *
   * A `.js` file is in the program without being checked unless `checkJs` says
   * so, and a project that expands macros into JavaScript is the ordinary way
   * to reach that state. Nothing on that side ever answers, so a sentence held
   * against such a file waited for an answer that never came and was dropped:
   * `check` reported success over `export const held = duplicate;`, a name the
   * emitted code does not define, because the compile-time import is erased.
   */
  const resolvesNamesIn = (fileName: string | undefined): boolean => {
    if (fileName === undefined) return true;
    const virtual = virtualBySource.get(fileName);
    // A source this command never handed to TypeScript is not a source this
    // command can say anything about. Silence rather than a sentence nothing
    // asked for.
    if (virtual === undefined) return true;
    // A `// @ts-check` or `// @ts-nocheck` in the file overrides both the
    // extension and `checkJs`, so it is the first question. Asked of the file
    // TypeScript itself parsed, and answered the way TypeScript answers it.
    const directive = checkDirective(
      created.program.getSourceFile(virtual)?.text,
    );
    if (directive !== undefined) return directive;
    return (
      /\.[cm]?tsx?$/iu.test(virtual) ||
      project.typescript.options.checkJs === true
    );
  };
  const unanswered = warnAboutHeldNames(
    heldExplanations.filter(
      (explanation) =>
        !explained.spoken.has(explanation) &&
        !resolvesNamesIn(explanation.diagnostic.file?.fileName),
    ),
  );
  if (expansionFailed)
    return Object.freeze({
      command: options.command,
      exitCode: 1,
      diagnostics: Object.freeze([
        ...deduplicateDiagnostics([
          ...expansionOutput.diagnostics,
          ...heldExplanations
            .filter((explanation) => explained.spoken.has(explanation))
            .map(({ diagnostic }) => diagnostic),
          ...unanswered,
        ]),
      ]),
      outputs: new Map(),
      virtualFiles,
      debugState: expansionProvider.debugState?.(),
    });
  diagnostics = [
    ...deduplicateDiagnostics([
      ...expansionOutput.diagnostics,
      ...explained.diagnostics,
      ...unanswered,
    ]),
  ];
  return Object.freeze({
    command: options.command,
    exitCode:
      diagnostics.some(
        ({ category }) => category === ts.DiagnosticCategory.Error,
      ) || emit?.emitSkipped === true
        ? 1
        : 0,
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

/**
 * How often TypeScript polls a watched file once it is deleted, until it
 * appears again or the next build stops watching it. TypeScript polls a
 * missing file only at an interval its caller gives, and given none it
 * fails -- `fs.watchFile` rejects an undefined interval -- which ended the
 * whole watch when a file it followed was deleted. Its own watch polls
 * source files this often.
 */
const deletedFilePollMilliseconds = 250;

/** Why a directory is watched, and so which of its changes rebuild. */
interface DirectoryInterest {
  /**
   * Paths whose appearance or disappearance matters, at or below a direct
   * entry of the directory: one that is not there yet is watched from the
   * nearest directory that is, and appears through a chain of entries.
   */
  readonly entries: Set<string>;
  /** Whether what the directory holds was listed, so any change counts. */
  listing: boolean;
  /** Whether a source appearing here could join the project. */
  sources: boolean;
}

function wants(interest: DirectoryInterest, changed: string): boolean {
  const path = resolve(changed);
  if (interest.listing) return true;
  for (const entry of interest.entries)
    if (entry === path || entry.startsWith(path + sep)) return true;
  return (
    interest.sources &&
    !path.includes("node_modules") &&
    watchedExtensions.some((extension) => path.endsWith(extension))
  );
}

/**
 * The links on the way to a path, each of which can be pointed elsewhere
 * and change where the path leads. A part of the path is a link when where
 * it leads is not where its directory leads, joined with its name.
 */
function linksOn(system: ts.System, path: string): readonly string[] {
  const realpath = system.realpath;
  if (realpath === undefined) return [];
  const parts: string[] = [];
  for (let part = path; dirname(part) !== part; part = dirname(part))
    parts.unshift(part);
  const links: string[] = [];
  let parentTarget = dirname(parts[0] ?? path);
  for (const part of parts) {
    const target = realpath(part);
    if (target !== join(parentTarget, basename(part))) links.push(part);
    parentTarget = target;
  }
  return links;
}

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
  // What each watched directory is watched for, replaced after every build;
  // a directory's watcher outlives a build that still wants it.
  let interests = new Map<string, DirectoryInterest>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  /**
   * Watch what the project reads, which is not fixed when the watch begins: a
   * file added to the project, or a macro module a file newly imports, has to
   * be watched too, or editing it would rebuild nothing. The set is taken
   * again after every build.
   *
   * Each question a build asked of the file system is watched for a change
   * in its answer. A file that is there is watched for its text; whether a
   * path is there at all is watched from the nearest directory that is, since
   * nothing can watch a path that does not exist; a directory listed for what
   * it holds is watched for what it holds; and a link on the way to a path
   * is watched where it lives, for being pointed elsewhere.
   */
  const follow = (): void => {
    if (closed) return;
    const project = loadSweetProject(options.configPath);
    const contents = new Set<string>();
    const entries = new Set<string>();
    const listings = new Set<string>();
    const file = (fileName: string): void => {
      const path = resolve(fileName);
      entries.add(path);
      if (system.fileExists(path)) contents.add(path);
    };
    for (const fileName of project.typescript.fileNames) file(fileName);
    for (const input of [
      ...project.configurationInputs,
      ...(expansionProvider.expansionInputs?.(project) ?? []),
    ])
      switch (input.kind) {
        case "file":
          file(input.path);
          break;
        case "directory":
          entries.add(input.path);
          break;
        case "subdirectories":
          entries.add(input.path);
          if (system.directoryExists(input.path)) listings.add(input.path);
          break;
        case "realpath":
          entries.add(input.path);
          for (const link of linksOn(system, input.path)) entries.add(link);
          break;
      }

    for (const [fileName, watcher] of fileWatchers)
      if (!contents.has(fileName)) {
        watcher.close();
        fileWatchers.delete(fileName);
      }
    for (const fileName of contents)
      if (!fileWatchers.has(fileName))
        fileWatchers.set(
          fileName,
          system.watchFile!(fileName, schedule, deletedFilePollMilliseconds),
        );

    if (system.watchDirectory === undefined) return;
    const next = new Map<string, DirectoryInterest>();
    const interest = (directory: string): DirectoryInterest => {
      let existing = next.get(directory);
      if (existing === undefined) {
        existing = { entries: new Set(), listing: false, sources: false };
        next.set(directory, existing);
      }
      return existing;
    };
    for (const path of entries) {
      let directory = dirname(path);
      while (
        !system.directoryExists(directory) &&
        dirname(directory) !== directory
      )
        directory = dirname(directory);
      interest(directory).entries.add(path);
    }
    for (const directory of listings) interest(directory).listing = true;
    // A file the project has yet to see has no watcher to fire, so the
    // directories of the files it has are watched for sources appearing.
    for (const fileName of contents) interest(dirname(fileName)).sources = true;
    interests = next;
    for (const [directory, watcher] of directoryWatchers)
      if (!interests.has(directory)) {
        watcher.close();
        directoryWatchers.delete(directory);
      }
    for (const directory of interests.keys())
      if (!directoryWatchers.has(directory))
        directoryWatchers.set(
          directory,
          system.watchDirectory(directory, (changed) => {
            const wanted = interests.get(directory);
            if (wanted !== undefined && wants(wanted, changed)) schedule();
          }),
        );
  };

  function schedule(): void {
    if (closed) return;
    // An editor writes one file in two steps, or saves several files at once,
    // and each write fires. Only a build after the last one is wanted.
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
