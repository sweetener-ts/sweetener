import { posix } from "node:path";
import type { Diagnostic, SourceId, SourceSpan } from "@sweetener/shared";
import {
  ambiguousMacroAliasCode,
  duplicateMacroImportCode,
  macroModuleCycleCode,
  missingMacroExportCode,
  moduleDiagnosticRegistry,
  unresolvedMacroModuleCode,
  unsupportedMacroVersionCode,
} from "./module-diagnostics.js";
import type {
  DeclarativeMacroManifest,
  MacroModuleDependency,
} from "./module-manifest.js";
import type { MacroModuleExport } from "./module-manifest.js";

export interface MacroModuleSource {
  readonly path: string;
  readonly sourceId: SourceId;
  readonly manifest: DeclarativeMacroManifest;
}

export interface MacroPackageManifest {
  readonly name: string;
  readonly exports: Readonly<Record<string, string>>;
}

export interface PathAlias {
  readonly pattern: string;
  readonly targets: readonly string[];
}

/**
 * Where a host found a specifier leads from a module, by the module's path as
 * the host gave it, or `undefined` where it found nothing.
 *
 * A host that resolved each module's imports against the file system says so
 * here, and resolution takes its answers in place of `aliases` and
 * `packages`: those are the same for every module, so they can only say where
 * a specifier leads from anywhere -- one location for each package name, every
 * alias target some module loaded -- which is not where it led from this one.
 */
export type ResolveSpecifier = (
  from: string,
  specifier: string,
) => string | undefined;

export interface ResolveMacroProjectOptions {
  readonly entry: string;
  readonly languageVersion: string;
  readonly compilerVersion: string;
  readonly modules: readonly MacroModuleSource[];
  readonly packages?: readonly MacroPackageManifest[];
  readonly aliases?: readonly PathAlias[];
  readonly resolve?: ResolveSpecifier | undefined;
}

export interface ModuleDependencyGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly Readonly<{ from: string; to: string }>[];
}

export interface ResolvedMacroProject {
  readonly modules: readonly MacroModuleSource[];
  readonly macroGraph: ModuleDependencyGraph;
  readonly runtimeGraph: ModuleDependencyGraph;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SourceMacroImport {
  readonly specifier: string;
  readonly bindings: readonly {
    readonly imported: string;
    readonly local: string;
    readonly origin: SourceSpan;
  }[];
}

export interface ResolvedSourceMacroBinding {
  readonly specifier: string;
  readonly modulePath: string;
  readonly imported: string;
  readonly local: string;
  readonly export: MacroModuleExport;
  readonly origin: SourceSpan;
}

export interface ResolveSourceMacroImportsOptions {
  readonly entry: string;
  readonly imports: readonly SourceMacroImport[];
  readonly modules: readonly MacroModuleSource[];
  readonly packages?: readonly MacroPackageManifest[];
  readonly aliases?: readonly PathAlias[];
  readonly resolve?: ResolveSpecifier | undefined;
}

export interface ResolvedSourceMacroImports {
  readonly bindings: readonly ResolvedSourceMacroBinding[];
  readonly dependencies: readonly MacroModuleDependency[];
  readonly diagnostics: readonly Diagnostic[];
}

// Every module in a project resolves its imports against the same handful of
// directories, so the same paths are normalized over and over. Normalizing is
// pure, and a project's paths are few, so the answers are kept.
const canonicalPaths = new Map<string, string>();

/**
 * Enough to hold the paths of a large project several times over, so a build
 * keeps every answer it needs, while a process that outlives many projects —
 * a watch server, an editor host — cannot grow without bound. Clearing rather
 * than evicting one entry keeps this off the hot path.
 */
const canonicalPathLimit = 20_000;

function canonical(path: string): string {
  const remembered = canonicalPaths.get(path);
  if (remembered !== undefined) return remembered;
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  const result = normalized.startsWith("/") ? normalized : `/${normalized}`;
  if (canonicalPaths.size >= canonicalPathLimit) canonicalPaths.clear();
  canonicalPaths.set(path, result);
  return result;
}

function packageParts(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  return {
    name: parts.slice(0, count).join("/"),
    subpath: parts.length === count ? "." : `./${parts.slice(count).join("/")}`,
  };
}

function aliasCapture(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : undefined;
}

function compareVersions(left: string, right: string): number {
  const parse = (part: string) =>
    part === "x" ? Number.POSITIVE_INFINITY : Number(part);
  const a = left.split(".").map(parse);
  const b = right.split(".").map(parse);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function graph(
  nodes: Iterable<string>,
  edges: Iterable<Readonly<{ from: string; to: string }>>,
): ModuleDependencyGraph {
  return Object.freeze({
    nodes: Object.freeze([...nodes].sort()),
    edges: Object.freeze(
      [...edges].sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to),
      ),
    ),
  });
}

function moduleCandidates(options: {
  /** The importing module's path as the caller gave it. */
  readonly from: string;
  readonly specifier: string;
  readonly packages: ReadonlyMap<string, MacroPackageManifest>;
  readonly aliases: readonly PathAlias[];
  readonly resolve: ResolveSpecifier | undefined;
}): readonly string[] {
  if (options.resolve !== undefined) {
    const target = options.resolve(options.from, options.specifier);
    return target === undefined ? [] : [canonical(target)];
  }
  if (options.specifier.startsWith("."))
    return [
      canonical(
        posix.join(posix.dirname(canonical(options.from)), options.specifier),
      ),
    ];
  const matchingAliases = options.aliases.flatMap(({ pattern, targets }) => {
    const capture = aliasCapture(pattern, options.specifier);
    return capture === undefined ? [] : [{ pattern, targets, capture }];
  });
  const longest = Math.max(
    0,
    ...matchingAliases.map(({ pattern }) => pattern.replace("*", "").length),
  );
  const aliasMatches = matchingAliases
    .filter(({ pattern }) => pattern.replace("*", "").length === longest)
    .flatMap(({ targets, capture }) =>
      targets.map((target) => canonical(target.replace("*", capture))),
    );
  if (aliasMatches.length > 0) return [...new Set(aliasMatches)].sort();
  const parsed = packageParts(options.specifier);
  const target = options.packages.get(parsed.name)?.exports[parsed.subpath];
  return target === undefined ? [] : [canonical(target)];
}

export function resolveSourceMacroImports(
  options: ResolveSourceMacroImportsOptions,
): ResolvedSourceMacroImports {
  const modules = remembered(
    moduleIndexes,
    options.modules,
    (input) => new Map(input.map((module) => [canonical(module.path), module])),
  );
  const packages = remembered(
    packageIndexes,
    options.packages ?? noPackages,
    (input) => new Map(input.map((manifest) => [manifest.name, manifest])),
  );
  const aliases = remembered(
    sortedAliases,
    options.aliases ?? noAliases,
    (input) =>
      Object.freeze(
        [...input].sort((left, right) =>
          left.pattern.localeCompare(right.pattern),
        ),
      ),
  );
  const bindings: ResolvedSourceMacroBinding[] = [];
  const diagnostics: Diagnostic[] = [];
  const localNames = new Set<string>();
  for (const sourceImport of options.imports) {
    const matches = moduleCandidates({
      from: options.entry,
      specifier: sourceImport.specifier,
      packages,
      aliases,
      resolve: options.resolve,
    }).filter((path) => modules.has(path));
    if (matches.length !== 1) {
      for (const binding of sourceImport.bindings)
        diagnostics.push(
          moduleDiagnosticRegistry.create(
            matches.length === 0
              ? unresolvedMacroModuleCode
              : ambiguousMacroAliasCode,
            {
              primaryOrigin: binding.origin,
              messageArguments:
                matches.length === 0
                  ? [sourceImport.specifier, options.entry]
                  : [sourceImport.specifier, matches.length],
            },
          ),
        );
      continue;
    }
    const modulePath = matches[0]!;
    const module = modules.get(modulePath)!;
    for (const binding of sourceImport.bindings) {
      if (localNames.has(binding.local)) {
        diagnostics.push(
          moduleDiagnosticRegistry.create(duplicateMacroImportCode, {
            primaryOrigin: binding.origin,
            messageArguments: [binding.local],
          }),
        );
        continue;
      }
      localNames.add(binding.local);
      const exported = module.manifest.exports[binding.imported];
      if (exported === undefined) {
        diagnostics.push(
          moduleDiagnosticRegistry.create(missingMacroExportCode, {
            primaryOrigin: binding.origin,
            messageArguments: [sourceImport.specifier, binding.imported],
          }),
        );
        continue;
      }
      bindings.push(
        Object.freeze({
          specifier: sourceImport.specifier,
          modulePath,
          imported: binding.imported,
          local: binding.local,
          export: exported,
          origin: binding.origin,
        }),
      );
    }
  }
  const dependencies = options.imports.map((sourceImport) =>
    Object.freeze({
      specifier: sourceImport.specifier,
      kind: "macro" as const,
      exports: Object.freeze(
        [
          ...new Set(sourceImport.bindings.map(({ imported }) => imported)),
        ].sort(),
      ),
    }),
  );
  return Object.freeze({
    bindings: Object.freeze(bindings),
    dependencies: Object.freeze(dependencies),
    diagnostics: Object.freeze(diagnostics),
  });
}

// Indexing the modules, packages and aliases of a project depends only on the
// project, not on the file being resolved, but a build resolves once per file.
// Rebuilding the indexes each time made resolution cost grow with the square of
// the project. They are derived from frozen inputs, so they are kept per input.
const moduleIndexes = new WeakMap<
  readonly MacroModuleSource[],
  ReadonlyMap<string, MacroModuleSource>
>();
const packageIndexes = new WeakMap<
  readonly MacroPackageManifest[],
  ReadonlyMap<string, MacroPackageManifest>
>();
const sortedAliases = new WeakMap<readonly PathAlias[], readonly PathAlias[]>();

const noPackages: readonly MacroPackageManifest[] = Object.freeze([]);
const noAliases: readonly PathAlias[] = Object.freeze([]);

function remembered<Key extends object, Value>(
  cache: WeakMap<Key, Value>,
  key: Key,
  build: (key: Key) => Value,
): Value {
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const built = build(key);
  cache.set(key, built);
  return built;
}

export function resolveMacroProject(
  options: ResolveMacroProjectOptions,
): ResolvedMacroProject {
  const modules = remembered(
    moduleIndexes,
    options.modules,
    (input) => new Map(input.map((module) => [canonical(module.path), module])),
  );
  const packages = remembered(
    packageIndexes,
    options.packages ?? noPackages,
    (input) => new Map(input.map((manifest) => [manifest.name, manifest])),
  );
  const aliases = remembered(
    sortedAliases,
    options.aliases ?? noAliases,
    (input) =>
      Object.freeze(
        [...input].sort((left, right) =>
          left.pattern.localeCompare(right.pattern),
        ),
      ),
  );
  const diagnostics: Diagnostic[] = [];
  const resolved = new Set<string>();
  const active: string[] = [];
  const macroEdges: { from: string; to: string }[] = [];
  const runtimeEdges: { from: string; to: string }[] = [];

  const report = (
    code: Parameters<typeof moduleDiagnosticRegistry.create>[0],
    sourceId: SourceId,
    args: readonly (string | number)[],
  ) =>
    diagnostics.push(
      moduleDiagnosticRegistry.create(code, {
        primaryOrigin: { sourceId, start: 0, end: 0 },
        messageArguments: args,
      }),
    );

  function resolveDependency(
    from: string,
    module: MacroModuleSource,
    dependency: MacroModuleDependency,
  ): string | undefined {
    const matches = moduleCandidates({
      from: module.path,
      specifier: dependency.specifier,
      packages,
      aliases,
      resolve: options.resolve,
    }).filter((path) => modules.has(path));
    if (matches.length === 0) {
      report(unresolvedMacroModuleCode, module.sourceId, [
        dependency.specifier,
        from,
      ]);
      return undefined;
    }
    if (matches.length > 1) {
      report(ambiguousMacroAliasCode, module.sourceId, [
        dependency.specifier,
        matches.length,
      ]);
      return undefined;
    }
    return matches[0]!;
  }

  function visit(path: string): void {
    if (resolved.has(path)) return;
    const module = modules.get(path);
    if (module === undefined) return;
    const { manifest } = module;
    if (
      manifest.languageVersion !== options.languageVersion ||
      compareVersions(options.compilerVersion, manifest.compiler.minimum) < 0 ||
      compareVersions(options.compilerVersion, manifest.compiler.maximum) > 0
    ) {
      report(unsupportedMacroVersionCode, module.sourceId, [
        manifest.name,
        `language/compiler version (${manifest.languageVersion}; ${manifest.compiler.minimum}-${manifest.compiler.maximum})`,
      ]);
      return;
    }
    active.push(path);
    for (const dependency of manifest.dependencies) {
      const target = resolveDependency(path, module, dependency);
      if (target === undefined) continue;
      (dependency.kind === "macro" ? macroEdges : runtimeEdges).push({
        from: path,
        to: target,
      });
      if (dependency.kind === "runtime") continue;
      const targetModule = modules.get(target)!;
      for (const name of dependency.exports)
        if (targetModule.manifest.exports[name] === undefined)
          report(missingMacroExportCode, module.sourceId, [
            dependency.specifier,
            name,
          ]);
      const cycleStart = active.indexOf(target);
      if (cycleStart >= 0)
        report(macroModuleCycleCode, module.sourceId, [
          [...active.slice(cycleStart), target].join(" -> "),
        ]);
      else visit(target);
    }
    active.pop();
    resolved.add(path);
  }

  const entry = canonical(options.entry);
  const entryModule = modules.get(entry);
  if (entryModule === undefined) {
    const fallbackSource = options.modules[0]?.sourceId ?? (0 as SourceId);
    report(unresolvedMacroModuleCode, fallbackSource, [entry, "<entry>"]);
  } else visit(entry);

  return Object.freeze({
    modules: Object.freeze(
      [...resolved].sort().map((path) => modules.get(path)!),
    ),
    macroGraph: graph(resolved, macroEdges),
    runtimeGraph: graph(resolved, runtimeEdges),
    diagnostics: Object.freeze(diagnostics),
  });
}
