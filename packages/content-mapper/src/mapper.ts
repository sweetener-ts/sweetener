import { dirname, extname, resolve, sep } from "node:path";
import {
  checkedInputs,
  configurationProblems,
  createDefaultProjectExpansionProvider,
  diagnosticPosition,
  diskFileSystem,
  fingerprint,
  InputCheckRound,
  InputRecorder,
  loadSweetProject,
  macroExtensionTarget,
  nowNanoseconds,
  statIsSettled,
  projectSignature,
  type CheckedInput,
  type DefaultProjectExpansionProvider,
  type DefaultSourceExpansionInspection,
  type ExpansionInput,
  type LoadedSweetProject,
  typescript as ts,
} from "@sweetener/compiler";
import { createBindingAgreement, readsAsModule } from "./binding-agreement.js";
import {
  describeError,
  ErrorCode,
  isObject,
  messageOf,
  ResponseError,
  type RequestHandler,
} from "./json-rpc.js";
import {
  protocolVersion,
  type ContentMapperDiagnostic,
  type InitializeParams,
  type InitializeResult,
  type OpenProjectResult,
  type PositionEncoding,
  type TransformParams,
  type TransformResult,
  type VirtualExtension,
} from "./protocol.js";
import {
  encodeSegments,
  mappedSegments,
  offsetEncoder,
  regionSegments,
  type Segment,
} from "./span-mappings.js";

/** What TypeScript prints in front of a code, as every Sweetener surface does. */
export const diagnosticSource = "SWR";

/** The tsconfig cannot be used, or gives the mapper options it does not take. */
const unusableConfigCode = 6001;
/** The compiler failed expanding a file. */
const expansionFailedCode = 6201;
/** A file is one no config in reach would have Sweetener expand. */
const notOptedInCode = 6202;

/**
 * How many configs with no project open keep what they expanded. TypeScript
 * closes a project and opens it again when a file it was told to watch changes,
 * so one is usually back at once; a session through many worktrees should not
 * keep them all.
 */
const keptClosedConfigs = 8;

/**
 * How many files' unsaved text is kept, the oldest letting go first: TypeScript
 * says nothing of a buffer closed in a project it no longer has open, so this
 * could otherwise only grow.
 */
const keptUnsavedFiles = 256;

/** How long after walking `include` a file it did not list is taken at its word. */
const lookAgainNanoseconds = 2_000_000_000n;

const virtualExtensions: ReadonlySet<string> = new Set<VirtualExtension>([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

function isVirtualExtension(extension: string): extension is VirtualExtension {
  return virtualExtensions.has(extension);
}

function canonical(fileName: string): string {
  // On Windows a backslash separates; elsewhere a name may hold one.
  const absolute = resolve(fileName);
  return sep === "\\" ? absolute.replaceAll("\\", "/") : absolute;
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
  /** `file:line:column`, to name it from another file. */
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
  /** Worked out when it is asked for, which may be never. */
  segments(): readonly Segment[];
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
  {
    readonly fileName: string;
    readonly text: string;
    readonly disk: string | undefined;
  }
>;

/**
 * What text held for a file is found by. Where the disk does not tell cases
 * apart, an import may spell a macro module in a case TypeScript does not, and
 * reads the same file.
 */
function heldKey(fileName: string): string {
  const name = canonical(fileName);
  return ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase();
}

/**
 * One tsconfig, and what has been expanded from it.
 *
 * TypeScript closes and reopens a project when a file it was told to watch
 * changes, so this outlives any one project handle and is found again by the
 * config's name. An edit to any other file reaches here as a transform alone.
 * It is replaced when the config itself says something different; a change to
 * which files it lists keeps what is expanded, since a file's expansion reads
 * only what its inputs say.
 *
 * Each expanded file keeps what its expansion asked of the files: its own
 * text, the macro modules it imported for syntax and every lookup made
 * resolving their imports, and, where a macro names a binding literal, all
 * the project read. It is answered from that for as long as each question
 * gets the same answer, whether the text is on disk or is an edit TypeScript
 * sent that is not saved yet. So an edit to a file that nothing imports for
 * syntax expands that file alone, and a change to a macro module expands
 * exactly the files that use it, reading only those and their macro modules.
 */
interface ConfigState {
  readonly configFileName: string;
  /** Everything about the config that decides what expansion does. */
  readonly signature: string;
  /** As last loaded: the file list may have changed since the state was made. */
  project: LoadedSweetProject;
  /** What it was loaded from: while these hold, the config says the same. */
  configuration: readonly CheckedInput[];
  /** When the config was last loaded, which is when `include` was walked. */
  loadedAt: bigint;
  /** The project's files, by the names the mapper writes them. */
  listed: ReadonlySet<string>;
  /**
   * The expanded files that read binding literals, whose expansions depend on the
   * whole file list.
   */
  readonly literalReaders: Set<string>;
  /** Expands through the overlay, in front of the disk. */
  readonly provider: DefaultProjectExpansionProvider;
  readonly expanded: Map<string, ExpandedFile>;
  /**
   * The configs of the projects this one references, read at each open:
   * TypeScript reads their sources through this project, so what those read
   * counts for its identity.
   */
  readonly references: Set<string>;
  /** The identity last given, kept while what it was made from holds. */
  identity: Identity | undefined;
  /**
   * Files whose expansion failed the last time it was tried, and what that read,
   * which is when to try again: they failed on it. They say nothing
   * of what they read, so what would mend them is not known: see `#identityOf`.
   */
  readonly failed: Map<string, readonly CheckedInput[]>;
  /**
   * Whether a file it asked about was taken at the config's word, `include` having
   * been walked too recently to look again, so the next open should.
   */
  walkAgain: boolean;
  /**
   * The round in which it last looked for a file it had not heard of: a file
   * first asked about is looked for, and many of them at once by one walk.
   */
  lookedIn: InputCheckRound | undefined;
  /** What was read by the expansions that failed, while any file has. */
  readonly failureInputs: Map<string, ExpansionInput>;
  /**
   * Files TypeScript asked about that the config, as last loaded, does not
   * list, and whether each was on disk then. Loading the config walks
   * `include`, so a file is looked for again only once that changes.
   */
  readonly unlisted: Map<string, boolean>;
  /**
   * How many of those have come to be listed. TypeScript keeps what it was told
   * of one, that it is not opted in, for as long as the identity stays the same.
   */
  nowListed: number;
}

/**
 * An expansion that failed, and what it had read, which is what could mend it.
 * It holds the text of everything read, so it goes no further than to where the
 * failure is recorded.
 */
class FailedExpansion extends Error {
  constructor(
    failure: unknown,
    readonly inputs: readonly ExpansionInput[],
    /** When the expansion began. */
    readonly at: bigint,
  ) {
    super(messageOf(failure));
    this.stack = describeError(failure);
  }
}

/** A file's segments, whose failure is the failure of expanding it. */
function segmentsOf(file: ExpandedFile): readonly Segment[] {
  try {
    return file.segments();
  } catch (error) {
    throw new FailedExpansion(
      error,
      file.consulted.map(({ input }) => input),
      nowNanoseconds(),
    );
  }
}

/** Whether a config has Sweetener expand a file of this name, listed or not. */
function expandsExtensionOf(state: ConfigState, fileName: string): boolean {
  return state.project.sweet.macroExtensions.includes(extname(fileName));
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
  const key = heldKey(fileName);
  const before = overlay.get(key)?.text;
  const disk = ts.sys.readFile(fileName);
  overlay.delete(key);
  if (content === disk) return before !== undefined;
  overlay.set(key, { fileName, text: content, disk });
  for (const oldest of overlay.keys()) {
    if (overlay.size <= keptUnsavedFiles) break;
    overlay.delete(oldest);
  }
  return before !== content;
}

/** A source's text as it stands: TypeScript's unsaved text, or the disk's. */
function currentText(overlay: Overlay, fileName: string): string | undefined {
  const disk = ts.sys.readFile(fileName);
  const sent = overlay.get(heldKey(fileName));
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
        overlay.has(heldKey(fileName))
          ? currentText(overlay, fileName) !== undefined
          : ts.sys.fileExists(fileName),
    },
    stat: diskFileSystem.stat,
    held: (path) => overlay.has(heldKey(path)),
  });
}

/**
 * What TypeScript 6's parser says of a config that TypeScript 7, the compiler
 * running here, judges for itself: an unknown option or a value it does not
 * take, where 7 has options 6 does not and `checkers` would otherwise have every
 * file refused over an option TypeScript accepts; and no inputs found, which a
 * checkout may make true for a moment and a file made later makes false.
 */
const errorsForTypeScript = new Set([5023, 5024, 5025, 6046, 18002, 18003]);

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
  const target = macroExtensionTarget(extname(request.fileName));
  return {
    text: "",
    extension:
      target !== undefined && isVirtualExtension(target) ? target : ".ts",
    mappings: [],
    diagnostics: [{ messageText, start: 0, length: 0, code }],
  };
}

/** What an inspection has for a transform, free of the expansion behind it. */
function expandedFile(
  fileName: string,
  inspection: DefaultSourceExpansionInspection,
  consulted: readonly CheckedInput[],
): ExpandedFile {
  const extension = extname(inspection.virtualFileName);
  if (!isVirtualExtension(extension))
    throw new Error(
      `Sweetener expanded ${fileName} to ${inspection.virtualFileName}, which TypeScript cannot take as a content-mapper output`,
    );
  // Where its macros did not run, what was generated is the file as written, and
  // their syntax would bury the reason under TypeScript's parse errors.
  const generated = inspection.macrosFailed ? "" : inspection.generated.text;
  // Its imports for syntax are gone, and without another import or an export
  // TypeScript reads it as a script, whose names every other script shares.
  const text =
    inspection.macrosFailed || readsAsModule(generated, extension)
      ? generated
      : `${generated}\nexport {};\n`;
  const { sourceText } = inspection;
  const regions = inspection.macrosFailed
    ? []
    : regionSegments({
        index: inspection.index,
        generatedText: text,
        sourceText,
        sourceId: inspection.sourceId as number,
        origins: inspection.origins,
      });
  let segments: readonly Segment[] | undefined;
  return {
    text,
    extension,
    sourceText,
    segments: () =>
      (segments ??= mappedSegments(
        regions,
        createBindingAgreement(text, extension),
        text,
        sourceText,
      )),
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
      where:
        diagnosticPosition(diagnostic.file, diagnostic.start) ??
        diagnostic.file?.fileName ??
        "",
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
  if (file.errors.length === 0) return [];
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
   * TypeScript's unsaved text, which belongs to a file whichever projects read
   * it. It stands in for the file until the file changes: TypeScript re-sends a
   * buffer it holds, but once a file is saved or rewritten, the text it last sent
   * for it may be older than the disk -- and the file that imports it may well be
   * asked for first. It outlives any config's state: TypeScript re-sends a buffer
   * only when it changes, whatever became of the config meanwhile.
   */
  readonly #overlay: Overlay = new Map();
  /**
   * The answers to what expansions read, for as long as nothing has been said
   * that could change them: TypeScript sends new text or opens a project when one
   * does. Asked anew for each file, a `tsc` run of files sharing one list of
   * inputs, as binding literals have them share, walks it once per file.
   */
  #round = new InputCheckRound();
  /** Every config that has been opened and not let go of, last opened last. */
  readonly #opened = new Set<string>();
  /** Each open project handle, and the config it names. */
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
    const params = requireParams(raw, "openProject");
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
      params["options"] === undefined || params["options"] === null
        ? []
        : [
            {
              path: [],
              messageText:
                "Sweetener takes no content-mapper options: its settings are read from the tsconfig's `sweet` section.",
              code: unusableConfigCode,
            },
          ];
    if (configFileName === "")
      // TypeScript has no tsconfig to name only for an inferred project, and it
      // starts a mapper for one only where an extension contributes that, which
      // editors/vscode does not. Without a tsconfig there is no project to
      // expand a file in, and no `sweet` section to do it by.
      throw new ResponseError(
        ErrorCode.InvalidParams,
        "Sweetener expands a file only as part of a project: name it in a tsconfig that lists @sweetener/content-mapper",
      );
    this.#round = new InputCheckRound();
    this.#handles.set(handle, configFileName);
    this.#opened.delete(configFileName);
    this.#opened.add(configFileName);
    const problems = this.#problemsWith(configFileName);
    const opened = this.#configs.get(configFileName);
    if (opened !== undefined)
      this.#openReferences(opened, new Set([configFileName]));
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
    const params = requireParams(raw, "transform");
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
    const opened = this.#configs.get(configFileName);
    const fileName = this.#asListed(opened, canonical(request.fileName));
    // Before anything else: text sent while the config is unusable is what
    // the file says once it is usable again.
    if (holdText(this.#overlay, fileName, request.content))
      this.#round = new InputCheckRound();
    const referenced =
      opened === undefined || opened.listed.has(fileName)
        ? undefined
        : this.#owningReference(opened, fileName);
    if (referenced !== undefined && "messageText" in referenced)
      return failedTransform(request, referenced.code, referenced.messageText);
    const unusable = this.#unusable.get(configFileName);
    if (unusable !== undefined)
      return failedTransform(request, unusable.code, unusable.messageText);
    const state = referenced ?? this.#configs.get(configFileName);
    if (state === undefined)
      throw new ResponseError(
        ErrorCode.InternalError,
        `${configFileName} has a project open and neither a state nor a problem`,
      );
    // Text other than what was expanded is news, whatever the disk says: it may
    // be the disk that changed, under a file others read.
    const kept = state.expanded.get(fileName);
    if (kept !== undefined && kept.sourceText !== request.content)
      this.#round = new InputCheckRound();
    let file: ExpandedFile | undefined;
    let segments: readonly Segment[] = [];
    try {
      file = this.#expansionFor(state, fileName);
      // A file changed on disk while it was read is expanded from the disk, and
      // TypeScript holds what it sent: mapped to anything else, the answer is
      // refused. What it sent stands in front of that change now.
      if (file !== undefined && file.sourceText !== request.content) {
        holdText(this.#overlay, fileName, request.content);
        this.#expand(state, [fileName]);
        file = state.expanded.get(fileName);
        if (file !== undefined && file.sourceText !== request.content)
          throw new FailedExpansion(
            new Error(
              `${fileName} went on changing on disk while it was expanded`,
            ),
            file.consulted.map(({ input }) => input),
            nowNanoseconds(),
          );
      }
      if (file !== undefined) segments = segmentsOf(file);
    } catch (error) {
      // A failure inside the compiler is still an answer about this file.
      // Thrown back as a failed request, TypeScript would report that the
      // mapper failed and drop what failed; returned as a diagnostic, the
      // author reads why, where the file is.
      process.stderr.write(
        `Sweetener failed to expand ${fileName}:\n${describeError(error)}\n`,
      );
      this.#recordFailure(state, [fileName], error);
      return failedTransform(
        request,
        expansionFailedCode,
        `Project expansion failed: ${messageOf(error)}`,
      );
    }
    if (file === undefined)
      return failedTransform(
        request,
        notOptedInCode,
        !expandsExtensionOf(state, fileName)
          ? `${state.configFileName} maps ${extname(fileName)} to Sweetener's content mapper, but its \`sweet.macroExtensions\` does not list ${extname(fileName)}, so Sweetener does not expand it. Add it there.`
          : `This file is not opted into Sweetener expansion by ${state.configFileName}. List it there, under "files" or "include".`,
      );
    return {
      text: file.text,
      extension: file.extension,
      mappings: encodeSegments(segments, file.text, file.sourceText, encoding),
      diagnostics: reportedErrors(file, fileName, encoding),
    };
  }

  closeProject(raw: unknown): null {
    const handle = requireString(
      requireParams(raw, "closeProject"),
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
   * same, which spares walking `include` at every open: a file it does not
   * list yet is found when TypeScript asks for it (`force`), and again when one
   * it asked about comes or goes on disk. Binding literals resolve over the
   * whole file list, so a project that has them loads it.
   */
  #problemsWith(
    configFileName: string,
    force = false,
  ): ConfigProblem | undefined {
    const kept = this.#configs.get(configFileName);
    if (
      !force &&
      kept !== undefined &&
      kept.literalReaders.size === 0 &&
      !kept.walkAgain &&
      [...kept.unlisted].every(
        ([name, onDisk]) => ts.sys.fileExists(name) === onDisk,
      ) &&
      this.#round.hold(kept.configuration)
    ) {
      this.#refresh(kept);
      return undefined;
    }
    const loadedAt = nowNanoseconds();
    let project: LoadedSweetProject | undefined;
    let problems: readonly string[];
    try {
      project = loadSweetProject(configFileName);
      problems = configurationProblems(project, errorsForTypeScript);
    } catch (error) {
      problems = [messageOf(error)];
    }
    if (project === undefined || problems.length > 0) {
      const messageText = `Sweetener cannot use ${configFileName}: ${problems.join("; ")}`;
      // Whichever config in the chain it was, a change to it has to reach
      // TypeScript, or it keeps files emptied for a reason no longer true.
      const inputs = project?.configurationInputs ?? [];
      const problem: ConfigProblem = {
        code: unusableConfigCode,
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
      project,
      checkedInputs(diskFileSystem, loadedAt)(project.configurationInputs),
      loadedAt,
    );
    return undefined;
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
    loadedAt: bigint,
  ): void {
    const signature = projectSignature(project);
    const existing = this.#configs.get(configFileName);
    if (existing !== undefined && existing.signature === signature) {
      existing.configuration = configuration;
      existing.walkAgain = false;
      existing.loadedAt = loadedAt;
      this.#relist(existing, project);
      this.#refresh(existing);
      return;
    }
    const state: ConfigState = {
      configFileName,
      signature,
      project,
      configuration,
      loadedAt,
      listed: listedFiles(project),
      literalReaders: new Set(),
      provider: overlayProvider(this.#overlay),
      expanded: new Map(),
      // Read again at the next open; until then, as they were, or a file a
      // referenced project lists would be refused for a change to this config.
      references: new Set(existing?.references),
      identity: undefined,
      failed: new Map(),
      walkAgain: false,
      lookedIn: undefined,
      failureInputs: new Map(),
      unlisted: new Map(),
      nowListed: 0,
    };
    this.#expandOrForget(state, this.#expandable(state));
    this.#configs.set(configFileName, state);
  }

  /**
   * Let go of what no open project needs: a config whose file is gone, and all
   * but the configs opened last; and text held for a file that has since changed
   * on disk or gone. That no longer stands in for the file, and would again if
   * the disk went back.
   */
  #sweep(): void {
    // What an open project references is read through it, and is as open as it.
    const open = new Set(this.#handles.values());
    for (const name of [...open]) {
      const state = this.#configs.get(name);
      if (state !== undefined)
        for (const reference of this.#referencesOf(state)) open.add(reference);
    }
    const forget = (name: string) => {
      this.#opened.delete(name);
      this.#configs.delete(name);
      this.#unusable.delete(name);
    };
    for (const name of this.#opened)
      if (!open.has(name) && !ts.sys.fileExists(name)) forget(name);
    const closed = [...this.#opened].filter((name) => !open.has(name));
    for (const name of closed.slice(0, -keptClosedConfigs)) forget(name);
    for (const [key, { fileName, disk }] of this.#overlay)
      if (ts.sys.readFile(fileName) !== disk) this.#overlay.delete(key);
  }

  /**
   * Read the projects this one references, however far: each loaded and brought
   * up to date once, here, since what they read counts for this one's identity
   * and transforms are not the place to find that out.
   */
  #openReferences(state: ConfigState, seen: Set<string>): void {
    state.references.clear();
    for (const reference of state.project.typescript.projectReferences ?? []) {
      const configFileName = ts.resolveProjectReferencePath(reference);
      state.references.add(configFileName);
      if (seen.has(configFileName)) continue;
      seen.add(configFileName);
      this.#opened.delete(configFileName);
      this.#opened.add(configFileName);
      this.#problemsWith(configFileName);
      const referenced = this.#configs.get(configFileName);
      if (referenced !== undefined) this.#openReferences(referenced, seen);
    }
  }

  /** The configs this one references, however far, as last opened. */
  #referencesOf(state: ConfigState): string[] {
    const seen = new Set([state.configFileName]);
    const pending = [state];
    for (const current of pending)
      for (const reference of current.references) {
        if (seen.has(reference)) continue;
        seen.add(reference);
        const referenced = this.#configs.get(reference);
        if (referenced !== undefined) pending.push(referenced);
      }
    seen.delete(state.configFileName);
    return [...seen];
  }

  /** This config and those it references, as far as each could be used. */
  #withReferences(state: ConfigState): ConfigState[] {
    return [
      state,
      ...this.#referencesOf(state).flatMap(
        (reference) => this.#configs.get(reference) ?? [],
      ),
    ];
  }

  /**
   * A file as the project spells it, where the disk does not tell cases apart and
   * TypeScript was told it by an import that does not: `./Util.sts` for `util.sts`
   * is one file, whose own error is TypeScript's to report.
   */
  #asListed(state: ConfigState | undefined, fileName: string): string {
    if (
      state === undefined ||
      ts.sys.useCaseSensitiveFileNames ||
      state.listed.has(fileName)
    )
      return fileName;
    const folded = fileName.toLowerCase();
    for (const project of this.#withReferences(state))
      for (const name of project.listed)
        if (name.toLowerCase() === folded) return name;
    return fileName;
  }

  /**
   * What answers for a file this project does not list, if it does not list it
   * but a project it references could. TypeScript reads a referenced project's
   * sources through the one referencing it, and asks that one's handle for them,
   * and they expand by the config that lists them. A config that lists it yet,
   * as far as is known, is looked for in the same way as this one's own; one that
   * cannot be used, whose folder holds the file, is what the file should hear of.
   */
  #owningReference(
    state: ConfigState,
    fileName: string,
  ): ConfigState | ConfigProblem | undefined {
    const within = (configFileName: string) => {
      const folder = canonical(dirname(configFileName));
      return fileName.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
    };
    const references = this.#referencesOf(state);
    const lister = () =>
      references
        .map((reference) => this.#configs.get(reference))
        .find((referenced) => referenced?.listed.has(fileName) === true);
    let owner = lister();
    if (owner === undefined) {
      for (const reference of references) {
        const referenced = this.#configs.get(reference);
        if (referenced !== undefined && within(reference))
          this.#lookFor(referenced, fileName);
      }
      owner = lister();
    }
    if (owner !== undefined) return owner;
    const broken = references.find(
      (reference) => this.#unusable.has(reference) && within(reference),
    );
    if (broken !== undefined) return this.#unusable.get(broken);
    this.#lookFor(state, fileName);
    return undefined;
  }

  /**
   * Load the config again for a file it did not list, which may be a file it
   * would list now, a folder renamed into place keeping its files' times. Asked
   * at once about many files outside it, as a project importing them does, it
   * walks `include` for the first; after that for one newly written, or once
   * `include` was last walked a while ago, so typing in one is no more often.
   * The load may find the config can no longer be used, which is then what the
   * file hears.
   */
  #lookFor(state: ConfigState, fileName: string): void {
    const stats = diskFileSystem.stat?.(fileName);
    const onDisk = stats?.isFile() === true;
    const walkedAWhileAgo =
      nowNanoseconds() - state.loadedAt >= lookAgainNanoseconds;
    const unheardOf = state.unlisted.get(fileName) !== onDisk;
    const newlyWritten =
      stats !== undefined && unheardOf && !statIsSettled(stats, state.loadedAt);
    if (
      onDisk &&
      (walkedAWhileAgo ||
        newlyWritten ||
        (unheardOf && state.lookedIn !== this.#round))
    ) {
      this.#round = new InputCheckRound();
      this.#problemsWith(state.configFileName, true);
      const looked = this.#configs.get(state.configFileName);
      if (looked !== undefined) looked.lookedIn = this.#round;
    } else if (onDisk) state.walkAgain = true;
    const loaded = this.#configs.get(state.configFileName);
    if (loaded !== undefined && !loaded.listed.has(fileName))
      loaded.unlisted.set(fileName, onDisk);
  }

  /**
   * Expand again what no longer holds, before anything is said of what the
   * project depends on, and try again what failed if what it read has changed:
   * mended, it says what it read, and TypeScript never asks for a file it does
   * not transform.
   */
  #refresh(state: ConfigState): void {
    const round = this.#round;
    const stale = [...state.expanded]
      .filter(([, file]) => !round.hold(file.consulted))
      .map(([name]) => name);
    if (stale.length > 0) this.#expandOrForget(state, stale);
    this.#expandEachOf(
      state,
      [...state.failed]
        .filter(
          ([name, consulted]) =>
            !stale.includes(name) && !round.hold(consulted),
        )
        .map(([name]) => name),
    );
  }

  /**
   * Bring a kept state up to the project as just loaded. A file made or gone
   * changes what expands only for the files that looked for it, which their
   * inputs say, and those that read binding literals, over a program of the whole
   * file list; so only those and a file newly listed are expanded here.
   */
  #relist(state: ConfigState, project: LoadedSweetProject): void {
    state.project = project;
    const listed = listedFiles(project);
    for (const name of state.unlisted.keys())
      if (listed.has(name)) {
        state.unlisted.delete(name);
        state.nowListed += 1;
      } else state.unlisted.set(name, ts.sys.fileExists(name));
    const changed =
      listed.size !== state.listed.size ||
      [...listed].some((name) => !state.listed.has(name));
    if (!changed) return;
    const added = [...listed].filter(
      (name) => !state.listed.has(name) && expandsExtensionOf(state, name),
    );
    state.listed = listed;
    for (const name of state.expanded.keys())
      if (!listed.has(name)) {
        state.expanded.delete(name);
        state.literalReaders.delete(name);
      }
    // One gone from the project is no longer anything to mend.
    for (const name of state.failed.keys())
      if (!listed.has(name)) state.failed.delete(name);
    if (state.failed.size === 0) state.failureInputs.clear();
    this.#expandOrForget(state, [
      ...new Set([...state.literalReaders, ...added]),
    ]);
  }

  /**
   * Expand these files together, or every one. Where that fails each is tried on
   * its own, so what is wrong with one is not said of all.
   */
  #expandOrForget(
    state: ConfigState,
    fileNames: readonly string[],
    onlyNarrowly = false,
  ): void {
    if (fileNames.length === 0) return;
    try {
      this.#expand(state, fileNames, onlyNarrowly);
    } catch (error) {
      if (fileNames.length > 1) {
        this.#expandEachOf(state, fileNames);
        return;
      }
      process.stderr.write(
        `Sweetener failed to expand ${fileNames[0] ?? state.configFileName}:\n${describeError(error)}\n`,
      );
      this.#recordFailure(state, fileNames, error);
    }
  }

  /**
   * Expand each of these alone. Once one fails reading every source, as any file
   * reaching a binding literal reads them, each that would read them too is not
   * tried, at the cost of the whole project each: those that need only what they
   * lead to still are.
   */
  #expandEachOf(state: ConfigState, fileNames: readonly string[]): void {
    let readingFails = false;
    for (const name of fileNames) {
      this.#expandOrForget(state, [name], readingFails);
      readingFails ||=
        state.failed.has(name) && state.provider.failedReadingEverySource();
    }
  }

  /**
   * What to expand when nothing has been yet: what TypeScript can ask for. A
   * listed plain file is read only to see whether it has a directive, and through
   * a mapper that is nothing to anyone, so a project of them, referenced, costs
   * nothing.
   */
  #expandable(state: ConfigState): string[] {
    return [...state.listed].filter((name) => expandsExtensionOf(state, name));
  }

  /**
   * Leaves these files to be expanded alone when asked for, or when what the
   * expansion that failed read says something different. What that read is added
   * to what counts: a batch that throws may not have reached what another file
   * read.
   */
  #recordFailure(
    state: ConfigState,
    fileNames: Iterable<string>,
    failure: unknown,
  ): void {
    const { inputs, at } =
      failure instanceof FailedExpansion
        ? failure
        : { inputs: [], at: nowNanoseconds() };
    const consulted = checkedInputs(state.provider.fileSystem, at)(inputs);
    for (const input of inputs)
      state.failureInputs.set(`${input.kind}\0${input.path}`, input);
    for (const name of fileNames) {
      state.expanded.delete(name);
      state.literalReaders.delete(name);
      state.failed.set(name, consulted);
    }
  }

  /**
   * Expand these files together, or every one, against the project's text as
   * it stands: TypeScript's for a file it sent, the disk's for any other.
   */
  #expand(
    state: ConfigState,
    fileNames: readonly string[],
    onlyNarrowly = false,
  ): void {
    const expandedAt = nowNanoseconds();
    // What the state keeps is plain by now, and each inspection holds the whole
    // project: kept in the provider, one per config would stay.
    try {
      state.provider.expandProject(state.project, {
        files: new Set(fileNames),
        onlyNarrowly,
      });
      const check = checkedInputs(state.provider.fileSystem, expandedAt);
      for (const fileName of fileNames) {
        state.failed.delete(fileName);
        const inspection = state.provider.inspectSource(fileName);
        if (inspection === undefined) {
          state.expanded.delete(fileName);
          state.literalReaders.delete(fileName);
          continue;
        }
        if (inspection.readsBindingLiterals) state.literalReaders.add(fileName);
        else state.literalReaders.delete(fileName);
        state.expanded.set(
          fileName,
          expandedFile(fileName, inspection, check(inspection.inputs)),
        );
      }
    } catch (error) {
      // What it read is gone once the provider lets go.
      throw new FailedExpansion(error, state.provider.readInputs(), expandedAt);
    } finally {
      state.provider.releaseInspections();
    }
    if (state.failed.size === 0) state.failureInputs.clear();
  }

  /**
   * This file's expansion against the text TypeScript holds, which has joined
   * the overlay. A file the project does not expand has none, and reading
   * every source would only say so again.
   *
   * It is expanded again if what it read no longer says the same. Any other
   * file that read this one is expanded when TypeScript asks for it, or when the
   * project next opens: read narrowly, doing them together saves nothing, and
   * typing in a file any binding literal's program reads would cost them all.
   */
  #expansionFor(
    state: ConfigState,
    fileName: string,
  ): ExpandedFile | undefined {
    if (!state.listed.has(fileName) || !expandsExtensionOf(state, fileName))
      return undefined;
    const cached = state.expanded.get(fileName);
    if (cached !== undefined && this.#round.hold(cached.consulted))
      return cached;
    this.#expand(state, [fileName]);
    return state.expanded.get(fileName);
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
    const askOf = (of: ConfigState): void => {
      for (const input of of.project.configurationInputs) ask(input);
      // Where binding literals are resolved every file shares one list of the
      // whole project's inputs, walked once. Each of those files read the
      // others, so only a file with a list of its own leaves anything out of it.
      const readers = new Map<readonly CheckedInput[], string[]>();
      for (const [fileName, { consulted }] of of.expanded) {
        const listReaders = readers.get(consulted);
        if (listReaders === undefined) readers.set(consulted, [fileName]);
        else listReaders.push(fileName);
      }
      for (const [consulted, fileNames] of readers) {
        const only = fileNames.length === 1 ? fileNames[0] : undefined;
        for (const { input } of consulted)
          if (input.kind !== "file" || nameOf(input.path) !== only) ask(input);
      }
      if (of.failed.size > 0) {
        for (const path of of.listed)
          ask({ kind: "file", path, text: undefined });
        for (const input of of.failureInputs.values()) ask(input);
      }
    };
    askOf(state);
    for (const reference of this.#referencesOf(state)) {
      const referenced = this.#configs.get(reference);
      if (referenced !== undefined) askOf(referenced);
      // One that cannot be used is mended in its config, or in one it extends.
      else
        for (const path of [
          reference,
          ...(this.#unusable.get(reference)?.watchedFiles ?? []),
        ])
          ask({ kind: "file", path, text: undefined });
    }
    const asked = [...questions.keys()].sort();
    // What TypeScript asked for that the config does not list: nothing changes
    // for it otherwise when one is saved, and it keeps the file emptied.
    const readers = this.#withReferences(state);
    const unlisted = readers.flatMap((reader) => [
      String(reader.nowListed),
      ...[...reader.unlisted]
        .map(([name, onDisk]) => `${name} ${String(onDisk)}`)
        .sort(),
    ]);
    const askedKey = fingerprint([...asked, ...unlisted]);
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
      value: fingerprint([
        ...answers.map((answer) => JSON.stringify(answer)),
        ...unlisted,
      ]),
      asked: askedKey,
      watchedFiles: [
        ...new Set([
          canonical(state.configFileName),
          // Not what a directory lists, which is not a file to watch and whose
          // change names only the child: heard when the project next opens.
          ...answers
            .filter(({ kind }) => kind !== "subdirectories")
            .map(({ path }) => canonical(path)),
          ...readers.flatMap((reader) => [...reader.unlisted.keys()]),
        ]),
      ].sort(),
      consulted: checkedInputs(state.provider.fileSystem, answeredAt)(answers),
    };
    state.identity = identity;
    return identity;
  }
}
