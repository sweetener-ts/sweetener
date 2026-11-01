import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  checkedInputs,
  createDefaultProjectExpansionProvider,
  diskFileSystem,
  InputCheckRound,
  loadStandaloneProject,
  loadSweetProject,
  nowNanoseconds,
  type CheckedInput,
  type DefaultProjectExpansionProvider,
  type DefaultSourceExpansionInspection,
  type ExpansionInput,
  type ExpansionSystem,
  type LoadedSweetProject,
} from "@sweetener/compiler";
import * as ts from "typescript";
import { createBindingAgreement } from "./binding-agreement.js";
import { ErrorCode, ResponseError, type RequestHandler } from "./json-rpc.js";
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
} from "./span-mappings.js";

export const diagnosticSource = "sweetener";

/** The name a tsconfig's `contentMappers` entry gives this package by. */
const mapperPackage = "@sweetener/content-mapper";

const virtualExtensions: ReadonlyMap<string, VirtualExtension> = new Map([
  [".ts", ".ts"],
  [".tsx", ".tsx"],
  [".js", ".js"],
  [".jsx", ".jsx"],
]);

function canonical(fileName: string): string {
  return resolve(fileName).replaceAll("\\", "/");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** One file's expansion, and what it asked of the files to make it. */
interface ExpandedFile {
  readonly inspection: DefaultSourceExpansionInspection;
  /** Checked against the overlay's file system, whose answers made it. */
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
 * says something different.
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
  readonly project: LoadedSweetProject;
  /** Expands through `overlay`, in front of the disk. */
  readonly provider: DefaultProjectExpansionProvider;
  /**
   * TypeScript's unsaved text. It stands in for the file until the file
   * changes: TypeScript re-sends a buffer it holds, but once a file is saved
   * or rewritten, the text it last sent for it may be older than the disk --
   * and the file that imports it may well be asked for first.
   */
  readonly overlay: Overlay;
  readonly expanded: Map<string, ExpandedFile>;
  /**
   * The extensions the tsconfig's entry for this package claims, so files
   * TypeScript transforms through it; `undefined` where that could not be
   * read.
   */
  claimed: ReadonlySet<string> | undefined;
  /** The identity last given, kept while what it was made from holds. */
  identity: Identity | undefined;
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

function signatureOf(project: LoadedSweetProject): string {
  return JSON.stringify({
    options: project.typescript.options,
    fileNames: [...project.typescript.fileNames].map(canonical).sort(),
    sweet: project.sweet,
  });
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

/** The question an input asked, without its answer. */
function questionOf(input: ExpansionInput): string {
  return `${input.kind}\0${canonical(input.path)}`;
}

/** The answer `system` gives now to the question `input` asked. */
function answerNow(
  system: ExpansionSystem,
  input: ExpansionInput,
): ExpansionInput {
  switch (input.kind) {
    case "file":
      return {
        kind: "file",
        path: input.path,
        text: system.readFile(input.path),
      };
    case "directory":
      return {
        kind: "directory",
        path: input.path,
        exists: system.directoryExists(input.path),
      };
    case "subdirectories":
      return {
        kind: "subdirectories",
        path: input.path,
        names: system.getDirectories(input.path),
      };
    case "realpath": {
      if (system.realpath === undefined)
        throw new Error(
          `Cannot ask where ${input.path} leads: the system does not resolve links`,
        );
      return {
        kind: "realpath",
        path: input.path,
        target: system.realpath(input.path),
      };
    }
  }
}

/** A digest of these parts, each kept apart from the next by its length. */
function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:${part}`);
  return hash.digest("hex");
}

/**
 * Where an `extends` names its config, as TypeScript finds it: a path, with
 * `.json` added where the file is not there without it, or a package's file
 * found as a JSON module from `base`. `undefined` where it cannot be found.
 */
function extendedConfigPath(spec: string, base: string): string | undefined {
  const normalized = spec.replaceAll("\\", "/");
  if (
    isAbsolute(spec) ||
    normalized.startsWith("./") ||
    normalized.startsWith("../")
  ) {
    const path = resolve(base, spec);
    if (ts.sys.fileExists(path)) return path;
    return !path.endsWith(".json") && ts.sys.fileExists(`${path}.json`)
      ? `${path}.json`
      : undefined;
  }
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    resolveJsonModule: true,
  };
  for (const candidate of spec.endsWith(".json")
    ? [spec]
    : [spec, `${spec}/tsconfig.json`]) {
    const found = ts.resolveModuleName(
      candidate,
      join(base, "tsconfig.json"),
      options,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (found?.endsWith(".json") === true) return found;
  }
  return undefined;
}

/**
 * The `contentMappers` a config has, its own or else the last its `extends`
 * give it, as TypeScript reads them; `null` where a config in the chain
 * could not be found or read, so what it says is not known.
 */
function contentMappersOf(
  configPath: string,
  seen: ReadonlySet<string> = new Set(),
): readonly unknown[] | undefined | null {
  if (seen.has(configPath)) return null;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const raw: unknown = read.config;
  if (read.error !== undefined || !isObject(raw)) return null;
  if (Array.isArray(raw["contentMappers"])) return raw["contentMappers"];
  const extended = raw["extends"];
  const specs =
    typeof extended === "string"
      ? [extended]
      : Array.isArray(extended)
        ? extended
        : [];
  let inherited: readonly unknown[] | undefined;
  for (const spec of specs) {
    if (typeof spec !== "string") return null;
    const path = extendedConfigPath(spec, dirname(configPath));
    if (path === undefined) return null;
    const found = contentMappersOf(path, new Set([...seen, configPath]));
    if (found === null) return null;
    if (found !== undefined) inherited = found;
  }
  return inherited;
}

/**
 * The extensions a config's entries for this package claim, which are the
 * files TypeScript transforms through it; `undefined` where that cannot be
 * read from the config.
 */
function claimedExtensions(
  configFileName: string,
): ReadonlySet<string> | undefined {
  const mappers = contentMappersOf(configFileName);
  if (mappers === null || mappers === undefined) return undefined;
  const claimed = new Set<string>();
  for (const mapper of mappers) {
    if (!isObject(mapper) || mapper["package"] !== mapperPackage) continue;
    const extensions = mapper["extensions"];
    if (!Array.isArray(extensions)) return undefined;
    for (const extension of extensions)
      if (typeof extension === "string") claimed.add(extension);
  }
  return claimed.size === 0 ? undefined : claimed;
}

function configurationProblems(project: LoadedSweetProject): string[] {
  return [
    ...project.typescript.errors.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
    ),
    ...project.problems.map(
      ({ code, path, message }) => `${code} ${path} ${message}`,
    ),
  ];
}

/** A file's expansion, if it has one, and the project it belongs to. */
interface Expanded {
  readonly file: ExpandedFile | undefined;
  readonly project: LoadedSweetProject;
  /** See `ConfigState.claimed`. */
  readonly claimed: ReadonlySet<string> | undefined;
}

/** What each source extension expands to, for a file that could not be. */
const failedExtensions: ReadonlyMap<string, VirtualExtension> = new Map([
  [".sts", ".ts"],
  [".stsx", ".tsx"],
  [".sjs", ".js"],
  [".sjsx", ".jsx"],
]);

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
    extension: failedExtensions.get(extname(request.fileName)) ?? ".ts",
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
  /** Each open project handle, and the config it names ("" for none). */
  readonly #handles = new Map<string, string>();
  /** Configs Sweetener cannot use, and what is wrong with each. */
  readonly #unusable = new Map<
    string,
    { readonly code: number; readonly messageText: string }
  >();
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
    if (problems !== undefined)
      // TypeScript shows a failed request only as a failure, never why, so
      // what is wrong with the config is said where TypeScript shows the
      // mapper's own configuration problems -- at its `contentMappers` entry --
      // and each file it would have expanded says the same.
      return {
        configIdentity: digest([
          canonical(configFileName),
          ts.sys.readFile(configFileName) ?? "<missing>",
        ]),
        watchedFiles: [canonical(configFileName)],
        optionDiagnostics: [...optionDiagnostics, { path: [], ...problems }],
      };
    const state = this.#configs.get(configFileName)!;
    state.claimed = claimedExtensions(configFileName);
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
    const unusable = this.#unusable.get(configFileName);
    if (unusable !== undefined)
      return failedTransform(request, unusable.code, unusable.messageText);
    let expanded: Expanded;
    try {
      expanded =
        configFileName === ""
          ? this.#standalone(fileName, request.content)
          : this.#expansionFor(
              this.#configs.get(configFileName)!,
              fileName,
              request.content,
            );
    } catch (error) {
      // A failure inside the compiler is still an answer about this file.
      // Thrown back as a failed request, TypeScript would report that the
      // mapper failed and drop what failed; returned as a diagnostic, the
      // author reads why, where the file is.
      process.stderr.write(
        `Sweetener failed to expand ${fileName}:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      return failedTransform(
        request,
        6201,
        `Project expansion failed: ${error instanceof Error ? error.message : String(error)}`,
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
    const inspected = file.inspection;
    const extension = virtualExtensions.get(extname(inspected.virtualFileName));
    if (extension === undefined)
      throw new Error(
        `Sweetener expanded ${fileName} to ${inspected.virtualFileName}, which TypeScript cannot take as a content-mapper output`,
      );
    const text = inspected.generated.text;
    const segments = segmentsForExpansion({
      index: inspected.index,
      generatedText: text,
      sourceText: request.content,
      sourceId: inspected.sourceId as number,
      agree: createBindingAgreement(text, extension),
    });
    return {
      text,
      extension,
      mappings: encodeSegments(segments, text, request.content, encoding),
      diagnostics: this.#diagnostics(
        inspected.diagnostics,
        fileName,
        request.content,
        encoding,
        project,
        expanded.claimed,
      ),
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
   */
  #problemsWith(
    configFileName: string,
  ): { readonly code: number; readonly messageText: string } | undefined {
    let loaded:
      { readonly project: LoadedSweetProject } | { readonly failure: string };
    try {
      loaded = { project: loadSweetProject(configFileName) };
    } catch (error) {
      loaded = {
        failure: error instanceof Error ? error.message : String(error),
      };
    }
    const problems =
      "failure" in loaded
        ? [loaded.failure]
        : configurationProblems(loaded.project);
    if (problems.length > 0 || !("project" in loaded))
      return this.#markUnusable(
        configFileName,
        6001,
        `Sweetener cannot use ${configFileName}: ${problems.join("; ")}`,
      );
    this.#unusable.delete(configFileName);
    try {
      this.#stateFor(configFileName, loaded.project);
    } catch (error) {
      process.stderr.write(
        `Sweetener failed to expand ${configFileName}:\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      return this.#markUnusable(
        configFileName,
        6201,
        `Project expansion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  #markUnusable(
    configFileName: string,
    code: number,
    messageText: string,
  ): { readonly code: number; readonly messageText: string } {
    const problem = { code, messageText };
    this.#unusable.set(configFileName, problem);
    this.#configs.delete(configFileName);
    return problem;
  }

  /**
   * The state for a config, kept from before if the config still says the
   * same thing, and otherwise made fresh by expanding the whole project --
   * which is what a `tsc` run is about to ask for, one file at a time.
   */
  #stateFor(configFileName: string, project: LoadedSweetProject): ConfigState {
    const signature = signatureOf(project);
    const existing = this.#configs.get(configFileName);
    if (existing !== undefined && existing.signature === signature)
      return existing;
    // TypeScript's unsaved text outlives a change to the config: it re-sends
    // a buffer only when that buffer changes, and a file expanded meanwhile
    // reads the macros it holds.
    const overlay: Overlay = new Map(existing?.overlay);
    const state: ConfigState = {
      configFileName,
      signature,
      project,
      provider: overlayProvider(overlay),
      overlay,
      expanded: new Map(),
      claimed: existing?.claimed,
      identity: undefined,
    };
    this.#expand(state, undefined);
    this.#configs.set(configFileName, state);
    return state;
  }

  /**
   * Expand these files together, or every one, against the project's text as
   * it stands: TypeScript's for a file it sent, the disk's for any other.
   */
  #expand(state: ConfigState, fileNames: readonly string[] | undefined): void {
    const expandedAt = nowNanoseconds();
    // Named as the provider names them, which on Windows is not how this
    // mapper writes them.
    state.provider.expandProject(state.project, {
      files:
        fileNames === undefined
          ? undefined
          : new Set(fileNames.map((name) => resolve(name))),
    });
    const check = checkedInputs(state.provider.fileSystem, expandedAt);
    for (const fileName of fileNames ??
      state.project.typescript.fileNames.map(canonical)) {
      const inspection = state.provider.inspectSource(fileName);
      if (inspection === undefined) {
        state.expanded.delete(fileName);
        continue;
      }
      state.expanded.set(fileName, {
        inspection,
        consulted: check(inspection.inputs),
      });
    }
  }

  /**
   * This file's expansion against exactly the text TypeScript holds.
   *
   * The text joins the overlay, then every expansion whose inputs no longer
   * hold is stale. When this file's is, it is expanded again together with
   * every other stale file: after an edit that is the one file, and after a
   * saved change to a macro module it is every file that module reaches,
   * which is cheaper expanded at once than one at a time as TypeScript asks.
   */
  #expansionFor(
    state: ConfigState,
    fileName: string,
    content: string,
  ): Expanded {
    const disk = ts.sys.readFile(fileName);
    if (content === disk) state.overlay.delete(fileName);
    else state.overlay.set(fileName, { text: content, disk });
    // One round for the request: each file is read once, however many
    // expansions asked of it.
    const round = new InputCheckRound();
    const fresh = (file: ExpandedFile) => round.hold(file.consulted);
    const cached = state.expanded.get(fileName);
    if (cached !== undefined && fresh(cached))
      return { file: cached, project: state.project, claimed: state.claimed };
    const stale = [
      fileName,
      ...[...state.expanded]
        .filter(([name, file]) => name !== fileName && !fresh(file))
        .map(([name]) => name),
    ];
    this.#expand(state, stale);
    return {
      file: state.expanded.get(fileName),
      project: state.project,
      claimed: state.claimed,
    };
  }

  /**
   * The project's identity: what the config read, and what each file's
   * expansion asked of any file but itself, answered as things stand -- the
   * disk, with TypeScript's unsaved text in front of it. A file's own text is
   * left out, since TypeScript transforms a file again when that changes;
   * folded in, every keystroke would make TypeScript transform every file.
   *
   * It is kept while those questions are the same and each gets the same
   * answer, which a stat says for a file on disk, so an unchanged project
   * reads none of them again.
   */
  #identityOf(state: ConfigState): Identity {
    const questions = new Map<string, ExpansionInput>();
    for (const input of state.project.configurationInputs)
      questions.set(questionOf(input), input);
    for (const [fileName, file] of state.expanded)
      for (const input of file.inspection.inputs)
        if (input.kind !== "file" || canonical(input.path) !== fileName)
          questions.set(questionOf(input), input);
    const asked = [...questions.keys()].sort();
    const askedKey = digest(asked);
    const kept = state.identity;
    if (
      kept !== undefined &&
      kept.asked === askedKey &&
      new InputCheckRound().hold(kept.consulted)
    )
      return kept;
    const answeredAt = nowNanoseconds();
    const answers = asked.map((question) =>
      answerNow(state.provider.fileSystem.system, questions.get(question)!),
    );
    const identity: Identity = {
      value: digest(answers.map((answer) => JSON.stringify(answer))),
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
        inspection === undefined ? undefined : { inspection, consulted: [] },
      project,
      claimed: undefined,
    };
  }

  /**
   * What went wrong expanding this file, where TypeScript can show it.
   *
   * The protocol carries errors only, with no severity, so a warning would
   * arrive as an error and fail a build that should pass; warnings stay out.
   * An error expansion places in another file of this project that
   * TypeScript transforms through this mapper -- one whose extension the
   * config's entry claims -- is that file's to report. One placed in a file
   * TypeScript never transforms here -- a macro module inside a package, or a
   * source whose extension the entry leaves out -- is reported here at the
   * top of the file, naming where it happened, since no one else can.
   */
  #diagnostics(
    diagnostics: readonly ts.Diagnostic[],
    fileName: string,
    content: string,
    encoding: PositionEncoding,
    project: LoadedSweetProject,
    claimed: ReadonlySet<string> | undefined,
  ): ContentMapperDiagnostic[] {
    const encode = offsetEncoder(content, encoding);
    const projectFiles = new Set(project.typescript.fileNames.map(canonical));
    const reported: ContentMapperDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const messageText = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      );
      const location =
        diagnostic.file === undefined
          ? undefined
          : canonical(diagnostic.file.fileName);
      if (location === fileName && diagnostic.start !== undefined) {
        const start = Math.min(diagnostic.start, content.length);
        const end = Math.min(start + (diagnostic.length ?? 0), content.length);
        reported.push({
          messageText,
          start: encode(start),
          length: encode(end) - encode(start),
          code: diagnostic.code,
        });
        continue;
      }
      if (
        location !== undefined &&
        projectFiles.has(location) &&
        claimed?.has(extname(location)) === true
      )
        continue;
      const where = describeLocation(diagnostic);
      reported.push({
        messageText: where === "" ? messageText : `${where}: ${messageText}`,
        start: 0,
        length: 0,
        code: diagnostic.code,
      });
    }
    return reported;
  }
}
