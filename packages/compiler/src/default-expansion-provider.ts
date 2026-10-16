import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  compileParsedMacros,
  coreFormKind,
  createExpansionFrontendSession,
  ExpansionGuard,
  ambiguousSlashCode,
  expansionDiagnosticRegistry,
  isCoreForm,
  unauthorizedCoreShadowImportCode,
  unreadableTemplateSlashCode,
  unsettledSlashCode,
  unresolvedBindingLiteralCode,
  type CompileParsedMacrosResult,
} from "@sweetener/expansion";
import {
  createPhase,
  EnvironmentStore,
  hygieneDiagnosticRegistry,
  ScopeStore,
} from "@sweetener/hygiene";
import { patternDiagnosticRegistry } from "@sweetener/pattern";
import { templateDiagnosticRegistry } from "@sweetener/template";
import {
  macroLanguageDiagnosticRegistry,
  parseCompileTimeSyntaxImports,
  parseMacroDefinitions,
  type ParseMacroDefinitionsResult,
} from "@sweetener/macro-language";
import {
  createLazyOriginQueryIndex,
  printExpandedFile,
  type NameRewrite,
  type PrintedExpandedFile,
} from "@sweetener/printer";
import {
  findSweetenerDirective,
  readerDiagnosticRegistry,
  readSyntax,
  type SourceDirective,
} from "@sweetener/reader";
import {
  createIdAllocator,
  createResourceBudget,
  ResourceTracker,
  type BindingId,
  type Diagnostic,
  type InvocationId,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
  createSyntaxSequence,
  createToken,
  OriginStore,
  type SlashReading,
  type SlashReadings,
  type Syntax,
  type SyntaxSequence,
  type TokenSyntax,
  type RootSyntax,
  type Trivia,
} from "@sweetener/syntax";
import {
  askedReadings,
  nextSlashReadings,
  settleSlashReadings,
  writtenSource,
  type SlashAttempt,
} from "./slash-settling.js";
import {
  resolveSourceMacroImports,
  resolveMacroProject,
  createExpansionSourceMap,
  type RawSourceMap,
  parseMacroModuleManifest,
  type DeclarativeMacroManifest,
  type ResolveSpecifier,
  invalidMacroManifestCode,
  moduleDiagnosticRegistry,
  scriptKindForFileName,
  type MacroModuleSource,
  type VirtualTypeScriptFile,
} from "@sweetener/typescript-host";
import { planHygienicRenames } from "./hygienic-renaming.js";
import {
  diskFileSystem,
  InputRecorder,
  suppliedFileSystem,
  type ExpansionFileSystem,
  type ExpansionInput,
} from "./expansion-inputs.js";
import * as ts from "typescript";
import {
  loadStandaloneProject,
  loadSweetProject,
  type LoadedSweetProject,
} from "./configuration.js";
import {
  importedMacroModuleKind,
  selectSweetSources,
  type SourceKind,
} from "./source-kind.js";
import type {
  ExpansionInspectionProvider,
  SourceExpansionInspection,
} from "./expansion-tools.js";
import type {
  ProjectExpansionOutput,
  ProjectExpansionProvider,
} from "./project-command.js";
import { warnAboutHeldNames } from "./unresolved-names.js";

interface ParsedFile {
  readonly fileName: string;
  readonly kind: SourceKind;
  /** Span of the `"use sweetener"` directive, when the file opted in that way. */
  readonly directive: SourceDirective | undefined;
  readonly sourceId: SourceId;
  readonly sourceText: string;
  readonly root: RootSyntax;
  /** How the read that `root` is read the slashes it was told how to. */
  readonly slashReadings: SlashReadings;
  readonly parsed: ParseMacroDefinitionsResult;
  readonly imports: ReturnType<typeof parseCompileTimeSyntaxImports>;
  readonly compiled: CompileParsedMacrosResult;
  readonly diagnostics: readonly Diagnostic[];
}

function packageParts(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const count = specifier.startsWith("@") ? 2 : 1;
  return {
    name: parts.slice(0, count).join("/"),
    subpath: parts.length === count ? "." : `./${parts.slice(count).join("/")}`,
  };
}

/**
 * The nearest `node_modules/<packageName>/package.json` above `from`, read
 * through `consult` so every place it looked is one the caller knows about.
 */
function findPackageManifest(
  from: string,
  packageName: string,
  consult: (fileName: string) => string | undefined,
): { readonly path: string; readonly text: string } | undefined {
  let directory = dirname(from);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(
      directory,
      "node_modules",
      packageName,
      "package.json",
    );
    const text = consult(candidate);
    if (text !== undefined) return { path: candidate, text };
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  return (
    normalized === normalizedRoot ||
    normalized.startsWith(
      `${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`,
    )
  );
}

/**
 * Every diagnostic carries a code and its arguments; the sentence a reader sees
 * lives on the registry that owns the code, so the registries are gathered here
 * to turn one into the other.
 */
const diagnosticDefinitions = new Map(
  [
    readerDiagnosticRegistry,
    patternDiagnosticRegistry,
    templateDiagnosticRegistry,
    hygieneDiagnosticRegistry,
    expansionDiagnosticRegistry,
    macroLanguageDiagnosticRegistry,
    moduleDiagnosticRegistry,
  ].flatMap((registry) =>
    registry.list().map((definition) => [definition.code, definition] as const),
  ),
);

export function formatDiagnosticMessage(
  code: Diagnostic["code"],
  messageArguments: Diagnostic["messageArguments"],
): string {
  const definition = diagnosticDefinitions.get(code);
  return definition === undefined
    ? `${code}: ${messageArguments.join(" ")}`
    : definition.format(messageArguments);
}

export function describeDiagnostic(diagnostic: Diagnostic): string {
  return formatDiagnosticMessage(diagnostic.code, diagnostic.messageArguments);
}

function asTypeScriptDiagnostic(
  diagnostic: Diagnostic,
  files: ReadonlyMap<SourceId, ParsedFile>,
): ts.Diagnostic {
  const sourceFiles = new Map<SourceId, ts.SourceFile | undefined>();
  const sourceFile = (sourceId: SourceId): ts.SourceFile | undefined => {
    if (sourceFiles.has(sourceId)) return sourceFiles.get(sourceId);
    const parsed = files.get(sourceId);
    const created =
      parsed === undefined
        ? undefined
        : ts.createSourceFile(
            parsed.fileName,
            parsed.sourceText,
            ts.ScriptTarget.Latest,
            true,
            scriptKindForFileName(parsed.kind.virtualFileName),
          );
    sourceFiles.set(sourceId, created);
    return created;
  };
  const file = sourceFile(diagnostic.primaryOrigin.sourceId);
  // A diagnostic that names other places — the rule that expected something
  // else, the binding already holding a name — carried them this far and then
  // lost them here, so nothing could show the author where to look.
  const relatedInformation: ts.DiagnosticRelatedInformation[] =
    diagnostic.relatedOrigins.map((related) => ({
      category: ts.DiagnosticCategory.Message,
      code: Number(diagnostic.code.slice(3)),
      file: sourceFile(related.origin.sourceId),
      start: related.origin.start,
      length: Math.max(0, related.origin.end - related.origin.start),
      messageText: related.message,
    }));
  return Object.freeze({
    category:
      diagnostic.severity === "error"
        ? ts.DiagnosticCategory.Error
        : diagnostic.severity === "warning"
          ? ts.DiagnosticCategory.Warning
          : ts.DiagnosticCategory.Message,
    code: Number(diagnostic.code.slice(3)),
    file,
    start: diagnostic.primaryOrigin.start,
    length: Math.max(
      0,
      diagnostic.primaryOrigin.end - diagnostic.primaryOrigin.start,
    ),
    messageText: describeDiagnostic(diagnostic),
    ...(relatedInformation.length === 0 ? {} : { relatedInformation }),
  });
}

function definitionRanges(
  root: RootSyntax,
  parsed: ParseMacroDefinitionsResult,
  origins: OriginStore,
) {
  const ranges: { start: number; end: number }[] = [];
  if (parsed.definitions.length === 0) return ranges;
  // Where each top-level node stands, and the first node beginning at each
  // offset, found once for the module rather than searched for each of its
  // definitions: a module of many definitions searched its whole length for
  // every one of them.
  const indexOf = new Map<Syntax, number>();
  const firstAt = new Map<number, number>();
  root.children.forEach((child, index) => {
    indexOf.set(child, index);
    if (!firstAt.has(child.span.start)) firstAt.set(child.span.start, index);
  });
  for (const definition of parsed.definitions) {
    const end = definition.kind === "syntax" ? definition.end : definition.body;
    const bodyIndex = indexOf.get(end);
    if (bodyIndex === undefined) continue;
    const definitionStart = origins.selectPrimarySource(definition.origin)?.span
      .start;
    let startIndex =
      definitionStart === undefined ? undefined : firstAt.get(definitionStart);
    if (startIndex === undefined || startIndex > bodyIndex)
      startIndex = bodyIndex;
    while (startIndex > 0) {
      const previous = root.children[startIndex - 1];
      if (
        previous?.tag !== "token" ||
        !["export", "rec"].includes(previous.raw)
      )
        break;
      startIndex -= 1;
    }
    ranges.push({
      start: root.children[startIndex]!.span.start,
      end: end.span.end,
    });
  }
  return ranges;
}

/** The leading trivia of a node, or of the token a group opens with. */
function leadingTriviaOf(syntax: Syntax): readonly Trivia[] {
  if (syntax.tag === "token") return syntax.leadingTrivia;
  if (syntax.tag === "group") return syntax.open.leadingTrivia;
  return [];
}

/** The node with more layout in front of it than it came with. */
function withLeadingTrivia(
  syntax: Syntax,
  leadingTrivia: readonly Trivia[],
): Syntax {
  if (leadingTrivia.length === 0) return syntax;
  if (syntax.tag === "token")
    return createToken({
      ...syntax,
      leadingTrivia: [...leadingTrivia, ...syntax.leadingTrivia],
    });
  if (syntax.tag === "group")
    return createGroup({
      ...syntax,
      open: withLeadingTrivia(syntax.open, leadingTrivia) as TokenSyntax,
    });
  return syntax;
}

function runtimeSyntax(file: ParsedFile, origins: OriginStore) {
  // By where each begins, so one pass over the file's nodes, which stand in
  // the order they were written, reads them alongside: asking every range of
  // every node cost a module of many definitions the square of its length.
  const ranges = [...compileTimeRanges(file, origins)].sort(
    (left, right) => left.start - right.start,
  );
  const kept: Syntax[] = [];
  // Comments written above a compile-time import describe the module, not the
  // import, and a licence header at the top of a file must not be deleted from
  // the output along with the import it happens to sit on. They move to
  // whatever survives instead. Comments inside the removed construct go with it.
  let carried: Trivia[] = [];
  // The ranges beginning at or before the node being read, and how far the
  // furthest of them reaches. A node lies inside one of them exactly when it
  // ends within that reach.
  let begun = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const syntax of file.root.children) {
    if (syntax.tag === "token" && syntax.kind === "end-of-file") continue;
    while (begun < ranges.length && ranges[begun]!.start <= syntax.span.start) {
      reach = Math.max(reach, ranges[begun]!.end);
      begun += 1;
    }
    if (syntax.span.end <= reach) {
      const leading = leadingTriviaOf(syntax);
      // From the first comment to the end, so the line breaks between comments
      // come too. Keeping only the comments themselves ran two line comments
      // together, which puts the second inside the first.
      const first = leading.findIndex(
        ({ kind }) => kind === "line-comment" || kind === "block-comment",
      );
      if (first >= 0) carried.push(...leading.slice(first));
      continue;
    }
    kept.push(withLeadingTrivia(syntax, carried));
    carried = [];
  }
  return createSyntaxSequence(kept);
}

function runtimeImportDeclarations(
  file: ParsedFile,
  origins: OriginStore,
): readonly SyntaxSequence[] {
  const runtime = runtimeSyntax(file, origins);
  const declarations: SyntaxSequence[] = [];
  for (let index = 0; index < runtime.length; index += 1) {
    const head = runtime[index];
    if (head?.tag !== "token" || head.raw !== "import") continue;
    const declaration: Syntax[] = [];
    while (index < runtime.length) {
      const node = runtime[index]!;
      declaration.push(node);
      if (node.tag === "token" && node.raw === ";") break;
      index += 1;
    }
    declarations.push(createSyntaxSequence(declaration));
  }
  return Object.freeze(declarations);
}

function tokensIn(syntax: readonly Syntax[]): TokenSyntax[] {
  const tokens: TokenSyntax[] = [];
  const pending = [...syntax].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.tag === "token") tokens.push(node);
    else
      for (let index = node.children.length - 1; index >= 0; index -= 1)
        pending.push(node.children[index]!);
  }
  return tokens;
}

function definitionRuntimeImports(options: {
  readonly owner: ParsedFile;
  readonly consumer: ParsedFile;
  readonly origins: OriginStore;
  readonly unavailable: Set<string>;
  readonly allocateSyntaxId: () => SyntaxId;
}): {
  readonly syntax: SyntaxSequence;
  readonly aliases: ReadonlyMap<string, string>;
} {
  const aliases = new Map<string, string>();
  const fresh = (name: string) => {
    let suffix = 1;
    let candidate = `${name}_${suffix}`;
    while (options.unavailable.has(candidate)) {
      suffix += 1;
      candidate = `${name}_${suffix}`;
    }
    options.unavailable.add(candidate);
    return candidate;
  };
  const imports = runtimeImportDeclarations(options.owner, options.origins).map(
    (declaration) =>
      createSyntaxSequence(
        declaration.map((node): Syntax => {
          if (node.tag === "token" && node.kind === "string-literal") {
            const specifier = String(node.value ?? node.raw.slice(1, -1));
            if (!specifier.startsWith(".")) return node;
            let rebased = relative(
              dirname(options.consumer.fileName),
              resolve(dirname(options.owner.fileName), specifier),
            ).replaceAll("\\", "/");
            if (!rebased.startsWith(".")) rebased = `./${rebased}`;
            return Object.freeze({
              ...node,
              id: options.allocateSyntaxId(),
              raw: JSON.stringify(rebased),
              value: rebased,
            });
          }
          if (node.tag !== "group" || node.delimiter !== "brace") return node;
          const children: Syntax[] = [];
          for (let index = 0; index < node.children.length; index += 1) {
            const child = node.children[index]!;
            if (child.tag !== "token" || child.kind !== "identifier") {
              children.push(child);
              continue;
            }
            const next = node.children[index + 1];
            const previous = node.children[index - 1];
            const existingAlias =
              previous?.tag === "token" && previous.raw === "as";
            const local = existingAlias
              ? child.raw
              : next?.tag === "token" && next.raw === "as"
                ? undefined
                : child.raw;
            if (local === undefined || !options.unavailable.has(local)) {
              children.push(child);
              continue;
            }
            const alias = fresh(local);
            aliases.set(local, alias);
            if (existingAlias) {
              children.push(
                Object.freeze({
                  ...child,
                  id: options.allocateSyntaxId(),
                  raw: alias,
                  value: alias,
                }),
              );
              continue;
            }
            children.push(child);
            children.push(
              Object.freeze({
                ...child,
                id: options.allocateSyntaxId(),
                kind: "keyword" as const,
                raw: "as",
                value: "as",
                leadingTrivia: Object.freeze([
                  {
                    kind: "whitespace" as const,
                    raw: " ",
                    span: child.span,
                    hasLineBreak: false,
                  },
                ]),
              }),
              Object.freeze({
                ...child,
                id: options.allocateSyntaxId(),
                raw: alias,
                value: alias,
                leadingTrivia: Object.freeze([
                  {
                    kind: "whitespace" as const,
                    raw: " ",
                    span: child.span,
                    hasLineBreak: false,
                  },
                ]),
              }),
            );
          }
          return createGroup({
            ...node,
            id: options.allocateSyntaxId(),
            children: createSyntaxSequence(children),
          });
        }),
      ),
  );
  return Object.freeze({
    syntax: createSyntaxSequence(imports.flatMap((declaration) => declaration)),
    aliases,
  });
}

/** What a file's compile-time imports say, to tell two reads of it apart. */
function compileTimeImportsKey(file: ParsedFile): string {
  return JSON.stringify(
    file.imports.imports.map(({ specifier, bindings, shadowsCore, span }) => [
      specifier,
      bindings.map(({ imported, local }) => [imported, local]),
      shadowsCore,
      span.start,
      span.end,
    ]),
  );
}

function compileTimeRanges(file: ParsedFile, origins: OriginStore) {
  return [
    // The opt-in directive is a compile-time marker with no runtime meaning,
    // so it is stripped from the generated file rather than expanded.
    ...(file.directive === undefined ? [] : [file.directive]),
    ...file.imports.imports.map(({ span }) => span),
    ...definitionRanges(file.root, file.parsed, origins),
  ];
}

function semanticBindingLiteralMatcher(options: {
  readonly files: readonly ParsedFile[];
  readonly origins: OriginStore;
  readonly compilerOptions: ts.CompilerOptions;
  readonly system: ts.System;
  /** What the program reads, so every read of its is an input. */
  readonly recorder: InputRecorder;
}) {
  if (
    options.files.every(({ compiled }) => compiled.bindingLiterals.length === 0)
  )
    return Object.freeze({
      matcherFor: () => () => false,
      diagnostics: Object.freeze([] as Diagnostic[]),
    });
  const virtualSources = new Map<
    string,
    { readonly file: ParsedFile; readonly text: string }
  >();
  const probes = new Map<
    BindingId,
    { readonly fileName: string; readonly at: number }
  >();
  for (const file of options.files) {
    const erased = [...file.sourceText];
    for (const { start, end } of compileTimeRanges(file, options.origins))
      for (let index = start; index < end; index += 1)
        if (erased[index] !== "\n" && erased[index] !== "\r")
          erased[index] = " ";
    let text = erased.join("");
    for (const literal of file.compiled.bindingLiterals) {
      const prefix = `\nvoid (`;
      const at =
        text.length +
        prefix.length +
        Math.max(0, literal.reference.lastIndexOf(".") + 1);
      text += `${prefix}${literal.reference});`;
      probes.set(literal.binding, { fileName: file.kind.virtualFileName, at });
    }
    virtualSources.set(file.kind.virtualFileName, { file, text });
  }
  // Everything the program reads goes through the expansion's recorder:
  // module resolution's probes, the type roots it lists, where links lead,
  // the library files. What it finds decides which symbol a literal names, so
  // each is an input to the expansion as much as a source is.
  const { system, recorder } = options;
  const read = (fileName: string): string | undefined =>
    virtualSources.get(resolve(fileName))?.text ?? recorder.file(fileName).text;
  // Where TypeScript keeps its libraries, by the system's own account of
  // where TypeScript is, as TypeScript's own compiler host has it.
  const libraryLocation = dirname(system.getExecutingFilePath());
  const host: ts.CompilerHost = {
    fileExists: (fileName) => read(fileName) !== undefined,
    readFile: read,
    getSourceFile: (fileName, languageVersion) => {
      const text = read(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(
            fileName,
            text,
            languageVersion,
            true,
            scriptKindForFileName(fileName),
          );
    },
    getDefaultLibLocation: () => libraryLocation,
    getDefaultLibFileName: (compilerOptions) =>
      join(libraryLocation, ts.getDefaultLibFileName(compilerOptions)),
    writeFile: () => {},
    getCurrentDirectory: () => system.getCurrentDirectory(),
    getCanonicalFileName: (fileName) =>
      system.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    useCaseSensitiveFileNames: () => system.useCaseSensitiveFileNames,
    getNewLine: () => system.newLine,
    directoryExists: (directoryName) =>
      recorder.directory(directoryName).exists,
    getDirectories: (directoryName) => [
      ...recorder.subdirectories(directoryName).names,
    ],
    ...(system.realpath === undefined
      ? {}
      : {
          realpath: (fileName: string) => recorder.realpath(fileName).target,
        }),
  };
  const program = ts.createProgram({
    rootNames: [...virtualSources.keys()],
    options: { ...options.compilerOptions, noEmit: true },
    host,
  });
  const checker = program.getTypeChecker();
  const identifierAt = (fileName: string, start: number, end?: number) => {
    const source = program.getSourceFile(fileName);
    if (source === undefined) return undefined;
    // Descended a level at a time rather than by recursion: a chain of binary
    // operators is one node deep per operator, and a long one ran out of
    // stack.
    let node: ts.Node | undefined = source;
    while (node !== undefined) {
      if (
        ts.isIdentifier(node) &&
        node.getStart(source) === start &&
        (end === undefined || node.end === end)
      )
        return node;
      node = ts.forEachChild(node, (child) =>
        start >= child.pos && start < child.end ? child : undefined,
      );
    }
    return undefined;
  };
  const unalias = (symbol: ts.Symbol | undefined) =>
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const symbolKey = (symbol: ts.Symbol | undefined) => {
    if (symbol === undefined) return undefined;
    const declarations = symbol.declarations ?? [];
    return declarations.length === 0
      ? `intrinsic:${symbol.name}`
      : declarations
          .map(
            (declaration) =>
              `${resolve(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}`,
          )
          .sort()
          .join("|");
  };
  const targets = new Map<BindingId, string>();
  for (const [binding, probe] of probes) {
    const identifier = identifierAt(probe.fileName, probe.at);
    const symbol = unalias(
      identifier === undefined
        ? undefined
        : checker.getSymbolAtLocation(identifier),
    );
    const key = symbolKey(symbol);
    if (key !== undefined) targets.set(binding, key);
  }
  const unresolvedDiagnostics = options.files.flatMap((file) =>
    file.compiled.bindingLiterals.flatMap((literal) => {
      if (targets.has(literal.binding)) return [];
      const span = options.origins.selectPrimarySource(literal.origin)
        ?.span ?? {
        start: 0,
        end: 0,
      };
      return [
        expansionDiagnosticRegistry.create(unresolvedBindingLiteralCode, {
          primaryOrigin: {
            sourceId: file.sourceId,
            start: span.start,
            end: span.end,
            originId: literal.origin,
          },
          messageArguments: [literal.alias, literal.reference],
        }),
      ];
    }),
  );
  const matcherFor =
    (file: ParsedFile) =>
    (
      token: Extract<RootSyntax["children"][number], { readonly tag: "token" }>,
      literal: { readonly binding: BindingId },
    ) => {
      const identifier = identifierAt(
        file.kind.virtualFileName,
        token.span.start,
        token.span.end,
      );
      return (
        identifier !== undefined &&
        symbolKey(unalias(checker.getSymbolAtLocation(identifier))) ===
          targets.get(literal.binding)
      );
    };
  return Object.freeze({
    matcherFor,
    diagnostics: Object.freeze(unresolvedDiagnostics),
  });
}

function generatedOrigin(
  origins: OriginStore,
  originId: Parameters<OriginStore["get"]>[0],
  seen = new Set<number>(),
): boolean {
  if (seen.has(originId)) return false;
  seen.add(originId);
  const origin = origins.get(originId);
  if (origin === undefined || origin.kind === "source") return false;
  if (origin.kind !== "composed") return true;
  return origin.parts.some((part) => generatedOrigin(origins, part, seen));
}

function originContains(
  origins: OriginStore,
  root: Parameters<OriginStore["get"]>[0],
  wanted: Parameters<OriginStore["get"]>[0],
  seen = new Set<number>(),
): boolean {
  if (root === wanted) return true;
  if (seen.has(root)) return false;
  seen.add(root);
  const origin = origins.get(root);
  if (origin === undefined || origin.kind === "source") return false;
  if (origin.kind === "composed")
    return origin.parts.some((part) =>
      originContains(origins, part, wanted, seen),
    );
  if (origin.kind === "copied")
    return originContains(origins, origin.parent, wanted, seen);
  return originContains(origins, origin.invocation, wanted, seen);
}

export interface DefaultProjectExpansionOutput extends ProjectExpansionOutput {
  /**
   * Every question the expansion asked of the file system, with its answer,
   * asked of the provider's `fileSystem`.
   *
   * Expanding the same project again gives the same output for as long as
   * each gets the same answer. Expansion's own lookups are at the paths it
   * looked under rather than where a link leads, so a package manager
   * pointing a link at a new version reads as a change. Where a macro names a
   * binding literal, these include everything the TypeScript program that
   * resolves it read and looked for, its libraries among them.
   */
  readonly inputs: readonly ExpansionInput[];
  /**
   * Whether a macro named a binding literal, which TypeScript resolves over
   * every source in the project. Each file's expansion then depends on the
   * project's whole file list and every one of `inputs`, not only on its own.
   */
  readonly resolvesBindingLiterals: boolean;
}

export interface DefaultSourceExpansionInspection extends SourceExpansionInspection {
  /** The name the expanded file is presented to TypeScript under. */
  readonly virtualFileName: string;
  /** Built the first time it is read. */
  readonly sourceMap: RawSourceMap;
  /**
   * What this file's expansion asked of the file system, with the answers:
   * the file itself, the macro modules it reads macros from, and every lookup
   * made resolving their imports. While each gets the same answer, expanding
   * the file again gives the same output and the same diagnostics -- unless
   * the expansion resolved binding literals, when these are all of the
   * project's inputs and its file list counts too (see
   * `resolvesBindingLiterals`).
   */
  readonly inputs: readonly ExpansionInput[];
}

/** Default, synchronous project frontend used by both the API and executable. */
export class DefaultProjectExpansionProvider
  implements ProjectExpansionProvider, ExpansionInspectionProvider
{
  readonly #system: ts.System;
  readonly #fileSystem: ExpansionFileSystem;
  readonly #inspections = new Map<string, DefaultSourceExpansionInspection>();
  /** The config the last expansion to finish was of, and what it asked. */
  #lastInputs:
    | {
        readonly configPath: string;
        readonly inputs: readonly ExpansionInput[];
      }
    | undefined;
  #debug: unknown = Object.freeze({ files: 0, modules: 0, invocations: 0 });

  /**
   * `system` is what expansion reads in place of the disk: every source,
   * package and lookup, and what TypeScript reads resolving binding literals.
   */
  constructor(options: { readonly system?: ts.System | undefined } = {}) {
    this.#system = options.system ?? ts.sys;
    this.#fileSystem =
      options.system === undefined
        ? diskFileSystem
        : suppliedFileSystem(options.system);
  }

  /**
   * The file system expansions read, which is the one to ask whether their
   * `inputs` still hold.
   */
  get fileSystem(): ExpansionFileSystem {
    return this.#fileSystem;
  }

  /**
   * Expands every source of the project, reading each slash the way the
   * enforester reads it.
   *
   * The reader judges a slash from the token before it, and where the grammar
   * says otherwise the enforester reads it as the grammar does: in place,
   * where only the tokens of one expression change, and by reading the source
   * again where more does (see `SlashReadings`). A file read again is expanded
   * again, on its own where nothing else was expanded from what it read. A
   * file that defines macros, or that another file reads macros from, is read
   * again only with the whole project, which is then expanded again; nothing
   * from the earlier expansion survives into the result either way.
   *
   * Every read of the project asks the file system through one recorder, so
   * each read takes the text the first one found, and the inputs are every
   * question any of them asked.
   */
  expandProject(project: LoadedSweetProject): DefaultProjectExpansionOutput {
    const recorder = new InputRecorder(this.#fileSystem.system);
    return settleSlashReadings<
      DefaultProjectExpansionOutput,
      ReadonlyMap<string, SlashReadings>
    >(
      new Map(),
      (readings) =>
        [...readings].flatMap(([fileName, file]) =>
          [...askedReadings(file)].map((reading) => `${fileName} ${reading}`),
        ),
      (readings, final, reads) =>
        this.#expandProjectReading(project, recorder, readings, final, reads),
    );
  }

  #expandProjectReading(
    project: LoadedSweetProject,
    recorder: InputRecorder,
    readings: ReadonlyMap<string, SlashReadings>,
    final: boolean,
    projectReads: number,
  ): SlashAttempt<
    DefaultProjectExpansionOutput,
    ReadonlyMap<string, SlashReadings>
  > {
    this.#inspections.clear();
    const origins = new OriginStore();
    const scopes = new ScopeStore();
    const sourceIds = createIdAllocator<SourceId>(1);
    const syntaxIds = createIdAllocator<SyntaxId>(100_000);
    const bindingIds = createIdAllocator<BindingId>(100_000);
    const invocationIds = createIdAllocator<InvocationId>(1);
    const phase = createPhase(1);
    const byPath = new Map<string, ParsedFile>();
    const bySource = new Map<SourceId, ParsedFile>();
    const diagnostics: Diagnostic[] = [];
    // Held for TypeScript rather than reported here. See
    // `ProjectExpansionOutput.unresolvedNameExplanations`.
    const unresolvedNameExplanations: Diagnostic[] = [];
    const manifestByEntry = new Map<string, DeclarativeMacroManifest>();
    // Which files each module consulted: its own text, and every lookup made
    // resolving its imports. A file's expansion depends on what the modules
    // it reads macros from consulted, and on nothing else on disk.
    const consultedBy = new Map<string, Set<ExpansionInput>>();
    const consult = (owner: string, fileName: string): string | undefined => {
      const input = recorder.file(fileName);
      let consulted = consultedBy.get(owner);
      if (consulted === undefined) {
        consulted = new Set();
        consultedBy.set(owner, consulted);
      }
      consulted.add(input);
      return input.text;
    };
    // What a module answers for beyond reading and compiling it: what went
    // wrong resolving its imports, and its binding literals. Kept by module
    // so each file reports what its own macros depend on, whichever file
    // happened to be expanded first.
    const moduleDiagnostics = new Map<string, Diagnostic[]>();
    const reportAgainst = (
      module: ParsedFile,
      ...reported: readonly Diagnostic[]
    ): void => {
      diagnostics.push(...reported);
      const existing = moduleDiagnostics.get(module.fileName);
      if (existing === undefined)
        moduleDiagnostics.set(module.fileName, [...reported]);
      else existing.push(...reported);
    };
    const answerableFor = (module: ParsedFile): readonly Diagnostic[] => [
      ...module.diagnostics,
      ...(moduleDiagnostics.get(module.fileName) ?? []),
    ];
    /** One source, read with `slashReadings`, and the macros it defines. */
    const readFile = (
      fileName: string,
      kind: SourceKind,
      sourceId: SourceId,
      sourceText: string,
      definitionScopes: ScopeSetId,
      slashReadings: SlashReadings,
    ): ParsedFile => {
      const read = readSyntax(sourceText, {
        sourceId,
        scopes: definitionScopes,
        originStore: origins,
        variant: kind.variant,
        slashReadings,
      });
      const parsed = parseMacroDefinitions(read.root, { sourceId });
      const imports = parseCompileTimeSyntaxImports(read.root, { sourceId });
      const compiled = compileParsedMacros(parsed, {
        sourceId,
        phase,
        definitionScopes,
        allocateBindingId: bindingIds.allocate,
        spanForOrigin: (origin) =>
          origins.selectPrimarySource(origin)?.span ?? { start: 0, end: 0 },
      });
      return Object.freeze({
        fileName,
        kind,
        directive: findSweetenerDirective(sourceText),
        sourceId,
        sourceText,
        root: read.root,
        slashReadings: read.slashReadings,
        parsed,
        imports,
        compiled,
        diagnostics: Object.freeze([
          ...read.diagnostics,
          ...parsed.diagnostics,
          ...imports.diagnostics,
          ...compiled.diagnostics,
        ]),
      });
    };
    const loadFile = (
      fileName: string,
      sourceKind?: SourceKind,
    ): ParsedFile => {
      const absolute = resolve(fileName);
      const existing = byPath.get(absolute);
      if (existing !== undefined) return existing;
      const sourceText = consult(absolute, absolute);
      // Every caller consulted the file first and found it, and a file is
      // consulted once an expansion, so it is found here too.
      if (sourceText === undefined)
        throw new Error(
          `${absolute} was found and then had no text: a file is consulted once an expansion, so this cannot happen`,
        );
      const kind =
        sourceKind ??
        importedMacroModuleKind(absolute, project.sweet.macroExtensions);
      const file = readFile(
        absolute,
        kind,
        sourceIds.allocate(),
        sourceText,
        scopes.singleton(scopes.freshScope("module", absolute)),
        readings.get(absolute) ?? new Map(),
      );
      byPath.set(absolute, file);
      bySource.set(file.sourceId, file);
      diagnostics.push(...file.diagnostics);
      return file;
    };
    const sweetFiles = selectSweetSources({
      fileNames: project.typescript.fileNames,
      macroExtensions: project.sweet.macroExtensions,
      readSource: (fileName) => consult(fileName, fileName),
    });
    // A listed source that cannot be read is TypeScript's to report, as a
    // root it cannot find, and expands into nothing here. No other file reads
    // it to expand, so the rest expand as they would without it -- and that
    // it could not be read is its own input, as any read is.
    const projectFiles = sweetFiles.flatMap(({ fileName, kind }) =>
      consult(resolve(fileName), fileName) === undefined
        ? []
        : [loadFile(fileName, kind)],
    );
    const aliasBase = project.typescript.options.baseUrl
      ? resolve(project.typescript.options.baseUrl)
      : dirname(project.configPath);
    const aliases = Object.entries(project.typescript.options.paths ?? {}).map(
      ([pattern, targets]) => ({
        pattern,
        targets: targets.map((target) => resolve(aliasBase, target)),
      }),
    );
    /**
     * Every macro module a file reads macros from, however far away. A macro
     * module that fails to compile stops the macros of everything downstream of
     * it, not only of its immediate importer.
     */
    const macroSourcesFor = (fileName: string): ReadonlySet<SourceId> => {
      const collected = new Set<SourceId>();
      const seen = new Set<string>();
      const pending = [fileName];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const sourceId of macroSources.get(current) ?? []) {
          collected.add(sourceId);
          const parsed = bySource.get(sourceId);
          if (parsed !== undefined) pending.push(parsed.fileName);
        }
      }
      return collected;
    };
    const discovered = new Set<string>();
    // Which macro modules each file reads its macros from. A file whose macros
    // did not compile expands into itself, and saying nothing about that would
    // report the unexpanded source as the expansion.
    const macroSources = new Map<string, Set<SourceId>>();
    const dependsOn = (importer: ParsedFile, target: ParsedFile): void => {
      let sources = macroSources.get(importer.fileName);
      if (sources === undefined) {
        sources = new Set<SourceId>();
        macroSources.set(importer.fileName, sources);
      }
      sources.add(target.sourceId);
    };
    // Where each module's imports led, by the module's path and the
    // specifier, as found from that module against the file system. The
    // resolver takes these rather than resolving again from what the whole
    // project loaded, which would have one file's imports lead wherever
    // another file's had: to the package of the same name nearest some other
    // importer, or to whichever alias target some other file loaded.
    const importTargets = new Map<string, Map<string, string>>();
    const resolvedFrom = (importer: ParsedFile): Map<string, string> => {
      let resolved = importTargets.get(importer.fileName);
      if (resolved === undefined) {
        resolved = new Map();
        importTargets.set(importer.fileName, resolved);
      }
      return resolved;
    };
    /**
     * Find where `specifier` leads from `importer` -- a relative path or a
     * `paths` alias target, the first of them that is there, as TypeScript
     * takes it, or else the nearest installed package -- and load what it
     * leads to. Every lookup is consulted as `importer`'s, so whoever reads
     * macros from `importer` depends on exactly what led its imports where
     * they lead. Problems are reported against `importer`, at `at`.
     */
    const resolveImport = (
      importer: ParsedFile,
      specifier: string,
      at: Diagnostic["primaryOrigin"],
    ): readonly ParsedFile[] => {
      const relativeTarget = specifier.startsWith(".")
        ? resolve(dirname(importer.fileName), specifier)
        : undefined;
      const aliasTargets = aliases.flatMap(({ pattern, targets }) => {
        const star = pattern.indexOf("*");
        const prefix = star < 0 ? pattern : pattern.slice(0, star);
        const suffix = star < 0 ? "" : pattern.slice(star + 1);
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix))
          return [];
        const capture =
          star < 0
            ? ""
            : specifier.slice(prefix.length, specifier.length - suffix.length);
        return targets.map((target) => target.replace("*", capture));
      });
      const localTarget = [relativeTarget, ...aliasTargets].find(
        (candidate): candidate is string =>
          candidate !== undefined &&
          consult(importer.fileName, candidate) !== undefined,
      );
      if (localTarget !== undefined) {
        resolvedFrom(importer).set(specifier, localTarget);
        return [loadFile(localTarget)];
      }
      const parsedPackage = packageParts(specifier);
      const consultPackage = (fileName: string): string | undefined =>
        consult(importer.fileName, fileName);
      const packageManifest = findPackageManifest(
        importer.fileName,
        parsedPackage.name,
        consultPackage,
      );
      if (packageManifest === undefined) return [];
      const packageRoot = dirname(packageManifest.path);
      let packageJson: Record<string, unknown>;
      try {
        packageJson = JSON.parse(packageManifest.text) as Record<
          string,
          unknown
        >;
      } catch {
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [packageManifest.path, "invalid package JSON"],
          }),
        );
        return [];
      }
      const pointerValue = packageJson["sweetMacros"];
      const pointer =
        typeof pointerValue === "string" && parsedPackage.subpath === "."
          ? pointerValue
          : pointerValue !== null &&
              typeof pointerValue === "object" &&
              !Array.isArray(pointerValue)
            ? (pointerValue as Record<string, unknown>)[parsedPackage.subpath]
            : undefined;
      if (typeof pointer !== "string") return [];
      const manifestPath = resolve(packageRoot, pointer);
      if (isAbsolute(pointer) || !inside(packageRoot, manifestPath)) {
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [
              specifier,
              "sweetMacros pointer escapes package root",
            ],
          }),
        );
        return [];
      }
      const manifestText = consultPackage(manifestPath);
      if (manifestText === undefined) {
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [manifestPath, "manifest file does not exist"],
          }),
        );
        return [];
      }
      const manifestSourceId = sourceIds.allocate();
      let manifestJson: unknown;
      try {
        manifestJson = JSON.parse(manifestText);
      } catch {
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [manifestPath, "invalid manifest JSON"],
          }),
        );
        return [];
      }
      const parsedManifest = parseMacroModuleManifest(manifestJson, {
        sourceId: manifestSourceId,
        label: manifestPath,
      });
      reportAgainst(importer, ...parsedManifest.diagnostics);
      if (parsedManifest.manifest === undefined) return [];
      const entry = resolve(packageRoot, parsedManifest.manifest.entry);
      const exportSources = Object.values(parsedManifest.manifest.exports).map(
        ({ source }) => resolve(packageRoot, source),
      );
      if (
        isAbsolute(parsedManifest.manifest.entry) ||
        Object.values(parsedManifest.manifest.exports).some(({ source }) =>
          isAbsolute(source),
        ) ||
        !inside(packageRoot, entry) ||
        exportSources.some((source) => !inside(packageRoot, source))
      ) {
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [
              manifestPath,
              "entry or export source escapes package root",
            ],
          }),
        );
        return [];
      }
      if (
        consultPackage(entry) === undefined ||
        exportSources.some((source) => consultPackage(source) === undefined)
      ) {
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [
              manifestPath,
              "entry or export source does not exist",
            ],
          }),
        );
        return [];
      }
      const normalizedManifest: DeclarativeMacroManifest = Object.freeze({
        ...parsedManifest.manifest,
        entry,
        exports: Object.freeze(
          Object.fromEntries(
            Object.entries(parsedManifest.manifest.exports).map(
              ([name, exported]) => [
                name,
                Object.freeze({
                  ...exported,
                  source: resolve(packageRoot, exported.source),
                }),
              ],
            ),
          ),
        ),
      });
      manifestByEntry.set(entry, normalizedManifest);
      const packageFiles = [...new Set([entry, ...exportSources])].map(
        (packageFile) => loadFile(packageFile),
      );
      const declaredMacroDependencies = new Set(
        normalizedManifest.dependencies
          .filter(({ kind }) => kind === "macro")
          .map(({ specifier }) => specifier),
      );
      const undeclared = packageFiles
        .flatMap(({ imports }) => imports.imports)
        .map(({ specifier }) => specifier)
        .filter((specifier) => !declaredMacroDependencies.has(specifier));
      const invalidExports = Object.entries(normalizedManifest.exports)
        .filter(
          ([name, exported]) =>
            byPath
              .get(exported.source)
              ?.compiled.get(name, exported.category) === undefined,
        )
        .map(([name]) => name);
      if (undeclared.length > 0 || invalidExports.length > 0)
        reportAgainst(
          importer,
          moduleDiagnosticRegistry.create(invalidMacroManifestCode, {
            primaryOrigin: at,
            messageArguments: [
              manifestPath,
              [
                ...undeclared.map(
                  (specifier) => `undeclared dependency ${specifier}`,
                ),
                ...invalidExports.map(
                  (name) => `missing compiled export ${name}`,
                ),
              ].join(", "),
            ],
          }),
        );
      resolvedFrom(importer).set(specifier, entry);
      return packageFiles;
    };
    const pendingDiscovery = [...projectFiles];
    while (pendingDiscovery.length > 0) {
      const importer = pendingDiscovery.shift()!;
      if (discovered.has(importer.fileName)) continue;
      discovered.add(importer.fileName);
      const found = (targets: readonly ParsedFile[]): void => {
        for (const target of targets) {
          dependsOn(importer, target);
          pendingDiscovery.push(target);
        }
      };
      for (const sourceImport of importer.imports.imports)
        found(
          resolveImport(importer, sourceImport.specifier, {
            sourceId: importer.sourceId,
            start: sourceImport.span.start,
            end: sourceImport.span.end,
            originId: sourceImport.origin,
          }),
        );
      // A package's declared macro dependencies lead from its entry, as an
      // import written there would: the manifest names them for the package,
      // whichever of its files imports them.
      const imported = new Set(
        importer.imports.imports.map(({ specifier }) => specifier),
      );
      for (const dependency of manifestByEntry.get(importer.fileName)
        ?.dependencies ?? [])
        if (dependency.kind === "macro" && !imported.has(dependency.specifier))
          found(
            resolveImport(importer, dependency.specifier, {
              sourceId: importer.sourceId,
              start: 0,
              end: 0,
            }),
          );
    }
    const moduleSources: MacroModuleSource[] = [...byPath.values()].map(
      (file) => ({
        path: file.fileName,
        sourceId: file.sourceId,
        manifest: manifestByEntry.get(file.fileName) ?? {
          formatVersion: 1,
          name: file.fileName,
          languageVersion: project.sweet.languageVersion,
          compiler: { minimum: "0.1.0", maximum: "0.x.x" },
          entry: file.fileName,
          exports: Object.fromEntries(
            file.parsed.definitions.flatMap((definition) =>
              definition.exported && definition.kind !== "syntax-class"
                ? [
                    [
                      definition.kind === "operator"
                        ? definition.spelling
                        : definition.name,
                      {
                        source: file.fileName,
                        category: definition.category,
                        phase: 1,
                      },
                    ],
                  ]
                : [],
            ),
          ),
          dependencies: file.imports.imports.map((sourceImport) => ({
            specifier: sourceImport.specifier,
            kind: "macro" as const,
            exports: sourceImport.bindings.map(({ imported }) => imported),
          })),
        },
      }),
    );
    const virtualFiles: VirtualTypeScriptFile[] = [];
    const bindingLiterals = semanticBindingLiteralMatcher({
      files: [...byPath.values()],
      origins,
      compilerOptions: project.typescript.options,
      system: this.#system,
      recorder,
    });
    for (const diagnostic of bindingLiterals.diagnostics)
      reportAgainst(
        bySource.get(diagnostic.primaryOrigin.sourceId)!,
        diagnostic,
      );
    let invocationCount = 0;
    const resolveFound: ResolveSpecifier = (from, specifier) =>
      importTargets.get(from)?.get(specifier);
    // Which module owns each macro binding is a fact about the project, so it
    // is gathered once rather than for every file expanded.
    const ownersByBinding = new Map(
      [...byPath.values()].flatMap((owner) =>
        owner.compiled.macros.map(
          ({ binding }) => [binding.id, owner] as const,
        ),
      ),
    );
    // Both describe the project's macro modules, not the file being
    // expanded, so they are built once rather than once per file.
    const visibilityByModule = new Map<
      CompileParsedMacrosResult,
      Map<string, number>
    >(
      [...byPath.values()].map((moduleFile) => [
        moduleFile.compiled,
        new Map(
          moduleFile.compiled.definitions.map(({ definition, macro }) => [
            `${macro.binding.spelling}|${String(macro.binding.id)}`,
            definition.kind === "syntax"
              ? definition.recursive && definition.body !== undefined
                ? definition.body.span.start
                : definition.end.span.end
              : definition.body.span.end,
          ]),
        ),
      ]),
    );
    // Each visibility threshold is an offset into one particular file, so it
    // can only be compared against a position from that same file.
    const visibilitySourceByModule = new Map<
      CompileParsedMacrosResult,
      SourceId
    >(
      [...byPath.values()].map((moduleFile) => [
        moduleFile.compiled,
        moduleFile.sourceId,
      ]),
    );
    // Whether TypeScript resolved binding literals, over every source in the
    // project, which then makes every file's expansion depend on all of it.
    const resolvesBindingLiterals = [...byPath.values()].some(
      ({ compiled }) => compiled.bindingLiterals.length > 0,
    );
    // Nothing is read from here on: every source is loaded and the program
    // resolving binding literals, if any, is built.
    const inputs = recorder.inputs;
    /**
     * What a file's expansion consulted on disk: what it and each module it
     * reads macros from consulted, every lookup resolving their imports among
     * it -- or, once TypeScript resolved binding literals over the whole
     * project, everything.
     */
    const inputsFor = (
      modules: readonly ParsedFile[],
    ): readonly ExpansionInput[] => {
      if (resolvesBindingLiterals) return inputs;
      const consulted = new Set<ExpansionInput>();
      for (const { fileName } of modules) {
        for (const input of consultedBy.get(fileName) ?? [])
          consulted.add(input);
      }
      return Object.freeze([...consulted]);
    };
    /** Where a slash token was read, by the policy `policy` names. */
    const slashOrigin = (
      slash: TokenSyntax,
      policy: "invocation" | "definition",
    ) => {
      const selected = origins.selectPrimarySource(slash.origin, policy);
      return {
        sourceId: selected.sourceId,
        start: selected.span.start,
        end: selected.span.end,
        originId: slash.origin,
      };
    };
    /**
     * A slash a macro's template wrote that is read the other way where a use
     * of it puts it, which reading the template again cannot serve.
     */
    const templateSlashDiagnostic = (
      slash: TokenSyntax,
      reading: SlashReading,
    ): Diagnostic => {
      const template = slashOrigin(slash, "definition");
      const use = slashOrigin(slash, "invocation");
      return expansionDiagnosticRegistry.create(unreadableTemplateSlashCode, {
        primaryOrigin: template,
        relatedOrigins:
          use.sourceId === template.sourceId && use.start === template.start
            ? []
            : [
                {
                  message: "The use of the macro that puts it here",
                  origin: use,
                },
              ],
        messageArguments: [reading],
      });
    };
    /**
     * Expands one of the project's files as `file` reads it, holding what the
     * expansion says until it is kept.
     *
     * A slash in the file's own text that the enforester found read the other
     * way, where reading it so changes more than the tokens of one expression,
     * asks for the file to be read again with the slash read as the enforester
     * found it. Unless this is the last read allowed, an expansion that found
     * one is not printed, and the readings to read the file with next are
     * answered instead: nothing from it is kept.
     */
    const expandFile = (
      file: ParsedFile,
      final: boolean,
      reads: number,
    ): SlashAttempt<undefined, SlashReadings> => {
      const held: Diagnostic[] = [];
      /** The slashes of the file's text found read the other way, by offset. */
      const found = new Map<number, SlashReading>();
      /** Those found read the other way both ways, where they were copied. */
      const ambiguous = new Map<number, TokenSyntax>();
      /** The template slashes reported, by where each use writes one. */
      const templateSlashes = new Set<string>();
      const resolvedGraph = resolveMacroProject({
        entry: file.fileName,
        languageVersion: project.sweet.languageVersion,
        compilerVersion: "0.1.0",
        modules: moduleSources,
        resolve: resolveFound,
      });
      held.push(
        ...resolvedGraph.diagnostics.filter(
          ({ code }) => code === "SWR5003" || code === "SWR5005",
        ),
      );
      const imported = new Map<
        string,
        ReturnType<CompileParsedMacrosResult["get"]>
      >();
      const importsByModule = new Map<
        CompileParsedMacrosResult,
        Map<string, NonNullable<ReturnType<CompileParsedMacrosResult["get"]>>>
      >();
      const importOriginsByModule = new Map<
        CompileParsedMacrosResult,
        Map<BindingId, Parameters<OriginStore["get"]>[0]>
      >();
      const coreShadowBindingsByModule = new Map<
        CompileParsedMacrosResult,
        Set<BindingId>
      >();
      const importedModules: CompileParsedMacrosResult[] = [];
      const pending = [file];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const importer = pending.shift()!;
        if (visited.has(importer.fileName)) continue;
        visited.add(importer.fileName);
        const resolvedImports = resolveSourceMacroImports({
          entry: importer.fileName,
          imports: importer.imports.imports.map((sourceImport) => ({
            specifier: sourceImport.specifier,
            bindings: sourceImport.bindings.map((binding) => {
              const selected = origins.selectPrimarySource(binding.origin);
              return {
                imported: binding.imported,
                local: binding.local,
                origin: {
                  sourceId: importer.sourceId,
                  start: selected?.span.start ?? sourceImport.span.start,
                  end: selected?.span.end ?? sourceImport.span.end,
                  originId: binding.origin,
                },
              };
            }),
          })),
          modules: moduleSources,
          resolve: resolveFound,
        });
        held.push(...resolvedImports.diagnostics);
        const importerBindings =
          importsByModule.get(importer.compiled) ?? new Map();
        importsByModule.set(importer.compiled, importerBindings);
        const importerOrigins =
          importOriginsByModule.get(importer.compiled) ?? new Map();
        importOriginsByModule.set(importer.compiled, importerOrigins);
        const importerCoreShadows =
          coreShadowBindingsByModule.get(importer.compiled) ?? new Set();
        coreShadowBindingsByModule.set(importer.compiled, importerCoreShadows);
        for (const binding of resolvedImports.bindings) {
          const target = byPath.get(resolve(binding.export.source));
          const macro = target?.compiled.get(
            binding.imported,
            binding.export.category,
          );
          if (
            target !== undefined &&
            !importedModules.includes(target.compiled)
          ) {
            importedModules.push(target.compiled);
            pending.push(target);
          }
          if (macro !== undefined) {
            // The statement that declares this name, not merely the first one
            // naming the same module. A file may import one module twice --
            // once plainly and once `for syntax shadows core` -- and reading
            // `shadowsCore` off the first statement would silently drop the
            // authorization, so the core form would keep its built-in meaning
            // whenever the plain import came first.
            const sourceImport =
              importer.imports.imports.find(
                (candidate) =>
                  candidate.specifier === binding.specifier &&
                  candidate.bindings.some(
                    (declared) =>
                      declared.local === binding.local &&
                      declared.imported === binding.imported,
                  ),
              ) ??
              importer.imports.imports.find(
                ({ specifier }) => specifier === binding.specifier,
              );
            const definition = target?.compiled.definitions.find(
              ({ macro: candidate }) =>
                candidate.binding.id === macro.binding.id,
            )?.definition;
            if (
              sourceImport?.shadowsCore &&
              isCoreForm(
                binding.local,
                macro.category,
                coreFormKind(macro.binding),
              )
            ) {
              const definitionAuthorized =
                definition?.shadowsCore === true &&
                isCoreForm(
                  macro.binding.spelling,
                  macro.category,
                  coreFormKind(macro.binding),
                );
              if (!definitionAuthorized)
                held.push(
                  expansionDiagnosticRegistry.create(
                    unauthorizedCoreShadowImportCode,
                    {
                      primaryOrigin: binding.origin,
                      messageArguments: [binding.local],
                    },
                  ),
                );
              else importerCoreShadows.add(macro.binding.id);
            }
            if (!importerBindings.has(binding.local))
              importerBindings.set(binding.local, macro);
            if (!importerOrigins.has(macro.binding.id))
              importerOrigins.set(macro.binding.id, binding.origin.originId);
            visibilityByModule
              .get(importer.compiled)
              ?.set(
                `${binding.local}|${String(macro.binding.id)}`,
                sourceImport?.span.end ?? Number.POSITIVE_INFINITY,
              );
            if (importer === file && !imported.has(binding.local))
              imported.set(binding.local, macro);
          }
        }
      }
      const modules = [file.compiled, ...importedModules];
      const tracker = new ResourceTracker(
        createResourceBudget(project.sweet.limits),
      );
      const session = createExpansionFrontendSession({
        module: file.compiled,
        modules,
        importedBindings: imported as ReadonlyMap<
          string,
          NonNullable<ReturnType<CompileParsedMacrosResult["get"]>>
        >,
        importsByModule,
        importOriginsByModule,
        coreShadowBindingsByModule,
        matchesBindingLiteral: bindingLiterals.matcherFor(file),
        isMacroVisible: ({
          lexicalModule,
          spelling,
          macro,
          position,
          positionSourceId,
        }) => {
          const threshold = visibilityByModule
            .get(lexicalModule)
            ?.get(`${spelling}|${String(macro.binding.id)}`);
          if (threshold === undefined) return true;
          // A macro's replacement carries template syntax from the defining
          // file alongside syntax captured at the call site. Comparing a
          // captured position against this module's definition offsets would
          // compare offsets in two unrelated files, which made a macro
          // invocation inside a capture expand or not according to where it
          // happened to sit in its own file.
          const thresholdSource = visibilitySourceByModule.get(lexicalModule);
          if (
            positionSourceId !== undefined &&
            thresholdSource !== undefined &&
            positionSourceId !== thresholdSource
          )
            return true;
          return position >= threshold;
        },
        sourceId: file.sourceId,
        phase,
        scopeStore: scopes,
        origins,
        environments: new EnvironmentStore(),
        tracker,
        guard: new ExpansionGuard({ tracker }),
        allocateSyntaxId: syntaxIds.allocate,
        allocateBindingId: bindingIds.allocate,
        allocateInvocationId: invocationIds.allocate,
        slashMisread: (slash, reading) => {
          const written = writtenSource(origins, slash.origin);
          if (written?.sourceId !== file.sourceId) {
            // A replacement may be read more than once before the expansion
            // settles on a reading of it, and each finds the slash again.
            const key = `${String(slash.origin)}|${reading}`;
            if (!templateSlashes.has(key)) {
              templateSlashes.add(key);
              held.push(templateSlashDiagnostic(slash, reading));
            }
            return;
          }
          const offset = written.span.start;
          const before = found.get(offset);
          if (before !== undefined && before !== reading)
            ambiguous.set(offset, slash);
          else found.set(offset, reading);
        },
      });
      const runtime = runtimeSyntax(file, origins);
      const result =
        runtime.length === 0
          ? {
              syntax: runtime,
              traces: [],
              diagnostics: [],
              unresolvedNameExplanations: [],
            }
          : session.expand(runtime, "item");
      held.push(...result.diagnostics);
      for (const offset of ambiguous.keys()) found.delete(offset);
      const reread = nextSlashReadings(file.slashReadings, found);
      if (reread !== undefined && !final)
        return { kind: "reread", readings: reread } as const;
      for (const slash of ambiguous.values())
        held.push(
          expansionDiagnosticRegistry.create(ambiguousSlashCode, {
            primaryOrigin: slashOrigin(slash, "invocation"),
          }),
        );
      if (reread !== undefined) {
        const [offset, reading] = [...reread].find(
          ([at, value]) => file.slashReadings.get(at) !== value,
        )!;
        held.push(
          expansionDiagnosticRegistry.create(unsettledSlashCode, {
            primaryOrigin: {
              sourceId: file.sourceId,
              start: offset,
              end: offset + 1,
            },
            messageArguments: [reading, reads],
          }),
        );
      }
      diagnostics.push(...held);
      unresolvedNameExplanations.push(...result.unresolvedNameExplanations);
      invocationCount += result.traces.length;

      const invokedOwners = [
        ...new Set(
          result.traces.flatMap(({ binding }) => {
            const owner = ownersByBinding.get(binding);
            return owner === undefined || owner === file ? [] : [owner];
          }),
        ),
      ];
      // Both of these serve the runtime imports a file needs because it
      // invoked a macro defined elsewhere. A file that invoked none needs no
      // imports, and walking all of its identifiers to name them would be
      // answering a question nobody asked.
      const unavailable =
        invokedOwners.length === 0
          ? new Set<string>()
          : new Set(
              tokensIn(runtime)
                .filter(({ kind }) => kind === "identifier")
                .map(({ raw }) => raw),
            );
      const synthesized = invokedOwners.map((owner) => ({
        owner,
        ...definitionRuntimeImports({
          owner,
          consumer: file,
          origins,
          unavailable,
          allocateSyntaxId: syntaxIds.allocate,
        }),
      }));
      const printableSyntax = createSyntaxSequence([
        ...synthesized.flatMap(({ syntax }) => syntax),
        ...result.syntax,
      ]);
      const rawSpelling = new Map(
        tokensIn(printableSyntax).map((token) => [token.id, token.raw]),
      );
      const rewrites = (
        synthesized.length === 0 ? [] : tokensIn(result.syntax)
      ).flatMap((token) => {
        const sources = new Set(
          origins
            .collectSourceOrigins(token.origin)
            .map(({ sourceId }) => sourceId),
        );
        const alias = synthesized
          .find(({ owner }) => sources.has(owner.sourceId))
          ?.aliases.get(token.raw);
        return alias === undefined
          ? []
          : [
              {
                syntax: token.id,
                binding: 0 as BindingId,
                printedName: alias,
                replacement: alias,
                expandsShorthand: false,
              } as const,
            ];
      });
      const groupProtectedExpression = (
        syntax: Extract<Syntax, { readonly tag: "protected" }>,
      ) => generatedOrigin(origins, syntax.origin);
      const printWith = (
        names: readonly NameRewrite[],
      ): PrintedExpandedFile<typeof result.traces> =>
        printExpandedFile({
          syntax: printableSyntax,
          origins,
          trace: result.traces,
          names: {
            names: new Map(),
            rewrites: names,
            nameFor: () => undefined,
          },
          groupProtectedExpression,
        });
      // Renaming needs to know which identifiers are binders, which is a
      // question about the printed program's grammar. Print once to ask
      // TypeScript, then print again with the hygienic names applied.
      const aliased = printWith(rewrites);
      const hygiene = planHygienicRenames({
        syntax: printableSyntax,
        scopes,
        phase,
        text: aliased.text,
        tokenSpans: aliased.tokenSpans,
        fileName: file.kind.virtualFileName,
        reservedNames: rewrites.map(({ printedName }) => printedName),
      });
      const aliasedSyntax = new Set(rewrites.map(({ syntax }) => syntax));
      const hygieneRewrites = (hygiene?.rewrites ?? []).filter(
        (rewrite) =>
          !aliasedSyntax.has(rewrite.syntax) &&
          rewrite.replacement !== rawSpelling.get(rewrite.syntax),
      );
      const generated =
        hygieneRewrites.length === 0
          ? aliased
          : printWith([...rewrites, ...hygieneRewrites]);
      const macroNames = new Map(
        modules.flatMap(({ macros }) =>
          macros.map(({ binding }) => [binding.id, binding.spelling] as const),
        ),
      );
      const output = { fileName: file.kind.virtualFileName, generated };
      virtualFiles.push(output);
      // `explain` reports the name each renamed template binding printed under.
      const generatedNames = Object.fromEntries(
        hygieneRewrites.map(({ syntax, printedName }) => [
          rawSpelling.get(syntax) ?? printedName,
          printedName,
        ]),
      );
      let expansionSourceMap: RawSourceMap | undefined;
      const macroModules = [...macroSourcesFor(file.fileName)]
        .map((sourceId) => bySource.get(sourceId)!)
        .filter((module) => module !== file);
      this.#inspections.set(
        resolve(file.fileName),
        Object.freeze({
          sourceId: file.sourceId,
          sourceText: file.sourceText,
          virtualFileName: file.kind.virtualFileName,
          generated,
          origins,
          // Everything raised expanding this file and against this file, so
          // an inspection can say that what it holds is unexpanded rather
          // than presenting it as output -- and what is wrong with the macro
          // modules it reads its macros from, which stops those macros
          // running and leaves this file expanding into itself. Reporting
          // only the first would have `expand` print the unexpanded source and
          // report success whenever the fault is in the macros rather than in
          // their use. Only a module's errors stop its macros; anything else
          // it says is its own to report.
          diagnostics: Object.freeze(
            [
              ...answerableFor(file),
              ...macroModules.flatMap((module) =>
                answerableFor(module).filter(
                  ({ severity }) => severity === "error",
                ),
              ),
              ...held,
            ].map((diagnostic) => asTypeScriptDiagnostic(diagnostic, bySource)),
          ),
          inputs: inputsFor([file, ...macroModules]),
          // What is held about a name this file left standing. `expand` and a
          // build tool's transform read an inspection and then stop; there is
          // no checker behind either, so this is the last chance anything has
          // to say the name is a macro's.
          warnings: warnAboutHeldNames(
            result.unresolvedNameExplanations
              .filter(
                ({ primaryOrigin }) => primaryOrigin.sourceId === file.sourceId,
              )
              .map((diagnostic) =>
                Object.freeze({
                  name: String(diagnostic.messageArguments[0] ?? ""),
                  diagnostic: asTypeScriptDiagnostic(diagnostic, bySource),
                }),
              ),
          ),
          generatedNames: Object.freeze(generatedNames),
          // Building a source map walks every printed region. Only the
          // build-tool transforms ask for one; `check` never does, so it is
          // built when it is first read and remembered after that.
          get sourceMap(): RawSourceMap {
            expansionSourceMap ??= createExpansionSourceMap({
              file: file.kind.virtualFileName,
              generated,
              index: createLazyOriginQueryIndex({
                file: generated,
                origins,
                expansionStack: () => [],
              }),
              sourceName: (sourceId) =>
                bySource.get(sourceId)?.fileName ??
                `source-${String(sourceId)}`,
              sourceText: (sourceId) => bySource.get(sourceId)?.sourceText,
            });
            return expansionSourceMap;
          },
          index: createLazyOriginQueryIndex({
            file: generated,
            origins,
            expansionStack: (origin) =>
              result.traces.flatMap((trace) =>
                trace.outputOrigins.some(
                  (output) =>
                    originContains(origins, origin, output) ||
                    originContains(origins, output, origin),
                )
                  ? [
                      {
                        invocationId: trace.invocationId,
                        macroName:
                          macroNames.get(trace.binding) ??
                          `binding-${String(trace.binding)}`,
                        origin: (() => {
                          const selected = origins.selectPrimarySource(
                            trace.invocationOrigin,
                          );
                          return {
                            sourceId: selected?.sourceId ?? file.sourceId,
                            start: selected?.span.start ?? 0,
                            end: selected?.span.end ?? 0,
                            originId: trace.invocationOrigin,
                          };
                        })(),
                      },
                    ]
                  : [],
              ),
          }),
          trace: result.traces,
        }),
      );
      return { kind: "settled", settled: undefined } as const;
    };
    /**
     * Whether `file` can be read again and expanded again on its own: it
     * defines no macro and no file reads macros from it, so nothing but its
     * own expansion was made from what it read.
     */
    let readFrom: ReadonlySet<SourceId> | undefined;
    const readAlone = (file: ParsedFile): boolean => {
      if (file.parsed.definitions.length !== 0) return false;
      readFrom ??= new Set(
        [...macroSources.values()].flatMap((sources) => [...sources]),
      );
      return !readFrom.has(file.sourceId);
    };
    /**
     * `file` read again with `slashReadings`, in its place in the project;
     * undefined where the read reads the file's macros or its imports for
     * syntax differently, which only reading the whole project again serves.
     */
    const readAgain = (
      file: ParsedFile,
      slashReadings: SlashReadings,
    ): ParsedFile | undefined => {
      const again = readFile(
        file.fileName,
        file.kind,
        file.sourceId,
        file.sourceText,
        file.root.scopes,
        slashReadings,
      );
      if (
        again.parsed.definitions.length > 0 ||
        compileTimeImportsKey(again) !== compileTimeImportsKey(file)
      )
        return undefined;
      // What the earlier read reported was reported about tokens no longer
      // read.
      const stale = new Set(file.diagnostics);
      const kept = diagnostics.filter((diagnostic) => !stale.has(diagnostic));
      diagnostics.length = 0;
      diagnostics.push(...kept, ...again.diagnostics);
      byPath.set(again.fileName, again);
      bySource.set(again.sourceId, again);
      visibilityByModule.set(again.compiled, new Map());
      visibilitySourceByModule.set(again.compiled, again.sourceId);
      return again;
    };
    /** The readings each file ends this pass read with. */
    const passReadings = new Map(readings);
    /** Whether a file asked to be read again with the whole project. */
    let rereadProject = false;
    for (const projectFile of projectFiles) {
      let file = projectFile;
      settleSlashReadings<undefined, SlashReadings>(
        file.slashReadings,
        askedReadings,
        (slashReadings, last, fileReads) => {
          const alone = readAlone(file);
          if (slashReadings !== file.slashReadings) {
            const again = alone ? readAgain(file, slashReadings) : undefined;
            if (again === undefined) {
              // On the project's last read the file settles as it was read,
              // and says what it still found.
              if (final) return expandFile(file, true, projectReads);
              passReadings.set(file.fileName, slashReadings);
              rereadProject = true;
              return { kind: "settled", settled: undefined };
            }
            passReadings.set(file.fileName, again.slashReadings);
            file = again;
          }
          return alone
            ? expandFile(file, last, fileReads)
            : expandFile(file, final, projectReads);
        },
      );
    }
    if (rereadProject) return { kind: "reread", readings: passReadings };
    this.#debug = Object.freeze({
      files: virtualFiles.length,
      modules: moduleSources.filter(
        ({ manifest }) => Object.keys(manifest.exports).length > 0,
      ).length,
      invocations: invocationCount,
    });
    this.#lastInputs = { configPath: project.configPath, inputs };
    const output: DefaultProjectExpansionOutput = Object.freeze({
      files: Object.freeze(virtualFiles),
      diagnostics: Object.freeze(
        diagnostics.map((diagnostic) =>
          asTypeScriptDiagnostic(diagnostic, bySource),
        ),
      ),
      inputs,
      resolvesBindingLiterals,
      unresolvedNameExplanations: Object.freeze(
        unresolvedNameExplanations.map((diagnostic) =>
          // The name travels with the sentence. Every name one macro writes is
          // reported against the invocation that wrote it, so the position
          // alone cannot tell two of these apart; the spelling is the first
          // thing each of these three diagnostics is given.
          Object.freeze({
            name: String(diagnostic.messageArguments[0] ?? ""),
            diagnostic: asTypeScriptDiagnostic(diagnostic, bySource),
          }),
        ),
      ),
    });
    return { kind: "settled", settled: output };
  }

  /**
   * What the last expansion to finish asked of the file system, if it was of
   * `project`; nothing if it was of another project, or none has finished.
   */
  expansionInputs(project: LoadedSweetProject): readonly ExpansionInput[] {
    return this.#lastInputs?.configPath === project.configPath
      ? this.#lastInputs.inputs
      : Object.freeze([]);
  }

  debugState(): unknown {
    return this.#debug;
  }

  inspectSource(
    fileName: string,
  ): DefaultSourceExpansionInspection | undefined {
    return this.#inspections.get(resolve(fileName));
  }

  prepareSource(
    fileName: string,
  ): DefaultSourceExpansionInspection | undefined {
    const absolute = resolve(fileName);
    let directory = dirname(absolute);
    const root = parse(directory).root;
    while (true) {
      const configPath = resolve(directory, "tsconfig.json");
      if (existsSync(configPath)) {
        this.expandProject(loadSweetProject(configPath));
        const inspected = this.inspectSource(absolute);
        // The file may sit outside the project the config describes; fall
        // through to a standalone expansion rather than reporting nothing.
        if (inspected !== undefined) return inspected;
        break;
      }
      if (directory === root) break;
      directory = dirname(directory);
    }
    if (!existsSync(absolute)) return undefined;
    this.expandProject(loadStandaloneProject([absolute]));
    return this.inspectSource(absolute);
  }
}

export function createDefaultProjectExpansionProvider(
  options: {
    readonly system?: ts.System | undefined;
  } = {},
): DefaultProjectExpansionProvider {
  return new DefaultProjectExpansionProvider(options);
}
