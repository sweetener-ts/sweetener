import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import type { OriginMap } from "@sweetener/printer";
import { composeSourceMap } from "@sweetener/typescript-host";
import type { RawSourceMap } from "@sweetener/typescript-host";
import type * as ts from "typescript";
import {
  createDefaultProjectExpansionProvider,
  type DefaultProjectExpansionProvider,
} from "./default-expansion-provider.js";
import { loadSweetProject } from "./configuration.js";

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

interface CacheEntry {
  readonly result: SweetenerTransformResult;
  readonly dependencies: ReadonlySet<string>;
  readonly dependencyFingerprint: string;
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
      throw new Error(`No tsconfig.json found for ${fileName}`);
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

function fingerprintDependencies(paths: Iterable<string>): string {
  return fingerprint(
    [...paths]
      .sort()
      .flatMap((fileName) => [
        fileName,
        existsSync(fileName) ? readFileSync(fileName, "utf8") : "<missing>",
      ]),
  );
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
  const cache = new Map<string, CacheEntry>();
  let closed = false;

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
    const existing = cache.get(cacheKey);
    if (
      existing !== undefined &&
      existing.dependencyFingerprint ===
        fingerprintDependencies(existing.dependencies)
    )
      return existing.result;
    if (existing !== undefined) cache.delete(cacheKey);

    const project = loadSweetProject(configFile);
    const expanded = provider.expandProject(project);
    const inspected = provider.inspectSource(filename);
    const sourceStem = filename.replace(/\.s(?:ts|js)x?$/u, "");
    const generated = expanded.files.find(
      (file) =>
        canonical(file.fileName).replace(/\.(?:ts|js)x?$/u, "") === sourceStem,
    );
    if (
      inspected === undefined ||
      inspected.sourceMap === undefined ||
      generated === undefined
    )
      throw new Error(`${filename} is not opted into Sweetener expansion`);
    const dependencies = Object.freeze(
      [...new Set([configFile, ...provider.macroDependencies(project)])]
        .map(canonical)
        .sort(),
    );
    // Every source in the project, so a composed map can name a macro module
    // it reaches through as well as the file being transformed.
    const sourceNames = new Map<number, { name: string; text: string }>();
    for (const name of project.typescript.fileNames) {
      const other = provider.inspectSource(name);
      if (other !== undefined)
        sourceNames.set(other.sourceId as number, {
          name,
          text: other.sourceText,
        });
    }
    const result: SweetenerTransformResult = Object.freeze({
      code: generated.generated.text,
      originMap: generated.generated.originMap,
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
      diagnostics: Object.freeze([...expanded.diagnostics]),
      dependencies,
      missingDependencies: Object.freeze([]),
      trace: inspected.trace,
      cacheKey,
      virtualFilename: canonical(generated.fileName),
    });
    // A failed expansion is not a result to remember. The public surface says
    // partial results must not enter a content-addressed cache, and that was
    // stated of a class this pipeline does not use — this is the cache it
    // actually has. Recomputing a failure is cheap and always correct; serving
    // one from a cache outlives the reason for it.
    if (result.diagnostics.length === 0)
      cache.set(cacheKey, {
        result,
        dependencies: new Set(dependencies),
        dependencyFingerprint: fingerprintDependencies(dependencies),
      });
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
      const invalidated = new Set(paths.map(canonical));
      for (const [key, entry] of cache)
        if ([...invalidated].some((path) => entry.dependencies.has(path)))
          cache.delete(key);
    },
    async close(): Promise<void> {
      closed = true;
      cache.clear();
    },
  });
}
