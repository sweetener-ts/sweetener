import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, resolve } from "node:path";
import type { OriginMap } from "@sweetener/printer";
import { composeSourceMap } from "@sweetener/typescript-host";
import type {
  RawSourceMap,
  VirtualTypeScriptFile,
} from "@sweetener/typescript-host";
import * as ts from "typescript";
import {
  createDefaultProjectExpansionProvider,
  type DefaultProjectExpansionProvider,
} from "./default-expansion-provider.js";
import { loadSweetProject, type LoadedSweetProject } from "./configuration.js";
import {
  checkedInputs,
  diskFileSystem,
  InputCheckRound,
  nowNanoseconds,
  type CheckedInput,
  type ExpansionInput,
} from "./expansion-inputs.js";
import { selectSweetSources } from "./source-kind.js";
import type { SourceExpansionInspection } from "./expansion-tools.js";

export interface SweetenerTransformRequest {
  /** Source text supplied to the build tool. It must still match the file. */
  readonly code: string;
  readonly filename: string;
  readonly configFile?: string | undefined;
  readonly mode?: "development" | "production" | "test" | undefined;
}

export interface SweetenerTransformResult {
  readonly code: string;
  readonly originMap: OriginMap;
  /** Maps the expanded TypeScript in `code` back to the source on disk. */
  readonly map: RawSourceMap;
  /**
   * Compose a map produced from `code` with this expansion's own.
   *
   * A host that strips types or bundles emits a map against the expanded
   * TypeScript, which exists only in memory. Passing that map through here
   * rewrites it to reach the `.sts` the author wrote, with the source text
   * carried along. Returns nothing when the two cannot be composed, which
   * leaves the caller to emit what it had.
   */
  composeMap(typescriptMap: RawSourceMap): RawSourceMap | undefined;
  /**
   * What is wrong with this file's expansion: what is wrong with the file and
   * its imports, with the macro modules it reads macros from, and what
   * expanding it raised. A mistake in another file of the project is that
   * file's to report, when it is transformed -- so this file's result does
   * not depend on files it does not read, and is kept while they change.
   */
  readonly diagnostics: readonly ts.Diagnostic[];
  /**
   * What expansion holds about a name it left standing in this file.
   *
   * A build tool expands and runs; nothing on this path resolves names, so
   * these have nowhere else to go. Dropped, they left
   * `node --import @sweetener/node/register ./main.sts` loading a module whose
   * first use of the name is a `ReferenceError`, with nothing said about why.
   *
   * Warnings rather than errors: the claim expansion cannot make -- that
   * nothing else defines the name -- is the one that would justify refusing to
   * expand, and a macro spelled like a global leaves that global standing.
   * A host reports them; it does not fail over them.
   */
  readonly warnings: readonly ts.Diagnostic[];
  /** Files whose text expansion read, for a host to watch for changes. */
  readonly dependencies: readonly string[];
  /**
   * Files and directories expansion looked for and did not find, for a host
   * to watch for them to appear. What else it asked -- which directories a
   * type root holds, where a link leads -- has no field here; the session
   * asks it again itself before it serves a kept result.
   */
  readonly missingDependencies: readonly string[];
  readonly trace: unknown;
  readonly cacheKey: string;
  readonly virtualFilename: string;
}

export interface SweetenerSession {
  /**
   * Expand a file, answered together with every other request made before
   * the session gets to it.
   *
   * Whether what a kept expansion read still holds is asked once for all of
   * them: each was made before the asking began, so each answer is current
   * for each of them. A bundler transforming a project's files at once has
   * every file it shares inputs with checked once, not once per file.
   */
  transform(
    request: SweetenerTransformRequest,
  ): Promise<SweetenerTransformResult>;
  /**
   * The same expansion, without a promise around it.
   *
   * Expanding a file is synchronous work — it reads from disk and runs the
   * compiler — and some hosts can only accept a synchronous answer. Deno's
   * module loader hooks are one: they cannot await. Each call is answered on
   * its own: nothing checked for an earlier call can stand for this one,
   * since the disk may have changed in between.
   */
  transformSync(request: SweetenerTransformRequest): SweetenerTransformResult;
  invalidate(paths: readonly string[]): void;
  close(): Promise<void>;
}

/**
 * Everything about a project that its files' expansions are given, short of
 * which files there are: each file's expansion depends on its own sources,
 * not on the rest of the list.
 */
function signatureOf(project: LoadedSweetProject): string {
  return JSON.stringify({
    configPath: project.configPath,
    sweet: project.sweet,
    options: project.typescript.options,
  });
}

/**
 * A config as last loaded, kept while every file it was loaded from says what
 * it said, so a transform does not parse the config and walk `include` again.
 * Whether it lists a source is then decided by the source's path alone --
 * TypeScript ranks each macro extension on its own, so no other file can push
 * a source out of the list -- and a source it does not list yet sends it to
 * be loaded again.
 */
interface ConfigState {
  readonly project: LoadedSweetProject;
  readonly signature: string;
  readonly consulted: readonly CheckedInput[];
  /** The sources it expands, by resolved path. */
  readonly expanded: ReadonlySet<string>;
  /**
   * Every file it lists, as one string, kept from the previous load while
   * the list is the same so comparing it with an expansion's is immediate.
   */
  readonly fileList: string;
  /**
   * Each source's last expansion, kept while everything it consulted holds
   * what it held. Kept across loads of the config while the config still
   * says the same thing, for the sources it still lists.
   */
  readonly files: Map<string, FileExpansion>;
}

/**
 * One file's expansion, kept so the next request for it -- and the first
 * request for every other file expanded alongside it -- is served without
 * expanding the project again.
 *
 * It is everything a transform result is made of, taken as the expansion
 * finished, so nothing done to the provider since can change what it says.
 */
interface FileExpansion {
  readonly consulted: readonly CheckedInput[];
  /**
   * The project's file list, when TypeScript resolved binding literals over
   * all of it and so this expansion depends on which files there are.
   */
  readonly fileList: string | undefined;
  readonly inspection: SourceExpansionInspection;
  readonly sourceMap: RawSourceMap;
  readonly generated: VirtualTypeScriptFile;
  readonly virtualFilename: string;
  /**
   * Every source in the project, so a composed map can name a macro module it
   * reaches through as well as the file being transformed.
   */
  readonly sourceNames: ReadonlyMap<
    number,
    { readonly name: string; readonly text: string }
  >;
  readonly dependencies: readonly string[];
  readonly missingDependencies: readonly string[];
  /** Both of the above, for `invalidate` to look a changed path up in. */
  readonly watched: ReadonlySet<string>;
  /** Transform results served from this expansion, by cache key. */
  readonly results: Map<string, SweetenerTransformResult>;
}

/**
 * A path by where it leads. Of a path that is not there -- a file just
 * deleted, or one looked for and not found -- the part that is there is
 * resolved and the rest kept, so a host naming a deleted file through a link
 * names the same place the session recorded while the file was there.
 */
function canonical(fileName: string): string {
  let existing = resolve(fileName);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing).replaceAll("\\", "/");
}

/**
 * The config that governs a file, found the way expansion finds it.
 *
 * Exported so an integration deciding what to cache against asks the same
 * question the compiler does, rather than approximating it.
 */
export function discoverSweetConfig(fileName: string): string {
  return discoverConfig(fileName);
}

function discoverConfig(fileName: string): string {
  let directory = dirname(resolve(fileName));
  const root = parse(directory).root;
  while (true) {
    const candidate = resolve(directory, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (directory === root)
      throw new Error(
        `No tsconfig.json found for ${fileName}. Pass configFile to the Sweetener plugin — \`sweetener init\` writes a sweetener.json to point it at.`,
      );
    directory = dirname(directory);
  }
}

function fingerprint(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
}

/**
 * Requests answered together, every one of which arrived before any of their
 * checks began, so one answer to each question serves them all.
 */
interface Round {
  readonly inputs: InputCheckRound;
  /** Configs loaded during the round, which are as current as the round. */
  readonly loaded: Set<string>;
  /**
   * Each config's expansion made during the round, by source -- failures
   * included, which are not kept past the round but read everything after
   * the round's requests were made.
   */
  readonly expanded: Map<string, Map<string, FileExpansion>>;
}

function newRound(): Round {
  return {
    inputs: new InputCheckRound(),
    loaded: new Set(),
    expanded: new Map(),
  };
}

/**
 * Create a long-lived compiler session for a build, dev server, or test run.
 *
 * The current frontend reads a coherent TypeScript project from disk. Rejecting
 * a changed in-memory source is intentional: silently expanding different text
 * would make its project-wide macro graph and diagnostics inconsistent. A
 * virtual-filesystem frontend will remove this temporary restriction.
 */
export function createSweetenerSession(
  options: {
    readonly provider?: DefaultProjectExpansionProvider | undefined;
  } = {},
): SweetenerSession {
  const provider = options.provider ?? createDefaultProjectExpansionProvider();
  const configs = new Map<string, ConfigState>();
  let closed = false;

  const notOptedIn = (filename: string, configFile: string): Error =>
    new Error(
      `${filename} is not opted into Sweetener expansion by ${configFile}. List it there, under "files" or "include".`,
    );

  const load = (configFile: string): ConfigState => {
    const loadedAt = nowNanoseconds();
    const project = loadSweetProject(configFile);
    // A config that cannot be read parses as an empty project, and every file
    // then looks merely left out of it. The command line refuses such a
    // project before expanding, and so does an adapter: expanding anyway would
    // report a configFile pointing at nothing as the source not being opted in.
    const configurationErrors = [
      ...project.typescript.errors.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      ),
      ...project.problems.map(
        ({ code, path, message }) => `${code} ${path} ${message}`,
      ),
    ];
    if (configurationErrors.length > 0) {
      configs.delete(configFile);
      throw new Error(
        `Sweetener cannot use ${configFile}: ${configurationErrors.join("; ")}`,
      );
    }
    const signature = signatureOf(project);
    const previous = configs.get(configFile);
    const expanded = new Set(
      selectSweetSources({
        fileNames: project.typescript.fileNames,
        macroExtensions: project.sweet.macroExtensions,
        readSource: (fileName) => diskFileSystem.system.readFile(fileName),
      }).map(({ fileName }) => resolve(fileName)),
    );
    // A source the config no longer lists is not served under it, and its
    // expansion would hold the origins of a whole project's expansion for as
    // long as the session lives. One listed again is expanded again.
    const files =
      previous !== undefined && previous.signature === signature
        ? previous.files
        : new Map<string, FileExpansion>();
    for (const fileName of files.keys())
      if (!expanded.has(fileName)) files.delete(fileName);
    const fileList = JSON.stringify(project.typescript.fileNames);
    const state: ConfigState = {
      project,
      signature,
      consulted: checkedInputs(
        diskFileSystem,
        loadedAt,
      )(project.configurationInputs),
      expanded,
      fileList: previous?.fileList === fileList ? previous.fileList : fileList,
      files,
    };
    configs.set(configFile, state);
    sweep(configFile);
    return state;
  };

  /**
   * Drop what is kept for other configs that can no longer serve anything:
   * a config whose file is gone, each kept expansion whose source is gone,
   * and a config left with none. A session that lives through many projects
   * -- a test runner's, whose fixtures come and go -- otherwise keeps every
   * one it ever saw. Only a load can add a config, so a session holds no
   * more configs than are still there, plus the one being loaded.
   */
  const sweep = (loaded: string): void => {
    const { system } = diskFileSystem;
    for (const [configFile, state] of configs) {
      if (configFile === loaded) continue;
      if (!system.fileExists(configFile)) {
        configs.delete(configFile);
        continue;
      }
      for (const fileName of state.files.keys())
        if (!system.fileExists(fileName)) state.files.delete(fileName);
      if (state.files.size === 0) configs.delete(configFile);
    }
  };

  /**
   * Expand the project, and return what it made of each file. Each that
   * succeeded is kept; a failed one is not: partial results must not enter a
   * content-addressed cache, and this is the one this pipeline has.
   * Recomputing a failure is cheap and always correct; serving one from a
   * cache outlives the reason for it.
   */
  const expand = (state: ConfigState): Map<string, FileExpansion> => {
    const expandedAt = nowNanoseconds();
    const expanded = provider.expandProject(state.project);
    const check = checkedInputs(provider.fileSystem, expandedAt);
    const canonicalNames = new Map<string, string>();
    const canonicalOf = (fileName: string): string => {
      let name = canonicalNames.get(fileName);
      if (name === undefined) {
        name = canonical(fileName);
        canonicalNames.set(fileName, name);
      }
      return name;
    };
    const generated = new Map(
      expanded.files.map((file) => [
        canonicalOf(file.fileName).replace(/\.(?:ts|js)x?$/u, ""),
        file,
      ]),
    );
    const { fileNames } = state.project.typescript;
    const sourceNames = new Map<number, { name: string; text: string }>();
    const inspections = fileNames.flatMap((name) => {
      const inspection = provider.inspectSource(name);
      if (inspection === undefined) return [];
      sourceNames.set(inspection.sourceId as number, {
        name,
        text: inspection.sourceText,
      });
      return [{ name, inspection }];
    });
    const configuration = state.project.configurationInputs;
    const fileList = expanded.resolvesBindingLiterals
      ? state.fileList
      : undefined;
    const made = new Map<string, FileExpansion>();
    for (const { name, inspection } of inspections) {
      const file = generated.get(
        canonicalOf(name).replace(/\.s(?:ts|js)x?$/u, ""),
      );
      const key = resolve(name);
      const { sourceMap } = inspection;
      if (sourceMap === undefined || file === undefined) {
        state.files.delete(key);
        continue;
      }
      const consulted = [...configuration, ...inspection.inputs];
      const pathsOf = (found: (input: ExpansionInput) => boolean) =>
        Object.freeze(
          [
            ...new Set(
              consulted.filter(found).map(({ path }) => canonicalOf(path)),
            ),
          ].sort(),
        );
      const dependencies = pathsOf(
        (input) => input.kind === "file" && input.text !== undefined,
      );
      const missingDependencies = pathsOf(
        (input) =>
          (input.kind === "file" && input.text === undefined) ||
          (input.kind === "directory" && !input.exists),
      );
      const fileExpansion: FileExpansion = {
        consulted: check(inspection.inputs),
        fileList,
        inspection,
        sourceMap,
        generated: file,
        virtualFilename: canonicalOf(file.fileName),
        sourceNames,
        dependencies,
        missingDependencies,
        watched: new Set([...dependencies, ...missingDependencies]),
        results: new Map(),
      };
      if (inspection.diagnostics.length === 0)
        state.files.set(key, fileExpansion);
      else state.files.delete(key);
      made.set(key, fileExpansion);
    }
    return made;
  };

  const transformIn = (
    round: Round,
    request: SweetenerTransformRequest,
  ): SweetenerTransformResult => {
    if (closed) throw new Error("Sweetener session is closed");
    const filename = canonical(request.filename);
    const onDisk = readFileSync(filename, "utf8");
    if (onDisk !== request.code)
      throw new Error(
        `Sweetener source for ${filename} changed before expansion; invalidate and retry from disk`,
      );
    const configFile = canonical(
      request.configFile ?? discoverConfig(filename),
    );
    const cacheKey = fingerprint([
      filename,
      request.code,
      configFile,
      request.mode ?? "development",
    ]);

    // The config is loaded again at most once a round: when a file it was
    // loaded from changed, when it does not list this file yet, when an
    // expansion is about to be made from it, or when this file's expansion
    // depends on its whole file list.
    const loadedInRound = (): boolean => round.loaded.has(configFile);
    const reload = (): ConfigState => {
      const loaded = load(configFile);
      round.loaded.add(configFile);
      return loaded;
    };
    let state = configs.get(configFile);
    if (
      state === undefined ||
      (!loadedInRound() &&
        (!round.inputs.hold(state.consulted) || !state.expanded.has(filename)))
    )
      state = reload();
    if (!state.expanded.has(filename)) {
      // Nothing it lists has been asked for, so nothing is kept for it.
      if (state.files.size === 0) configs.delete(configFile);
      throw notOptedIn(filename, configFile);
    }
    let fileExpansion = state.files.get(filename);
    if (
      fileExpansion !== undefined &&
      !round.inputs.hold(fileExpansion.consulted)
    )
      fileExpansion = undefined;
    if (fileExpansion?.fileList !== undefined) {
      if (!loadedInRound()) state = reload();
      fileExpansion = state.files.get(filename);
      if (fileExpansion?.fileList !== state.fileList) fileExpansion = undefined;
    }
    if (fileExpansion === undefined) {
      let made = round.expanded.get(configFile);
      if (made === undefined) {
        if (!loadedInRound()) state = reload();
        made = expand(state);
        round.expanded.set(configFile, made);
      }
      fileExpansion = made.get(filename);
      if (fileExpansion === undefined) throw notOptedIn(filename, configFile);
    }
    const existing = fileExpansion.results.get(cacheKey);
    if (existing !== undefined) return existing;
    const { inspection, generated, sourceNames } = fileExpansion;
    const result: SweetenerTransformResult = Object.freeze({
      code: generated.generated.text,
      originMap: generated.generated.originMap,
      map: fileExpansion.sourceMap,
      composeMap: (typescriptMap: RawSourceMap) => {
        try {
          return composeSourceMap({
            typescriptMap,
            generatedSource: inspection.generated.text,
            generated: inspection.generated,
            origins: inspection.origins,
            sourceName: (sourceId) =>
              sourceNames.get(sourceId as number)?.name ?? filename,
            sourceText: (sourceId) => sourceNames.get(sourceId as number)?.text,
          });
        } catch {
          return undefined;
        }
      },
      diagnostics: inspection.diagnostics,
      warnings: inspection.warnings ?? Object.freeze([]),
      dependencies: fileExpansion.dependencies,
      missingDependencies: fileExpansion.missingDependencies,
      trace: inspection.trace,
      cacheKey,
      virtualFilename: fileExpansion.virtualFilename,
    });
    fileExpansion.results.set(cacheKey, result);
    return result;
  };

  // Requests made through `transform` and not yet answered, answered together
  // once this turn of the event loop is over.
  let queued:
    | {
        readonly request: SweetenerTransformRequest;
        readonly resolve: (result: SweetenerTransformResult) => void;
        readonly reject: (error: unknown) => void;
      }[]
    | undefined;
  const answerQueued = (): void => {
    const requests = queued ?? [];
    queued = undefined;
    const round = newRound();
    for (const { request, resolve, reject } of requests) {
      try {
        resolve(transformIn(round, request));
      } catch (error) {
        reject(error);
      }
    }
  };

  return Object.freeze({
    transformSync: (request: SweetenerTransformRequest) =>
      transformIn(newRound(), request),
    transform(
      request: SweetenerTransformRequest,
    ): Promise<SweetenerTransformResult> {
      return new Promise((resolve, reject) => {
        if (queued === undefined) {
          queued = [];
          setImmediate(answerQueued);
        }
        queued.push({ request, resolve, reject });
      });
    },
    invalidate(paths: readonly string[]): void {
      const invalidated = paths.map(canonical);
      for (const [configFile, state] of configs) {
        if (
          state.consulted.some(({ input }) =>
            invalidated.includes(canonical(input.path)),
          )
        ) {
          configs.delete(configFile);
          continue;
        }
        for (const [fileName, fileExpansion] of state.files)
          if (invalidated.some((path) => fileExpansion.watched.has(path)))
            state.files.delete(fileName);
      }
    },
    async close(): Promise<void> {
      closed = true;
      configs.clear();
    },
  });
}
