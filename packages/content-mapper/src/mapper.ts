import { extname, resolve } from "node:path";
import {
  checkedInputs,
  configurationProblems,
  createDefaultProjectExpansionProvider,
  diskFileSystem,
  fingerprint,
  InputCheckRound,
  InputRecorder,
  loadStandaloneProject,
  loadSweetProject,
  macroExtensionTarget,
  nowNanoseconds,
  projectSignature,
  type CheckedInput,
  type DefaultProjectExpansionProvider,
  type DefaultSourceExpansionInspection,
  type ExpansionInput,
  type LoadedSweetProject,
} from "@sweetener/compiler";
import * as ts from "typescript";
import { createBindingAgreement } from "./binding-agreement.js";
import {
  describeError,
  ErrorCode,
  isObject,
  ResponseError,
  type RequestHandler,
} from "./json-rpc.js";
import {
  protocolVersion,
  type CloseProjectParams,
  type ContentMapperDiagnostic,
  type InitializeParams,
  type InitializeResult,
  type OpenProjectParams,
  type OpenProjectResult,
  type PositionEncoding,
  type TransformParams,
  type TransformResult,
  type VirtualExtension,
} from "./protocol.js";
import {
  encodeSegments,
  offsetEncoder,
  segmentsForExpansion,
  type Segment,
} from "./span-mappings.js";

/** What TypeScript prints in front of a code, as every Sweetener surface does. */
export const diagnosticSource = "SWR";

/**
 * How many configs with no project open keep what they expanded. TypeScript
 * closes a project and opens it again at every edit, so one is usually back
 * at once; a session through many worktrees should not keep them all.
 */
const keptClosedConfigs = 8;

const virtualExtensions: ReadonlyMap<string, VirtualExtension> = new Map([
  [".ts", ".ts"],
  [".tsx", ".tsx"],
  [".mts", ".mts"],
  [".cts", ".cts"],
  [".js", ".js"],
  [".jsx", ".jsx"],
  [".mjs", ".mjs"],
  [".cjs", ".cjs"],
]);

function canonical(fileName: string): string {
  return resolve(fileName).replaceAll("\\", "/");
}

function requireString(
  params: Record<string, unknown>,
  name: string,
  method: string,
): string {
  const value = params[name];
  if (typeof value !== "string")
    throw new ResponseError(
      ErrorCode.InvalidParams,
      `${method} needs a string ${name}`,
    );
  return value;
}

function requireParams(params: unknown, method: string) {
  if (!isObject(params))
    throw new ResponseError(
      ErrorCode.InvalidParams,
      `${method} needs an object of parameters`,
    );
  return params;
}

/** An error an expansion raised, as a transform reports it. */
interface RaisedError {
  readonly messageText: string;
  readonly code: number;
  /** The file it is placed in, by the name the mapper writes it. */
  readonly location: string | undefined;
  readonly start: number | undefined;
  readonly length: number;
  /** `file(line,column)`, to name it from another file. */
  readonly where: string;
}

/**
 * What a transform answers for one file, and what it asked of the files to be
 * made. Plain values rather than the expansion's inspection, whose lazy parts
 * hold on to the whole project it read: kept across edits, each would keep a
 * copy of every source's syntax for as long as the mapper lives.
 */
interface ExpandedFile {
  readonly text: string;
  readonly extension: VirtualExtension;
  readonly sourceText: string;
  readonly segments: readonly Segment[];
  readonly errors: readonly RaisedError[];
  /** What it asked, checked against the file system whose answers made it. */
  readonly consulted: readonly CheckedInput[];
}

/**
 * Text TypeScript sent for a file that differs from the file, and what the
 * file said when it was sent.
 */
type Overlay = Map<
  string,
  { readonly text: string; readonly disk: string | undefined }
>;

/**
 * One tsconfig, and what has been expanded from it.
 *
 * TypeScript closes and reopens a project whenever its snapshot changes --
 * in an editor, on every edit -- so this outlives any one project handle and
 * is found again by the config's name. It is replaced when the config itself
 * says something different; a change to which files it lists keeps what is
 * expanded, since a file's expansion reads only what its inputs say.
 *
 * Each expanded file keeps what its expansion asked of the files: its own
 * text, the macro modules it imported for syntax and every lookup made
 * resolving their imports, and, where a macro names a binding literal, all
 * the project read. It is answered from that for as long as each question
 * gets the same answer, whether the text is on disk or is an edit TypeScript
 * sent that is not saved yet. So an edit to a file that nothing imports for
 * syntax expands that file alone, and a change to a macro module expands
 * exactly the files that use it -- though every source is read again to do
 * either.
 */
interface ConfigState {
  readonly configFileName: string;
  /** Everything about the config that decides what expansion does. */
  readonly signature: string;
  /** As last loaded: the file list may have changed since the state was made. */
  project: LoadedSweetProject;
  /** What it was loaded from: while these hold, the config says the same. */
  configuration: readonly CheckedInput[];
  /** The project's files, by the names the mapper writes them. */
  listed: ReadonlySet<string>;
  /**
   * Whether the last expansion resolved binding literals, which makes every
   * file's expansion depend on the whole file list.
   */
  resolvesBindingLiterals: boolean;
  /** Expands through the config's overlay, in front of the disk. */
  readonly provider: DefaultProjectExpansionProvider;
  readonly expanded: Map<string, ExpandedFile>;
  /** The identity last given, kept while what it was made from holds. */
  identity: Identity | undefined;
  /**
   * Why reading the project's sources fails, where it does: every file's
   * expansion reads them all, so each would fail the same way and at the same
   * cost. Tried again once text changes or the project opens again.
   */
  readFailure: string | undefined;
  /**
   * Files whose expansion failed the last time it was tried. They say nothing
   * of what they read, so what would mend them is not known: see `#identityOf`.
   */
  readonly failed: Set<string>;
  /** What reading the project asked when a file last failed. */
  failureInputs: readonly ExpansionInput[];
  /**
   * Files TypeScript asked about that the config, as last loaded, does not
   * list, and whether each was on disk then. Loading the config walks
   * `include`, so a file is looked for again only once that changes.
   */
  readonly unlisted: Map<string, boolean>;
}

/**
 * A project's identity, and the answers it was made from: what the config
 * read, and what each file's expansion asked of any file but itself.
 */
interface Identity {
  readonly value: string;
  /** Every question asked, by kind and path, which says when it is stale. */
  readonly asked: string;
  readonly watchedFiles: readonly string[];
  readonly consulted: readonly CheckedInput[];
}

function listedFiles(project: LoadedSweetProject): ReadonlySet<string> {
  return new Set(project.typescript.fileNames.map(canonical));
}

/**
 * Remembers the text TypeScript holds for a file, if it is not the file's, and
 * says whether that changes what is held.
 */
function holdText(
  overlay: Overlay,
  fileName: string,
  content: string,
): boolean {
  const before = overlay.get(fileName)?.text;
  const disk = ts.sys.readFile(fileName);
  if (content === disk) {
    overlay.delete(fileName);
    return before !== undefined;
  }
  overlay.set(fileName, { text: content, disk });
  return before !== content;
}

/** What was thrown, in a sentence fit for the author to read. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A source's text as it stands: TypeScript's unsaved text, or the disk's. */
function currentText(overlay: Overlay, fileName: string): string | undefined {
  const disk = ts.sys.readFile(fileName);
  const sent = overlay.get(canonical(fileName));
  return sent !== undefined && sent.disk === disk ? sent.text : disk;
}

/**
 * A provider that expands the disk with TypeScript's unsaved text in front of
 * it, which is what its inputs are then checked against: a file held in the
 * overlay by its text, and any other by the disk's stat.
 */
function overlayProvider(overlay: Overlay): DefaultProjectExpansionProvider {
  return createDefaultProjectExpansionProvider({
    system: {
      ...ts.sys,
      readFile: (fileName) => currentText(overlay, fileName),
      fileExists: (fileName) =>
        overlay.has(canonical(fileName))
          ? currentText(overlay, fileName) !== undefined
          : ts.sys.fileExists(fileName),
    },
    stat: diskFileSystem.stat,
    held: (path) => overlay.has(canonical(path)),
  });
}

/**
 * What TypeScript 6's parser says about a compiler option -- unknown, or a
 * value it does not take -- which it leaves unset. The compiler running here
 * is TypeScript 7, which has options 6 does not and validates its config
 * itself, so these are its to report: `checkers` would otherwise have every
 * file refused over an option TypeScript accepts.
 */
const optionErrorsForTypeScript = new Set([5023, 5024, 5025, 6046]);

/** A file's expansion, if it has one, and the project it belongs to. */
interface Expanded {
  readonly file: ExpandedFile | undefined;
  readonly project: LoadedSweetProject;
}

/** Why a config cannot be used, and how TypeScript hears that changes. */
interface ConfigProblem {
  readonly code: number;
  readonly messageText: string;
  readonly identity: string;
  readonly watchedFiles: readonly string[];
}

/**
 * A file Sweetener could not expand, as TypeScript should see it: empty,
 * with one error at its start saying why. Empty rather than the source as
 * written, whose macro syntax would bury the reason under parse errors.
 */
function failedTransform(
  request: TransformParams,
  code: number,
  messageText: string,
): TransformResult {
  return {
    text: "",
    extension:
      virtualExtensions.get(
        macroExtensionTarget(extname(request.fileName)) ?? ".ts",
      ) ?? ".ts",
    mappings: [],
    diagnostics: [{ messageText, start: 0, length: 0, code }],
  };
}

function describeLocation(diagnostic: ts.Diagnostic): string {
  if (diagnostic.file === undefined || diagnostic.start === undefined)
    return diagnostic.file?.fileName ?? "";
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return `${diagnostic.file.fileName}(${line + 1},${character + 1})`;
}

/** What an inspection has for a transform, free of the expansion behind it. */
function expandedFile(
  fileName: string,
  inspection: DefaultSourceExpansionInspection,
  consulted: readonly CheckedInput[],
): ExpandedFile {
  const extension = virtualExtensions.get(extname(inspection.virtualFileName));
  if (extension === undefined)
    throw new Error(
      `Sweetener expanded ${fileName} to ${inspection.virtualFileName}, which TypeScript cannot take as a content-mapper output`,
    );
  const text = inspection.generated.text;
  return {
    text,
    extension,
    sourceText: inspection.sourceText,
    segments: segmentsForExpansion({
      index: inspection.index,
      generatedText: text,
      sourceText: inspection.sourceText,
      sourceId: inspection.sourceId as number,
      agree: createBindingAgreement(text, extension),
    }),
    // Errors only, which is what an inspection's diagnostics are: the protocol
    // has no severity, so a warning would arrive as an error and fail a build
    // that should pass.
    errors: inspection.diagnostics.map((diagnostic) => ({
      messageText: ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      ),
      code: diagnostic.code,
      location:
        diagnostic.file === undefined
          ? undefined
          : canonical(diagnostic.file.fileName),
      start: diagnostic.start,
      length: diagnostic.length ?? 0,
      where: describeLocation(diagnostic),
    })),
    consulted,
  };
}

/**
 * What went wrong expanding this file, where TypeScript can show it: at its
 * place for an error placed here, and at the top of the file, naming where it
 * happened, for any other. An error in a macro module is said by each file
 * using it as well as by the module: an editor asks about the files that are
 * open, and it is why this one did not expand.
 */
function reportedErrors(
  file: ExpandedFile,
  fileName: string,
  encoding: PositionEncoding,
): ContentMapperDiagnostic[] {
  const encode = offsetEncoder(file.sourceText, encoding);
  const end = file.sourceText.length;
  return file.errors.map(
    ({ messageText, code, location, start, length, where }) => {
      if (location === fileName && start !== undefined) {
        const from = Math.min(start, end);
        const to = Math.min(from + length, end);
        return {
          messageText,
          start: encode(from),
          length: encode(to) - encode(from),
          code,
        };
      }
      return {
        messageText: where === "" ? messageText : `${where}: ${messageText}`,
        start: 0,
        length: 0,
        code,
      };
    },
  );
}

/**
 * Sweetener as a TypeScript content mapper.
 *
 * The handlers answer the four requests TypeScript sends. Each project opens
 * with `dynamicConfig`: its identity is a digest of what the config read and
 * of what each file's expansion read from any file but itself -- the macro
 * modules, and the lookups that found them -- and those are its watched
 * files. That is what makes a change to a macro reach the files that use it:
 * TypeScript re-transforms a file when its own text changes, and otherwise
 * only when the project's identity does.
 */
export class SweetenerContentMapper {
  readonly #configs = new Map<string, ConfigState>();
  /**
   * TypeScript's unsaved text, by config. It stands in for the file until the
   * file changes: TypeScript re-sends a buffer it holds, but once a file is
   * saved or rewritten, the text it last sent for it may be older than the
   * disk -- and the file that imports it may well be asked for first. It
   * outlives a config's state: TypeScript re-sends a buffer only when it
   * changes, whatever became of the config meanwhile.
   */
  readonly #overlays = new Map<string, Overlay>();
  /** Each open project handle, and the config it names ("" for none). */
  readonly #handles = new Map<string, string>();
  /** Configs Sweetener cannot use, and what is wrong with each. */
  readonly #unusable = new Map<string, ConfigProblem>();
  #encoding: PositionEncoding | undefined;

  handlers(): ReadonlyMap<string, RequestHandler> {
    return new Map<string, RequestHandler>([
      ["initialize", (params) => this.initialize(params)],
      ["openProject", (params) => this.openProject(params)],
      ["transform", (params) => this.transform(params)],
      ["closeProject", (params) => this.closeProject(params)],
    ]);
  }

  initialize(raw: unknown): InitializeResult {
    const params = requireParams(
      raw,
      "initialize",
    ) as Partial<InitializeParams>;
    if (
      params.protocolVersion !== undefined &&
      params.protocolVersion !== protocolVersion
    )
      throw new ResponseError(
        ErrorCode.InvalidRequest,
        `Sweetener speaks content-mapper protocol ${protocolVersion}, and TypeScript asked for ${String(params.protocolVersion)}. Install a @sweetener/content-mapper built for this TypeScript.`,
      );
    const offered = Array.isArray(params.positionEncodings)
      ? params.positionEncodings
      : [];
    // A JavaScript string counts in UTF-16, so offsets need no conversion
    // when TypeScript accepts them.
    const encoding = offered.includes("utf-16")
      ? "utf-16"
      : offered.includes("utf-8")
        ? "utf-8"
        : undefined;
    if (encoding === undefined)
      throw new ResponseError(
        ErrorCode.InvalidParams,
        `TypeScript offered no position encoding Sweetener supports: ${JSON.stringify(offered)}`,
      );
    this.#encoding = encoding;
    return { protocolVersion, positionEncoding: encoding, diagnosticSource };
  }

  openProject(raw: unknown): OpenProjectResult {
    this.#requireInitialized();
    const params = requireParams(raw, "openProject") as Record<string, unknown>;
    const handle = requireString(params, "projectHandle", "openProject");
    const configFileName = requireString(
      params,
      "configFileName",
      "openProject",
    );
    // Sweetener reads its settings from the tsconfig's `sweet` section, which
    // the command line and every build integration read too. Options given
    // only to the content mapper would make the editor disagree with the
    // build, so they are refused rather than read or ignored.
    const optionDiagnostics =
      (params as Partial<OpenProjectParams>).options === undefined
        ? []
        : [
            {
              path: [],
              messageText:
                "Sweetener takes no content-mapper options: its settings are read from the tsconfig's `sweet` section.",
              code: 6001,
            },
          ];
    if (configFileName === "") {
      this.#handles.set(handle, "");
      // A file TypeScript opened with no tsconfig is expanded on its own, and
      // what it imports is only known once it is: there is nothing to watch.
      return {
        configIdentity: "standalone",
        watchedFiles: [],
        optionDiagnostics,
      };
    }
    this.#handles.set(handle, configFileName);
    const problems = this.#problemsWith(configFileName);
    this.#sweep();
    if (problems !== undefined)
      // TypeScript shows a failed request only as a failure, never why, so
      // what is wrong with the config is said where TypeScript shows the
      // mapper's own configuration problems -- at its `contentMappers` entry,
      // which `tsc` prints only where no file has an error -- and each file
      // it would have expanded says the same.
      return {
        configIdentity: problems.identity,
        watchedFiles: problems.watchedFiles,
        optionDiagnostics: [
          ...optionDiagnostics,
          {
            path: [],
            messageText: problems.messageText,
            code: problems.code,
          },
        ],
      };
    const state = this.#configs.get(configFileName)!;
    const identity = this.#identityOf(state);
    return {
      configIdentity: identity.value,
      watchedFiles: identity.watchedFiles,
      optionDiagnostics,
    };
  }

  transform(raw: unknown): TransformResult {
    const encoding = this.#requireInitialized();
    const params = requireParams(raw, "transform") as Record<string, unknown>;
    const request: TransformParams = {
      fileName: requireString(params, "fileName", "transform"),
      content: requireString(params, "content", "transform"),
      projectHandle: requireString(params, "projectHandle", "transform"),
    };
    const configFileName = this.#handles.get(request.projectHandle);
    if (configFileName === undefined)
      throw new ResponseError(
        ErrorCode.InvalidParams,
        `Unknown project handle ${JSON.stringify(request.projectHandle)}`,
      );
    const fileName = canonical(request.fileName);
    // Before anything else: text sent while the config is unusable is what
    // the file says once it is usable again.
    if (configFileName !== "") {
      const held = holdText(
        this.#overlayFor(configFileName),
        fileName,
        request.content,
      );
      const state = this.#configs.get(configFileName);
      if (state !== undefined) {
        if (held) state.readFailure = undefined;
        if (!state.listed.has(fileName)) this.#lookFor(state, fileName);
      }
    }
    const unusable = this.#unusable.get(configFileName);
    if (unusable !== undefined)
      return failedTransform(request, unusable.code, unusable.messageText);
    let expanded: Expanded;
    try {
      expanded =
        configFileName === ""
          ? this.#standalone(fileName, request.content)
          : this.#expansionFor(this.#configs.get(configFileName)!, fileName);
    } catch (error) {
      // A failure inside the compiler is still an answer about this file.
      // Thrown back as a failed request, TypeScript would report that the
      // mapper failed and drop what failed; returned as a diagnostic, the
      // author reads why, where the file is.
      process.stderr.write(
        `Sweetener failed to expand ${fileName}:\n${describeError(error)}\n`,
      );
      const state = this.#configs.get(configFileName);
      if (state !== undefined && state.readFailure === undefined)
        this.#recordFailure(state, [fileName]);
      return failedTransform(
        request,
        6201,
        `Project expansion failed: ${messageOf(error)}`,
      );
    }
    const { file, project } = expanded;
    if (file === undefined)
      return failedTransform(
        request,
        6202,
        configFileName === ""
          ? `Sweetener could not expand this file.`
          : !project.sweet.macroExtensions.includes(extname(fileName))
            ? `${configFileName} maps ${extname(fileName)} to Sweetener's content mapper, but its \`sweet.macroExtensions\` does not list ${extname(fileName)}, so Sweetener does not expand it. Add it there.`
            : `This file is not opted into Sweetener expansion by ${configFileName}. List it there, under "files" or "include".`,
      );
    return {
      text: file.text,
      extension: file.extension,
      mappings: encodeSegments(
        file.segments,
        file.text,
        file.sourceText,
        encoding,
      ),
      diagnostics: reportedErrors(file, fileName, encoding),
    };
  }

  closeProject(raw: unknown): null {
    const params = requireParams(
      raw,
      "closeProject",
    ) as Partial<CloseProjectParams>;
    const handle = requireString(
      params as Record<string, unknown>,
      "projectHandle",
      "closeProject",
    );
    // The config's state stays: TypeScript reopens a project as soon as it
    // has closed it, and what was expanded is still good for the next one.
    if (!this.#handles.delete(handle))
      throw new ResponseError(
        ErrorCode.InvalidParams,
        `Unknown project handle ${JSON.stringify(handle)}`,
      );
    return null;
  }

  #requireInitialized(): PositionEncoding {
    if (this.#encoding === undefined)
      throw new ResponseError(
        ErrorCode.InvalidRequest,
        "The Sweetener content mapper has not been initialized",
      );
    return this.#encoding;
  }

  /**
   * Bring the config's state up to date, and say what is wrong with it if
   * Sweetener cannot use it. Nothing is expanded from a config with problems;
   * one that later loses them starts afresh.
   *
   * A config is not loaded again while everything it was loaded from says the
   * same, which spares walking `include` at every edit: a file it does not
   * list yet is found when TypeScript asks for it (`force`). Binding literals
   * resolve over the whole file list, so a project that has them loads it.
   */
  #problemsWith(
    configFileName: string,
    force = false,
  ): ConfigProblem | undefined {
    const kept = this.#configs.get(configFileName);
    if (
      !force &&
      kept !== undefined &&
      !kept.resolvesBindingLiterals &&
      new InputCheckRound().hold(kept.configuration)
    ) {
      this.#configs.delete(configFileName);
      this.#configs.set(configFileName, kept);
      this.#refresh(kept);
      return undefined;
    }
    const loadedAt = nowNanoseconds();
    let loaded:
      { readonly project: LoadedSweetProject } | { readonly failure: string };
    try {
      loaded = { project: loadSweetProject(configFileName) };
    } catch (error) {
      loaded = { failure: messageOf(error) };
    }
    const problems =
      "failure" in loaded
        ? [loaded.failure]
        : configurationProblems(loaded.project, optionErrorsForTypeScript);
    if (problems.length > 0 || !("project" in loaded)) {
      const messageText = `Sweetener cannot use ${configFileName}: ${problems.join("; ")}`;
      // Whichever config in the chain it was, a change to it has to reach
      // TypeScript, or it keeps files emptied for a reason no longer true.
      const inputs =
        "project" in loaded ? loaded.project.configurationInputs : [];
      const problem: ConfigProblem = {
        code: 6001,
        messageText,
        identity: fingerprint([
          canonical(configFileName),
          messageText,
          ts.sys.readFile(configFileName) ?? "<missing>",
          ...inputs.map((input) => JSON.stringify(input)),
        ]),
        watchedFiles: [
          ...new Set([
            canonical(configFileName),
            ...inputs.map(({ path }) => canonical(path)),
          ]),
        ].sort(),
      };
      this.#unusable.set(configFileName, problem);
      this.#configs.delete(configFileName);
      return problem;
    }
    this.#unusable.delete(configFileName);
    this.#stateFor(
      configFileName,
      loaded.project,
      checkedInputs(
        diskFileSystem,
        loadedAt,
      )(loaded.project.configurationInputs),
    );
    return undefined;
  }

  #overlayFor(configFileName: string): Overlay {
    let overlay = this.#overlays.get(configFileName);
    if (overlay === undefined) {
      overlay = new Map();
      this.#overlays.set(configFileName, overlay);
    }
    return overlay;
  }

  /**
   * The state for a config, kept from before if the config still says the
   * same thing, and otherwise made fresh by expanding the whole project --
   * which is what a `tsc` run is about to ask for, one file at a time. What
   * opens the project has only what is expanded to say what it depends on, so
   * a kept state's stale files are expanded again first: saved, a macro module
   * may import something new, which is to be watched from here.
   */
  #stateFor(
    configFileName: string,
    project: LoadedSweetProject,
    configuration: readonly CheckedInput[],
  ): ConfigState {
    const signature = projectSignature(project);
    const existing = this.#configs.get(configFileName);
    if (existing !== undefined && existing.signature === signature) {
      // Last in the map is last opened, which is what `#sweep` keeps.
      this.#configs.delete(configFileName);
      this.#configs.set(configFileName, existing);
      existing.configuration = configuration;
      existing.unlisted.clear();
      this.#relist(existing, project);
      this.#refresh(existing);
      return existing;
    }
    const overlay = this.#overlayFor(configFileName);
    const state: ConfigState = {
      configFileName,
      signature,
      project,
      configuration,
      listed: listedFiles(project),
      resolvesBindingLiterals: false,
      provider: overlayProvider(overlay),
      expanded: new Map(),
      identity: undefined,
      readFailure: undefined,
      failed: new Set(),
      failureInputs: [],
      unlisted: new Map(),
    };
    this.#expandOrForget(state, undefined);
    this.#configs.delete(configFileName);
    this.#configs.set(configFileName, state);
    return state;
  }

  /**
   * Let go of what no open project needs: a config whose file is gone, and
   * all but the configs opened last, with the text held for them; and text
   * held for a file that has since changed on disk or gone. That no longer
   * stands in for the file, and would again if the disk went back.
   */
  #sweep(): void {
    const open = new Set(this.#handles.values());
    for (const name of new Set([
      ...this.#configs.keys(),
      ...this.#overlays.keys(),
      ...this.#unusable.keys(),
    ]))
      if (!open.has(name) && !ts.sys.fileExists(name)) {
        this.#configs.delete(name);
        this.#overlays.delete(name);
        this.#unusable.delete(name);
      }
    const closed = [...this.#configs.keys()].filter((name) => !open.has(name));
    for (const name of closed.slice(0, -keptClosedConfigs)) {
      this.#configs.delete(name);
      this.#overlays.delete(name);
    }
    for (const overlay of this.#overlays.values())
      for (const [fileName, { disk }] of overlay)
        if (ts.sys.readFile(fileName) !== disk) overlay.delete(fileName);
  }

  /**
   * Load the config again for a file it did not list: it may be new. The load
   * may find the config can no longer be used, which is then what the file
   * hears.
   */
  #lookFor(state: ConfigState, fileName: string): void {
    const onDisk = ts.sys.fileExists(fileName);
    if (state.unlisted.get(fileName) === onDisk) return;
    this.#problemsWith(state.configFileName, true);
    this.#configs.get(state.configFileName)?.unlisted.set(fileName, onDisk);
  }

  /**
   * Expand again what no longer holds, before anything is said of what the
   * project depends on, and try again what failed: mended, it says what it
   * read, and TypeScript never asks for a file it does not transform.
   */
  #refresh(state: ConfigState): void {
    state.readFailure = undefined;
    const round = new InputCheckRound();
    const stale = [...state.expanded]
      .filter(([, file]) => !round.hold(file.consulted))
      .map(([name]) => name);
    const again = new Set([...stale, ...state.failed]);
    if (again.size > 0) this.#expandOrForget(state, [...again]);
  }

  /**
   * Bring a kept state up to the project as just loaded. A file made or gone
   * changes what expands only for the files that looked for it, which their
   * inputs say, so only a file newly listed is expanded here -- unless binding
   * literals were resolved, over a program of the whole file list.
   */
  #relist(state: ConfigState, project: LoadedSweetProject): void {
    state.project = project;
    const listed = listedFiles(project);
    const added = [...listed].filter((name) => !state.listed.has(name));
    if (added.length === 0 && listed.size === state.listed.size) return;
    state.listed = listed;
    for (const name of state.expanded.keys())
      if (!listed.has(name)) state.expanded.delete(name);
    if (state.resolvesBindingLiterals) this.#expandOrForget(state, undefined);
    else if (added.length > 0) this.#expandOrForget(state, added);
  }

  /**
   * Expand these files together, or every one. Where that fails, each is left
   * to be expanded alone when it is asked for, so what is wrong with one is
   * not said of all -- unless it is reading the sources that fails, which
   * every one of them does.
   */
  #expandOrForget(
    state: ConfigState,
    fileNames: readonly string[] | undefined,
  ): void {
    try {
      this.#expand(state, fileNames);
    } catch (error) {
      process.stderr.write(
        `Sweetener failed to expand ${state.configFileName}:\n${describeError(error)}\n`,
      );
      this.#recordFailure(state, fileNames ?? state.listed);
    }
  }

  /**
   * Leaves these files to be expanded alone when asked for, and finds out what
   * else can be said: what reading the project asks of the files, which is what
   * could mend them, and whether reading is itself what fails.
   */
  #recordFailure(state: ConfigState, fileNames: Iterable<string>): void {
    for (const name of fileNames) {
      state.expanded.delete(name);
      state.failed.add(name);
    }
    try {
      state.failureInputs = state.provider.expandProject(state.project, {
        files: new Set(),
      }).inputs;
    } catch (reading) {
      state.readFailure = messageOf(reading);
    }
  }

  /**
   * Expand these files together, or every one, against the project's text as
   * it stands: TypeScript's for a file it sent, the disk's for any other.
   */
  #expand(state: ConfigState, fileNames: readonly string[] | undefined): void {
    const expandedAt = nowNanoseconds();
    // Named as the provider names them, which on Windows is not how this
    // mapper writes them.
    const output = state.provider.expandProject(state.project, {
      files:
        fileNames === undefined
          ? undefined
          : new Set(fileNames.map((name) => resolve(name))),
    });
    state.resolvesBindingLiterals = output.resolvesBindingLiterals;
    const check = checkedInputs(state.provider.fileSystem, expandedAt);
    for (const fileName of fileNames ??
      state.project.typescript.fileNames.map(canonical)) {
      state.failed.delete(fileName);
      const inspection = state.provider.inspectSource(fileName);
      if (inspection === undefined) {
        state.expanded.delete(fileName);
        continue;
      }
      state.expanded.set(
        fileName,
        expandedFile(fileName, inspection, check(inspection.inputs)),
      );
    }
    // What the state keeps is plain by now, and each inspection holds the
    // whole project: kept in the provider, one per config would stay.
    state.provider.releaseInspections();
  }

  /**
   * This file's expansion against the text TypeScript holds, which has joined
   * the overlay. A file the project does not expand has none, and reading
   * every source would only say so again.
   *
   * Every expansion whose inputs no longer hold is stale. When this file's
   * is, it is expanded again together with every other stale file: after an
   * edit that is the one file, and after a saved change to a macro module it
   * is every file that module reaches, which is cheaper expanded at once than
   * one at a time as TypeScript asks.
   */
  #expansionFor(state: ConfigState, fileName: string): Expanded {
    if (
      !state.listed.has(fileName) ||
      !state.project.sweet.macroExtensions.includes(extname(fileName))
    )
      return { file: undefined, project: state.project };
    if (state.readFailure !== undefined) throw new Error(state.readFailure);
    // One round for the request: each file is read once, however many
    // expansions asked of it.
    const round = new InputCheckRound();
    const fresh = (file: ExpandedFile) => round.hold(file.consulted);
    const cached = state.expanded.get(fileName);
    if (cached !== undefined && fresh(cached))
      return { file: cached, project: state.project };
    const others = [...state.expanded]
      .filter(([name, file]) => name !== fileName && !fresh(file))
      .map(([name]) => name);
    if (others.length > 0) {
      this.#expandOrForget(state, [fileName, ...others]);
      if (state.readFailure !== undefined) throw new Error(state.readFailure);
    }
    // Alone if there were no others, or if expanding them with it failed: a
    // failure then is this file's to report.
    if (others.length === 0 || !state.expanded.has(fileName))
      this.#expand(state, [fileName]);
    return { file: state.expanded.get(fileName), project: state.project };
  }

  /**
   * The project's identity: what the config read, and what each file's
   * expansion asked of any file but itself, answered as things stand -- the
   * disk, with TypeScript's unsaved text in front of it. A file's own text is
   * left out, since TypeScript transforms a file again when that changes;
   * folded in, every keystroke would make TypeScript transform every file.
   *
   * A file whose expansion failed read nothing it can say, so while one has,
   * every source the project lists and everything reading it asked counts: a
   * fix to any of them has to reach TypeScript, which otherwise keeps the file
   * emptied.
   *
   * It is kept while those questions are the same and each gets the same
   * answer, which a stat says for a file on disk, so an unchanged project
   * reads none of them again. What a transform goes on to read is heard at the
   * next open: the protocol asks for an identity only there, before the text
   * that made the change arrives.
   */
  #identityOf(state: ConfigState): Identity {
    const names = new Map<string, string>();
    const nameOf = (path: string): string => {
      let name = names.get(path);
      if (name === undefined) {
        name = canonical(path);
        names.set(path, name);
      }
      return name;
    };
    const questions = new Map<string, ExpansionInput>();
    const ask = (input: ExpansionInput) =>
      questions.set(`${input.kind}\0${nameOf(input.path)}`, input);
    for (const input of state.project.configurationInputs) ask(input);
    // Where binding literals are resolved every file shares one list of the
    // whole project's inputs, walked once. Each of those files read the others,
    // so only a file with a list of its own leaves anything out of it.
    const readers = new Map<readonly CheckedInput[], string[]>();
    for (const [fileName, { consulted }] of state.expanded) {
      const listReaders = readers.get(consulted);
      if (listReaders === undefined) readers.set(consulted, [fileName]);
      else listReaders.push(fileName);
    }
    for (const [consulted, fileNames] of readers) {
      const only = fileNames.length === 1 ? fileNames[0] : undefined;
      for (const { input } of consulted)
        if (input.kind !== "file" || nameOf(input.path) !== only) ask(input);
    }
    if (state.failed.size > 0) {
      for (const path of state.listed)
        ask({ kind: "file", path, text: undefined });
      for (const input of state.failureInputs) ask(input);
    }
    const asked = [...questions.keys()].sort();
    const askedKey = fingerprint(asked);
    const kept = state.identity;
    if (
      kept !== undefined &&
      kept.asked === askedKey &&
      new InputCheckRound().hold(kept.consulted)
    )
      return kept;
    const answeredAt = nowNanoseconds();
    const recorder = new InputRecorder(state.provider.fileSystem.system);
    const answers = asked.map((question) =>
      recorder.ask(questions.get(question)!),
    );
    const identity: Identity = {
      value: fingerprint(answers.map((answer) => JSON.stringify(answer))),
      asked: askedKey,
      watchedFiles: [
        ...new Set([
          canonical(state.configFileName),
          ...answers.map(({ path }) => canonical(path)),
        ]),
      ].sort(),
      consulted: checkedInputs(state.provider.fileSystem, answeredAt)(answers),
    };
    state.identity = identity;
    return identity;
  }

  /** A file with no tsconfig, expanded on its own every time it is asked. */
  #standalone(fileName: string, content: string): Expanded {
    const project = loadStandaloneProject([fileName]);
    const overlay: Overlay = new Map([
      [fileName, { text: content, disk: ts.sys.readFile(fileName) }],
    ]);
    const provider = overlayProvider(overlay);
    provider.expandProject(project);
    const inspection = provider.inspectSource(fileName);
    return {
      file:
        inspection === undefined
          ? undefined
          : expandedFile(fileName, inspection, []),
      project,
    };
  }
}
