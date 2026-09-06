import { dirname, resolve } from "node:path";
import type { ResourceBudget } from "@sweetener/shared";
import { isJavaScriptFileName } from "@sweetener/typescript-host";
import * as ts from "typescript";
import {
  isSupportedMacroExtension,
  supportedMacroExtensions,
} from "./source-kind.js";

export interface SweetCompilerOptions {
  readonly languageVersion: string;
  readonly typescriptVersionPolicy: "exact" | "compatible-minor";
  readonly macroExtensions: readonly string[];
  readonly allowCoreShadowing: boolean;
  /**
   * Also write a declaration beside each macro source, as `main.d.sts.ts`.
   *
   * TypeScript resolves `import ... from "./main.sts"` through that name when
   * `allowArbitraryExtensions` is on, so an ordinary `.ts` file in the project
   * — or in another project entirely — can import a `.sts` module and get its
   * real types. Without them the only way to consume one from TypeScript was a
   * hand-written `declare module "*.sts"`, restated for every export and kept
   * in step by hand.
   */
  readonly sourceDeclarations: boolean;
  readonly trace: "off" | "errors" | "full";
  readonly limits: Partial<ResourceBudget>;
}

export interface SweetConfigurationProblem {
  readonly code: "SWR6001";
  readonly path: string;
  readonly message: string;
}

export interface LoadedSweetProject {
  readonly configPath: string;
  readonly sweet: SweetCompilerOptions;
  readonly typescript: ts.ParsedCommandLine;
  readonly problems: readonly SweetConfigurationProblem[];
}

const defaults: SweetCompilerOptions = Object.freeze({
  languageVersion: "1",
  typescriptVersionPolicy: "exact",
  macroExtensions: Object.freeze([".sts", ".stsx"]),
  allowCoreShadowing: false,
  sourceDeclarations: false,
  trace: "errors",
  limits: Object.freeze({}),
});

const knownKeys = new Set([
  "languageVersion",
  "typescriptVersionPolicy",
  "macroExtensions",
  "allowCoreShadowing",
  "sourceDeclarations",
  "trace",
  "limits",
]);
const knownLimits = new Set<keyof ResourceBudget>([
  "maxInputTokens",
  "maxOutputTokens",
  "maxExpansionSteps",
  "maxTemplateSteps",
  "maxMatcherSteps",
  "maxNestingDepth",
  "deadlineMs",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function problem(path: string, message: string): SweetConfigurationProblem {
  return Object.freeze({ code: "SWR6001", path, message });
}

export function parseSweetCompilerOptions(value: unknown): {
  options: SweetCompilerOptions;
  problems: readonly SweetConfigurationProblem[];
} {
  const problems: SweetConfigurationProblem[] = [];
  const input = value === undefined ? {} : record(value) ? value : {};
  if (value !== undefined && !record(value))
    problems.push(problem("sweet", "must be an object"));
  for (const key of Object.keys(input).sort())
    if (!knownKeys.has(key))
      problems.push(problem(`sweet.${key}`, "is not a recognized option"));

  const languageVersion =
    typeof input["languageVersion"] === "string" &&
    input["languageVersion"].length > 0
      ? input["languageVersion"]
      : defaults.languageVersion;
  if (
    input["languageVersion"] !== undefined &&
    languageVersion === defaults.languageVersion &&
    input["languageVersion"] !== defaults.languageVersion
  )
    problems.push(
      problem("sweet.languageVersion", "must be a nonempty string"),
    );

  const policy = input["typescriptVersionPolicy"];
  const typescriptVersionPolicy =
    policy === "exact" || policy === "compatible-minor"
      ? policy
      : defaults.typescriptVersionPolicy;
  if (
    policy !== undefined &&
    policy !== "exact" &&
    policy !== "compatible-minor"
  )
    problems.push(
      problem(
        "sweet.typescriptVersionPolicy",
        "must be exact or compatible-minor",
      ),
    );

  const extensions = input["macroExtensions"];
  const macroExtensions =
    Array.isArray(extensions) &&
    extensions.length > 0 &&
    extensions.every(
      (extension) =>
        typeof extension === "string" && /^\.[a-z0-9]+$/u.test(extension),
    )
      ? Object.freeze([...new Set(extensions as string[])].sort())
      : defaults.macroExtensions;
  if (extensions !== undefined && macroExtensions === defaults.macroExtensions)
    problems.push(
      problem(
        "sweet.macroExtensions",
        "must be a nonempty array of dotted lowercase extensions",
      ),
    );
  else
    for (const extension of macroExtensions)
      if (!isSupportedMacroExtension(extension))
        // An unrecognized extension has no virtual-file target, which would
        // otherwise hand the unexpanded macro source to TypeScript.
        problems.push(
          problem(
            "sweet.macroExtensions",
            `${extension} is not a supported macro extension; expected one of ${supportedMacroExtensions.join(", ")}`,
          ),
        );

  const allowCoreShadowing =
    typeof input["allowCoreShadowing"] === "boolean"
      ? input["allowCoreShadowing"]
      : defaults.allowCoreShadowing;
  if (
    input["allowCoreShadowing"] !== undefined &&
    typeof input["allowCoreShadowing"] !== "boolean"
  )
    problems.push(problem("sweet.allowCoreShadowing", "must be boolean"));

  const sourceDeclarations =
    typeof input["sourceDeclarations"] === "boolean"
      ? input["sourceDeclarations"]
      : defaults.sourceDeclarations;
  if (
    input["sourceDeclarations"] !== undefined &&
    typeof input["sourceDeclarations"] !== "boolean"
  )
    problems.push(problem("sweet.sourceDeclarations", "must be boolean"));

  const traceValue = input["trace"];
  const trace =
    traceValue === "off" || traceValue === "errors" || traceValue === "full"
      ? traceValue
      : defaults.trace;
  if (
    traceValue !== undefined &&
    traceValue !== "off" &&
    traceValue !== "errors" &&
    traceValue !== "full"
  )
    problems.push(problem("sweet.trace", "must be off, errors, or full"));

  const limitValue = input["limits"];
  const limits = record(limitValue)
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(limitValue)
            .filter(
              ([key, limit]) =>
                knownLimits.has(key as keyof ResourceBudget) &&
                Number.isSafeInteger(limit) &&
                (limit as number) >= 0,
            )
            .sort(([left], [right]) => left.localeCompare(right)),
        ) as Partial<ResourceBudget>,
      )
    : defaults.limits;
  if (limitValue !== undefined && !record(limitValue))
    problems.push(problem("sweet.limits", "must be an object"));
  if (record(limitValue))
    for (const [key, limit] of Object.entries(limitValue))
      if (!knownLimits.has(key as keyof ResourceBudget))
        problems.push(
          problem(`sweet.limits.${key}`, "is not a recognized limit"),
        );
      else if (!Number.isSafeInteger(limit) || (limit as number) < 0)
        problems.push(
          problem(`sweet.limits.${key}`, "must be a non-negative integer"),
        );

  return Object.freeze({
    options: Object.freeze({
      languageVersion,
      typescriptVersionPolicy,
      macroExtensions,
      allowCoreShadowing,
      sourceDeclarations,
      trace,
      limits,
    }),
    problems: Object.freeze(problems),
  });
}

/**
 * Whether the project can contain JavaScript the expander has to handle.
 *
 * Only explicit `files` entries and JavaScript macro extensions count. Reading
 * this from the resolved file list instead would be circular, and turning
 * `allowJs` on for a project that merely has `.js` files inside its `include`
 * globs would silently widen the program.
 */
function projectNeedsJavaScript(
  raw: Record<string, unknown> | undefined,
  macroExtensions: readonly string[],
): boolean {
  if (macroExtensions.some((extension) => extension.startsWith(".sjs")))
    return true;
  const files = raw?.["files"];
  return (
    Array.isArray(files) &&
    files.some(
      (entry) => typeof entry === "string" && isJavaScriptFileName(entry),
    )
  );
}

/**
 * A project over an explicit file list, with no `tsconfig.json`.
 *
 * This backs the config-free commands, where a JavaScript user wants macros
 * expanded without adopting a TypeScript project first. The compiler options
 * only have to be good enough to read and expand the files; nothing here is
 * emitted by TypeScript.
 */
export function loadStandaloneProject(
  fileNames: readonly string[],
  options: { readonly sweet?: Partial<SweetCompilerOptions> } = {},
): LoadedSweetProject {
  const absolute = fileNames.map((fileName) => resolve(fileName));
  const sweet: SweetCompilerOptions = Object.freeze({
    ...defaults,
    ...options.sweet,
  });
  return Object.freeze({
    configPath: resolve(absolute[0] ?? ".", "..", "tsconfig.json"),
    sweet,
    typescript: Object.freeze({
      options: Object.freeze({
        allowJs: true,
        allowNonTsExtensions: true,
        checkJs: false,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        target: ts.ScriptTarget.ESNext,
      }),
      fileNames: [...absolute],
      errors: [],
    }) satisfies ts.ParsedCommandLine,
    problems: Object.freeze([]),
  });
}

export function loadSweetProject(configPath: string): LoadedSweetProject {
  const absolute = resolve(configPath);
  const read = ts.readConfigFile(absolute, ts.sys.readFile);
  const raw = read.config as Record<string, unknown> | undefined;
  const parsedSweet = parseSweetCompilerOptions(raw?.["sweet"]);
  // Deferred, which is what makes a wildcard pick these up at all: TypeScript
  // only admits an extra extension into `include` resolution when its kind
  // says the host owns the file. Declared as TS, every .sts under an `include`
  // glob was quietly left out of the program and the build still succeeded.
  // How the file is then parsed comes from scriptKindForFileName, not here.
  const extraFileExtensions = parsedSweet.options.macroExtensions.map(
    (extension) => ({
      extension,
      isMixedContent: false,
      scriptKind: ts.ScriptKind.Deferred,
    }),
  );
  // `allowJs` has to be settled before the file list is resolved: without it
  // TypeScript rejects the JavaScript entries the expander is meant to own.
  const javascript = projectNeedsJavaScript(
    raw,
    parsedSweet.options.macroExtensions,
  );
  const rawWithJavaScript =
    javascript && raw !== undefined
      ? {
          ...raw,
          compilerOptions: {
            ...((raw["compilerOptions"] as Record<string, unknown>) ?? {}),
            allowJs: true,
          },
        }
      : raw;
  const parsedTypeScript = ts.parseJsonConfigFileContent(
    rawWithJavaScript ?? {},
    ts.sys,
    dirname(absolute),
    undefined,
    absolute,
    undefined,
    extraFileExtensions,
  );
  const typescript: ts.ParsedCommandLine = Object.freeze({
    ...parsedTypeScript,
    options: Object.freeze({
      ...parsedTypeScript.options,
      allowNonTsExtensions: true,
      ...(javascript ? { allowJs: true } : {}),
    }),
    errors: [
      ...(read.error === undefined ? [] : [read.error]),
      ...parsedTypeScript.errors,
    ],
  });
  return Object.freeze({
    configPath: absolute,
    sweet: parsedSweet.options,
    typescript,
    problems: parsedSweet.problems,
  });
}
