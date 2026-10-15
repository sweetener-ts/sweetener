import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
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
  consulted,
  nowNanoseconds,
  stillConsulted,
  type ConsultedFile,
} from "./consulted-files.js";
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
  readonly dependencies: readonly string[];
  readonly missingDependencies: readonly string[];
  readonly trace: unknown;
  readonly cacheKey: string;
  readonly virtualFilename: string;
}

export interface SweetenerSession {
  transform(
    request: SweetenerTransformRequest,
  ): Promise<SweetenerTransformResult>;
  /**
   * The same expansion, without a promise around it.
   *
   * Expanding a file is synchronous work — it reads from disk and runs the
   * compiler — and some hosts can only accept a synchronous answer. Deno's
   * module loader hooks are one: they cannot await.
   */
  transformSync(request: SweetenerTransformRequest): SweetenerTransformResult;
  invalidate(paths: readonly string[]): void;
  close(): Promise<void>;
}

/** Everything about a project that its expansion is given. */
function signatureOf(project: LoadedSweetProject): string {
  return JSON.stringify({
    configPath: project.configPath,
    sweet: project.sweet,
    options: project.typescript.options,
    fileNames: project.typescript.fileNames,
  });
}

/**
 * One expansion of a project, kept so the files after the first are served
 * from it rather than each expanding the whole project again.
 *
 * It is kept while the config says what it said and every file it consulted
 * holds what it held, which is what the expansion is a function of -- short of
 * what TypeScript reads to resolve a binding literal, which
 * `DefaultProjectExpansionOutput.inputs` does not cover. What `transformSync`
 * serves comes from here alone, inspections included, taken as the expansion
 * finished: another expansion on the same provider, or one that throws,
 * cannot change what this one answers.
 */
interface ProjectExpansion {
  readonly signature: string;
  readonly consulted: readonly ConsultedFile[];
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly inspections: ReadonlyMap<string, SourceExpansionInspection>;
  /** Each generated file, by its canonical name without the extension. */
  readonly generated: ReadonlyMap<
    string,
    { readonly file: VirtualTypeScriptFile; readonly fileName: string }
  >;
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

function canonical(fileName: string): string {
  const absolute = resolve(fileName);
  return (existsSync(absolute) ? realpathSync(absolute) : absolute).replaceAll(
    "\\",
    "/",
  );
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
  const expansions = new Map<string, ProjectExpansion>();
  let closed = false;

  const expansionFor = (
    configFile: string,
    project: LoadedSweetProject,
  ): ProjectExpansion => {
    const signature = signatureOf(project);
    const remembered = expansions.get(configFile);
    if (
      remembered !== undefined &&
      remembered.signature === signature &&
      stillConsulted(remembered.consulted)
    )
      return remembered;
    expansions.delete(configFile);
    const expandedAt = nowNanoseconds();
    const expanded = provider.expandProject(project);
    const inspections = new Map<string, SourceExpansionInspection>();
    const sourceNames = new Map<number, { name: string; text: string }>();
    for (const name of project.typescript.fileNames) {
      const inspected = provider.inspectSource(name);
      if (inspected === undefined) continue;
      inspections.set(resolve(name), inspected);
      sourceNames.set(inspected.sourceId as number, {
        name,
        text: inspected.sourceText,
      });
    }
    const read = [...expanded.inputs]
      .filter(([, text]) => text !== undefined)
      .map(([path]) => path);
    const missing = [...expanded.inputs]
      .filter(([, text]) => text === undefined)
      .map(([path]) => path);
    const dependencies = Object.freeze(
      [
        ...new Set(
          [...project.configurationDependencies, ...read].map(canonical),
        ),
      ].sort(),
    );
    const missingDependencies = Object.freeze(missing.map(canonical).sort());
    const expansion: ProjectExpansion = {
      signature,
      consulted: consulted(expanded.inputs, expandedAt),
      diagnostics: Object.freeze([...expanded.diagnostics]),
      inspections,
      generated: new Map(
        expanded.files.map((file) => {
          const fileName = canonical(file.fileName);
          return [fileName.replace(/\.(?:ts|js)x?$/u, ""), { file, fileName }];
        }),
      ),
      sourceNames,
      dependencies,
      missingDependencies,
      watched: new Set([...dependencies, ...missingDependencies]),
      results: new Map(),
    };
    // A failed expansion is not one to keep: partial results must not enter a
    // content-addressed cache, and this is the one this pipeline has.
    // Recomputing a failure is cheap and always correct; serving one from a
    // cache outlives the reason for it.
    if (expanded.diagnostics.length === 0)
      expansions.set(configFile, expansion);
    return expansion;
  };

  const transformSync = (
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
    if (configurationErrors.length > 0)
      throw new Error(
        `Sweetener cannot use ${configFile}: ${configurationErrors.join("; ")}`,
      );
    const expansion = expansionFor(configFile, project);
    const existing = expansion.results.get(cacheKey);
    if (existing !== undefined) return existing;
    const inspected = expansion.inspections.get(filename);
    const generated = expansion.generated.get(
      filename.replace(/\.s(?:ts|js)x?$/u, ""),
    );
    if (
      inspected === undefined ||
      inspected.sourceMap === undefined ||
      generated === undefined
    )
      throw new Error(
        `${filename} is not opted into Sweetener expansion by ${configFile}. List it there, under "files" or "include".`,
      );
    const { sourceNames } = expansion;
    const result: SweetenerTransformResult = Object.freeze({
      code: generated.file.generated.text,
      originMap: generated.file.generated.originMap,
      map: inspected.sourceMap,
      composeMap: (typescriptMap: RawSourceMap) => {
        try {
          return composeSourceMap({
            typescriptMap,
            generatedSource: inspected.generated.text,
            generated: inspected.generated,
            origins: inspected.origins,
            sourceName: (sourceId) =>
              sourceNames.get(sourceId as number)?.name ?? filename,
            sourceText: (sourceId) => sourceNames.get(sourceId as number)?.text,
          });
        } catch {
          return undefined;
        }
      },
      diagnostics: expansion.diagnostics,
      warnings: inspected.warnings ?? Object.freeze([]),
      dependencies: expansion.dependencies,
      missingDependencies: expansion.missingDependencies,
      trace: inspected.trace,
      cacheKey,
      virtualFilename: generated.fileName,
    });
    expansion.results.set(cacheKey, result);
    return result;
  };

  return Object.freeze({
    transformSync,
    // Declared async so a failure is still a rejected promise rather than a
    // synchronous throw, which is what every existing caller expects. There is
    // nothing to await inside it.
    async transform(
      request: SweetenerTransformRequest,
    ): Promise<SweetenerTransformResult> {
      return transformSync(request);
    },
    invalidate(paths: readonly string[]): void {
      const invalidated = paths.map(canonical);
      for (const [configFile, expansion] of expansions)
        if (invalidated.some((path) => expansion.watched.has(path)))
          expansions.delete(configFile);
    },
    async close(): Promise<void> {
      closed = true;
      expansions.clear();
    },
  });
}
