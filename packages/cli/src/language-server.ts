import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createDefaultProjectExpansionProvider,
  loadStandaloneProject,
  loadSweetProject,
  selectSweetSources,
  type DefaultProjectExpansionProvider,
  type LoadedSweetProject,
  type SourceExpansionInspection,
} from "@sweetener/compiler";
import type { OriginId, SourceId } from "@sweetener/shared";
import {
  MappedLanguageService,
  VirtualLanguageServiceProject,
  type MappedDocumentSymbol,
} from "@sweetener/typescript-host";
import ts from "typescript";

/**
 * Methods this server answers. Formatting, semantic tokens, and the other
 * language-service features the origin map does not edit safely are absent.
 */
export const advertisedLanguageServerMethods = Object.freeze([
  "initialize",
  "textDocument/didOpen",
  "textDocument/didChange",
  "textDocument/didClose",
  "textDocument/diagnostic",
  "textDocument/hover",
  "textDocument/definition",
  "textDocument/references",
  "textDocument/completion",
  "textDocument/prepareRename",
  "textDocument/rename",
  "shutdown",
]);

export const unimplementedLanguageServerMethods = Object.freeze([
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/semanticTokens",
  "textDocument/semanticTokens/full",
  "textDocument/inlayHint",
  "textDocument/codeLens",
  "textDocument/prepareCallHierarchy",
  "textDocument/codeAction",
]);

export const languageServerCapabilities = Object.freeze({
  textDocumentSync: Object.freeze({ openClose: true, change: 2 }),
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  completionProvider: Object.freeze({
    triggerCharacters: Object.freeze([".", '"', "'", "<"]),
    resolveProvider: true,
  }),
  signatureHelpProvider: Object.freeze({
    triggerCharacters: Object.freeze(["(", ","]),
    retriggerCharacters: Object.freeze([","]),
  }),
  typeDefinitionProvider: true,
  implementationProvider: true,
  documentHighlightProvider: true,
  documentSymbolProvider: true,
  renameProvider: Object.freeze({ prepareProvider: true }),
  diagnosticProvider: Object.freeze({
    interFileDependencies: true,
    workspaceDiagnostics: false,
  }),
});

interface LspPosition {
  readonly line: number;
  readonly character: number;
}

interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface OpenDocument {
  uri: string;
  path: string;
  text: string;
  version: number;
}

class RequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "RequestError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return undefined;
}

function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10) starts.push(index + 1);
    else if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionAt(starts: readonly number[], offset: number): LspPosition {
  let line = 0;
  while (line + 1 < starts.length && (starts[line + 1] ?? 0) <= offset)
    line += 1;
  return Object.freeze({
    line,
    character: offset - (starts[line] ?? 0),
  });
}

function offsetAt(
  text: string,
  starts: readonly number[],
  position: LspPosition,
): number {
  if (position.line < 0) return 0;
  if (position.line >= starts.length) return text.length;
  const start = starts[position.line] ?? 0;
  const next = starts[position.line + 1];
  let limit = next === undefined ? text.length : next;
  if (limit > start && text.charCodeAt(limit - 1) === 10) limit -= 1;
  if (limit > start && text.charCodeAt(limit - 1) === 13) limit -= 1;
  return Math.min(start + Math.max(0, position.character), limit);
}

function rangeFor(
  text: string,
  start: number,
  end: number,
): LspRange | undefined {
  if (start < 0 || end < start || end > text.length) return undefined;
  const starts = lineStarts(text);
  return Object.freeze({
    start: positionAt(starts, start),
    end: positionAt(starts, end),
  });
}

function documentUri(params: unknown): string {
  const uri = record(record(params)?.["textDocument"])?.["uri"];
  if (typeof uri !== "string" || !uri.startsWith("file:"))
    throw new RequestError(-32602, "textDocument.uri must be a file URI");
  return uri;
}

function includeDeclarationParam(params: unknown): boolean {
  const value = record(record(params)?.["context"])?.["includeDeclaration"];
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new RequestError(-32602, "includeDeclaration must be a boolean");
  return value;
}

function positionParam(params: unknown): LspPosition {
  const position = record(record(params)?.["position"]);
  const line = position?.["line"];
  const character = position?.["character"];
  if (
    typeof line !== "number" ||
    typeof character !== "number" ||
    !Number.isInteger(line) ||
    !Number.isInteger(character)
  )
    throw new RequestError(
      -32602,
      "position must have an integer line and character",
    );
  return Object.freeze({ line, character });
}

function hoverPrefersMarkdown(params: unknown): boolean {
  const formats = record(
    record(record(record(params)?.["capabilities"])?.["textDocument"])?.[
      "hover"
    ],
  )?.["contentFormat"];
  if (!Array.isArray(formats) || formats.length === 0) return true;
  return formats[0] === "markdown";
}

function hoverLanguage(fileName: string): string {
  return fileName.endsWith(".tsx") ||
    fileName.endsWith(".stsx") ||
    fileName.endsWith(".jsx")
    ? "tsx"
    : "typescript";
}

function fence(language: string, code: string): string {
  return (
    "```" + language + "\n" + code.replaceAll("```", "``\u200b`") + "\n```"
  );
}

function formatTag(tag: ts.JSDocTagInfo): string {
  const parts = tag.text ?? [];
  const name = parts.find((part) => part.kind === "parameterName")?.text;
  const body = ts
    .displayPartsToString(parts.filter((part) => part.kind !== "parameterName"))
    .trim();
  if ((tag.name === "param" || tag.name === "template") && name !== undefined)
    return body.length === 0
      ? `*@${tag.name}* \`${name}\``
      : `*@${tag.name}* \`${name}\` — ${body}`;
  return body.length === 0 ? `*@${tag.name}*` : `*@${tag.name}* — ${body}`;
}

function wordAt(text: string, offset: number): string {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9_$]/u.test(text[start - 1] ?? "")) start -= 1;
  while (end < text.length && /[A-Za-z0-9_$]/u.test(text[end] ?? "")) end += 1;
  return text.slice(start, end);
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The nearest project that already lists this file. A config that does not
 * list it is not used, so climbing into a larger TypeScript project is avoided.
 */
function projectListing(fileName: string): LoadedSweetProject {
  let directory = dirname(fileName);
  const root = parse(directory).root;
  while (true) {
    for (const name of ["sweetener.json", "tsconfig.json"]) {
      const configPath = resolve(directory, name);
      if (!existsSync(configPath)) continue;
      const project = loadSweetProject(configPath);
      if (
        project.typescript.fileNames.some(
          (listed) => resolve(listed) === fileName,
        )
      )
        return project;
      return loadStandaloneProject([fileName]);
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return loadStandaloneProject([fileName]);
}

function diskText(fileName: string): string | undefined {
  if (!existsSync(fileName)) return undefined;
  return readFileSync(fileName, "utf8");
}

function configIn(directory: string): string {
  const sweetener = resolve(directory, "sweetener.json");
  if (existsSync(sweetener)) return sweetener;
  const tsconfig = resolve(directory, "tsconfig.json");
  if (existsSync(tsconfig)) return tsconfig;
  throw new Error(`No sweetener.json or tsconfig.json in ${directory}`);
}

/**
 * `--project` matches the other commands: a config file, or a directory that
 * contains one. A directory prefers `sweetener.json` over `tsconfig.json`.
 * A file is that file, so a `tsconfig.json` next to `sweetener.json` stays
 * the file the user named.
 */
export function languageServerConfigPath(project: string): string {
  const resolved = resolve(project);
  if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  return configIn(resolved);
}

function invocationHead(
  inspected: SourceExpansionInspection,
  offset: number,
):
  | {
      readonly binding: number;
      readonly invocationId: number;
      readonly start: number;
      readonly end: number;
    }
  | undefined {
  const events = Array.isArray(inspected.trace) ? inspected.trace : [];
  let best:
    | {
        readonly binding: number;
        readonly invocationId: number;
        readonly start: number;
        readonly end: number;
      }
    | undefined;
  for (const event of events) {
    if (!record(event) || typeof event["invocationOrigin"] !== "number")
      continue;
    if (typeof event["binding"] !== "number") continue;
    if (typeof event["invocationId"] !== "number") continue;
    const source = inspected.origins.selectPrimarySource(
      event["invocationOrigin"] as OriginId,
    );
    if (source.sourceId !== inspected.sourceId) continue;
    if (offset < source.span.start || offset >= source.span.end) continue;
    if (
      best !== undefined &&
      source.span.end - source.span.start >= best.end - best.start
    )
      continue;
    best = {
      binding: event["binding"],
      invocationId: event["invocationId"],
      start: source.span.start,
      end: source.span.end,
    };
  }
  return best;
}

function expandedCall(
  inspected: SourceExpansionInspection,
  invocationId: number,
): string {
  const parts = inspected.index
    .regions()
    .filter((region) =>
      region.expansionStack.some(
        (frame) => Number(frame.invocationId) === invocationId,
      ),
    )
    .sort((left, right) => left.generatedStart - right.generatedStart);
  let text = "";
  let cursor = -1;
  for (const part of parts) {
    if (part.generatedStart < cursor) continue;
    text += inspected.generated.text.slice(
      part.generatedStart,
      part.generatedEnd,
    );
    cursor = part.generatedEnd;
  }
  return text.trim();
}

function nameSpan(
  text: string,
  start: number,
  end: number,
  name: string,
): { readonly start: number; readonly end: number } {
  const inside = text.slice(start, end).indexOf(name);
  if (inside >= 0)
    return { start: start + inside, end: start + inside + name.length };
  // A syntax definition's recorded origin is the `syntax` keyword. The name
  // is the next word.
  const lookAhead = text.slice(
    start,
    Math.min(text.length, end + name.length + 32),
  );
  const at = lookAhead.indexOf(name);
  if (at < 0) return { start, end };
  const begin = start + at;
  const before = text[begin - 1] ?? "";
  const after = text[begin + name.length] ?? "";
  if (/[A-Za-z0-9_$]/u.test(before) || /[A-Za-z0-9_$]/u.test(after))
    return { start, end };
  return { start: begin, end: begin + name.length };
}

function severity(category: ts.DiagnosticCategory): 1 | 2 | 3 | 4 {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return 1;
    case ts.DiagnosticCategory.Warning:
      return 2;
    case ts.DiagnosticCategory.Suggestion:
      return 4;
    default:
      return 3;
  }
}

const completionKinds: Readonly<Record<string, number>> = Object.freeze({
  const: 21,
  let: 6,
  var: 6,
  "local variable": 6,
  variable: 6,
  function: 3,
  "local function": 3,
  method: 2,
  "member function": 2,
  constructor: 4,
  property: 10,
  "member variable": 5,
  "member get accessor": 10,
  "member set accessor": 10,
  class: 7,
  "local class": 7,
  interface: 8,
  type: 7,
  enum: 13,
  "enum member": 20,
  keyword: 14,
  module: 9,
  "external module name": 9,
  alias: 6,
  parameter: 6,
  "type parameter": 25,
  "primitive type": 7,
  string: 14,
});

/**
 * One open Sweetener project. Expansion reads editor buffers through
 * `readSource`; position answers come from `MappedLanguageService`.
 */
export class LanguageServerSession {
  readonly #directory: string;
  readonly #provider: DefaultProjectExpansionProvider;
  readonly #documents = new Map<string, OpenDocument>();
  readonly #inspections = new Map<string, SourceExpansionInspection>();
  readonly #answers = new Map<string, unknown>();
  readonly #outgoing: object[] = [];
  readonly #contentStamps = new Map<
    string,
    { readonly mtimeMs: number; readonly size: number; readonly hash: string }
  >();
  #loaded: LoadedSweetProject;
  #virtual: VirtualLanguageServiceProject | undefined;
  #service: MappedLanguageService | undefined;
  #epoch = 0;
  #shutdown = false;
  #expansionDependencies: readonly string[] = [];
  #fingerprint = "";
  /** Editors highlight a markdown fence; plaintext is only used when requested. */
  #hoverMarkdown = true;
  #outside:
    | {
        readonly service: MappedLanguageService;
        readonly virtual: VirtualLanguageServiceProject;
        readonly inspections: Map<string, SourceExpansionInspection>;
      }
    | undefined;
  /**
   * Projects reached by opening a file the workspace config does not list.
   * Kept by content hash so a click does not expand language-tour again.
   */
  readonly #extraProjects = new Map<
    string,
    {
      fingerprint: string;
      readonly paths: readonly string[];
      readonly service: MappedLanguageService;
      readonly virtual: VirtualLanguageServiceProject;
      readonly inspections: Map<string, SourceExpansionInspection>;
    }
  >();

  constructor(projectDirectory: string) {
    const configPath = languageServerConfigPath(projectDirectory);
    this.#directory = dirname(configPath);
    this.#loaded = loadSweetProject(configPath);
    this.#provider = createDefaultProjectExpansionProvider({
      readSource: (fileName) => this.#documents.get(resolve(fileName))?.text,
    });
    // Expand once before the editor asks. A later request reuses that
    // expansion when the content hash of its inputs is unchanged.
    this.#ensure();
  }

  get directory(): string {
    return this.#directory;
  }

  takeOutgoing(): readonly object[] {
    const notes = [...this.#outgoing];
    this.#outgoing.length = 0;
    return notes;
  }

  dispose(): void {
    this.#shutdown = true;
    this.#virtual?.dispose();
    this.#virtual = undefined;
    this.#service = undefined;
    for (const extra of this.#extraProjects.values()) extra.virtual.dispose();
    this.#extraProjects.clear();
  }

  /**
   * The result of one LSP call, already mapped back to source positions.
   * Notifications update the session and have no result.
   */
  answer(
    method: string,
    params: unknown,
  ):
    | { readonly kind: "result"; readonly result: unknown }
    | { readonly kind: "notification" }
    | {
        readonly kind: "error";
        readonly code: number;
        readonly message: string;
      } {
    try {
      if (this.#shutdown && method !== "exit")
        return Object.freeze({
          kind: "error",
          code: -32600,
          message: "server is shutting down",
        });
      switch (method) {
        case "initialize":
          this.#hoverMarkdown = hoverPrefersMarkdown(params);
          return Object.freeze({
            kind: "result",
            result: Object.freeze({
              capabilities: languageServerCapabilities,
              serverInfo: Object.freeze({ name: "sweetener-lsp" }),
            }),
          });
        case "initialized":
        case "exit":
          return Object.freeze({ kind: "notification" });
        case "shutdown":
          this.#shutdown = true;
          this.dispose();
          return Object.freeze({ kind: "result", result: null });
        case "textDocument/didOpen":
          this.#open(params);
          return Object.freeze({ kind: "notification" });
        case "textDocument/didChange":
          this.#change(params);
          return Object.freeze({ kind: "notification" });
        case "textDocument/didClose":
          this.#close(params);
          return Object.freeze({ kind: "notification" });
        case "textDocument/diagnostic": {
          const uri = documentUri(params);
          const path = resolve(fileURLToPath(uri));
          const run = () => this.#diagnostics(uri);
          return Object.freeze({
            kind: "result",
            result: this.#inspections.has(path)
              ? this.#cached(`diagnostic\0${uri}`, run)
              : this.#once(path, run),
          });
        }
        case "textDocument/hover":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#hover(path, offset),
            ),
          });
        case "textDocument/definition":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#definitions(path, offset),
            ),
          });
        case "textDocument/typeDefinition":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#located(this.#boundService().typeDefinitions(path, offset)),
            ),
          });
        case "textDocument/implementation":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#located(this.#boundService().implementations(path, offset)),
            ),
          });
        case "textDocument/signatureHelp":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#signatureHelp(path, offset),
            ),
          });
        case "textDocument/documentHighlight":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#highlights(path, offset),
            ),
          });
        case "textDocument/documentSymbol": {
          const uri = documentUri(params);
          const path = resolve(fileURLToPath(uri));
          const run = () => this.#symbols(path);
          return Object.freeze({
            kind: "result",
            result: this.#inspections.has(path)
              ? this.#cached(`symbols\0${uri}`, run)
              : this.#once(path, run),
          });
        }
        case "completionItem/resolve":
          return Object.freeze({
            kind: "result",
            result: this.#resolveCompletion(params),
          });
        case "textDocument/references": {
          const includeDeclaration = includeDeclarationParam(params);
          return Object.freeze({
            kind: "result",
            result: this.#at(
              `${method}\0${includeDeclaration ? "1" : "0"}`,
              params,
              (path, offset) =>
                this.#references(path, offset, includeDeclaration),
            ),
          });
        }
        case "textDocument/completion":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#completions(path, offset),
            ),
          });
        case "textDocument/prepareRename":
          return Object.freeze({
            kind: "result",
            result: this.#at(method, params, (path, offset) =>
              this.#prepareRename(path, offset),
            ),
          });
        case "textDocument/rename": {
          const name = record(params)?.["newName"];
          if (typeof name !== "string")
            throw new RequestError(-32602, "newName must be a string");
          return Object.freeze({
            kind: "result",
            result: this.#at(`${method}\0${name}`, params, (path, offset) =>
              this.#rename(path, offset, name),
            ),
          });
        }
        default:
          if (advertisedLanguageServerMethods.includes(method))
            return Object.freeze({
              kind: "error",
              code: -32603,
              message: `${method} is not wired`,
            });
          return Object.freeze({
            kind: "error",
            code: -32601,
            message: `Method not found: ${method}`,
          });
      }
    } catch (error) {
      const code = error instanceof RequestError ? error.code : -32603;
      const message = error instanceof Error ? error.message : String(error);
      return Object.freeze({ kind: "error", code, message });
    }
  }

  #cached<T>(key: string, compute: () => T): T {
    // The content hash can change between requests without a document
    // notification. Check it before the answer cache, so a stale hover is
    // not served after a macro file changes on disk.
    this.#ensure();
    const stored = `${String(this.#epoch)}\0${key}`;
    if (this.#answers.has(stored)) return this.#answers.get(stored) as T;
    const value = compute();
    this.#answers.set(stored, value);
    return value;
  }

  #at(
    method: string,
    params: unknown,
    compute: (path: string, offset: number) => unknown,
  ): unknown {
    const uri = documentUri(params);
    const position = positionParam(params);
    const path = resolve(fileURLToPath(uri));
    const run = () => {
      const document = this.#require(uri);
      const offset = offsetAt(
        document.text,
        lineStarts(document.text),
        position,
      );
      return compute(document.path, offset);
    };
    // A file the configured project does not list is expanded for this
    // request and discarded. It is not part of the cached project.
    if (!this.#inspections.has(path)) return this.#once(path, run);
    return this.#cached(
      `${method}\0${uri}\0${String(position.line)}\0${String(position.character)}`,
      run,
    );
  }

  #boundService(): MappedLanguageService {
    return this.#outside?.service ?? this.#ensure();
  }

  #boundInspections(): ReadonlyMap<string, SourceExpansionInspection> {
    return this.#outside?.inspections ?? this.#inspections;
  }

  /**
   * Expand a file the configured project did not list, answer from that
   * expansion, and drop it. The nearest config that already lists the file
   * is used so its macro imports resolve; otherwise the file is expanded alone.
   */
  #once<T>(path: string, compute: () => T): T {
    const provider = createDefaultProjectExpansionProvider({
      readSource: (fileName) => this.#documents.get(resolve(fileName))?.text,
    });
    let project = projectListing(path);
    const key = resolve(project.configPath);
    const cached = this.#extraProjects.get(key);
    if (
      cached !== undefined &&
      cached.inspections.has(path) &&
      cached.fingerprint === this.#computeFingerprint(cached.paths)
    ) {
      this.#outside = cached;
      try {
        return compute();
      } finally {
        this.#outside = undefined;
      }
    }
    cached?.virtual.dispose();
    let expanded = provider.expandProject(project);
    if (provider.inspectSource(path) === undefined) {
      project = loadStandaloneProject([path]);
      expanded = provider.expandProject(project);
    }
    const mounted = this.#materialize(project, provider, expanded);
    const paths = [
      ...new Set(
        [
          ...(project.configurationDependencies ?? [project.configPath]),
          ...project.typescript.fileNames,
          ...provider.macroDependencies(project),
          ...(expanded.dependencies ?? []),
        ].map((fileName) => resolve(fileName)),
      ),
    ];
    const slot = {
      fingerprint: this.#computeFingerprint(paths),
      paths,
      service: mounted.service,
      virtual: mounted.virtual,
      inspections: mounted.inspections,
    };
    this.#extraProjects.set(key, slot);
    if (this.#extraProjects.size > 2) {
      const oldest = this.#extraProjects.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        this.#extraProjects.get(oldest)?.virtual.dispose();
        this.#extraProjects.delete(oldest);
      }
    }
    this.#outside = slot;
    try {
      return compute();
    } finally {
      this.#outside = undefined;
    }
  }

  #bump(): void {
    this.#epoch += 1;
    this.#answers.clear();
  }

  #open(params: unknown): void {
    const uri = documentUri(params);
    const textDocument = record(record(params)?.["textDocument"]);
    const text = textDocument?.["text"];
    const version = textDocument?.["version"];
    if (typeof text !== "string")
      throw new RequestError(-32602, "didOpen requires text");
    const path = resolve(fileURLToPath(uri));
    this.#documents.set(
      path,
      Object.freeze({
        uri,
        path,
        text,
        version: typeof version === "number" ? version : 0,
      }),
    );
    // Opening the text already expanded at startup must not throw that work
    // away. A buffer that differs from disk is a new input.
    if (diskText(path) !== text) this.#bump();
    this.#publish(uri);
  }

  #change(params: unknown): void {
    const uri = documentUri(params);
    const document = this.#require(uri);
    const changes = record(params)?.["contentChanges"];
    if (!Array.isArray(changes))
      throw new RequestError(-32602, "didChange requires contentChanges");
    let text = document.text;
    for (const change of changes) {
      const body = record(change);
      const next = body?.["text"];
      if (typeof next !== "string")
        throw new RequestError(-32602, "a content change needs text");
      const range = record(body?.["range"]);
      if (range === undefined) {
        text = next;
        continue;
      }
      const start = positionParam({ position: range["start"] });
      const end = positionParam({ position: range["end"] });
      const starts = lineStarts(text);
      const from = offsetAt(text, starts, start);
      const to = offsetAt(text, starts, end);
      text = text.slice(0, from) + next + text.slice(to);
    }
    const version = record(record(params)?.["textDocument"])?.["version"];
    this.#documents.set(
      document.path,
      Object.freeze({
        ...document,
        text,
        version: typeof version === "number" ? version : document.version + 1,
      }),
    );
    if (text !== document.text) this.#bump();
    this.#publish(document.uri);
  }

  #close(params: unknown): void {
    const path = resolve(fileURLToPath(documentUri(params)));
    const document = this.#documents.get(path);
    this.#documents.delete(path);
    if (document !== undefined && diskText(path) !== document.text)
      this.#bump();
  }

  #require(uri: string): OpenDocument {
    const document = this.#documents.get(resolve(fileURLToPath(uri)));
    if (document === undefined)
      throw new RequestError(-32602, `document is not open: ${uri}`);
    return document;
  }

  #text(path: string): string {
    return (
      this.#boundInspections().get(resolve(path))?.sourceText ??
      this.#documents.get(resolve(path))?.text ??
      readFileSync(path, "utf8")
    );
  }

  #uri(path: string): string {
    return (
      this.#documents.get(resolve(path))?.uri ??
      pathToFileURL(resolve(path)).href
    );
  }

  #ensure(): MappedLanguageService {
    if (
      this.#service !== undefined &&
      this.#fingerprint === this.#computeFingerprint()
    )
      return this.#service;
    this.#loaded = loadSweetProject(this.#loaded.configPath);
    this.#bump();
    const expanded = this.#provider.expandProject(this.#loaded);
    const mounted = this.#materialize(this.#loaded, this.#provider, expanded);
    this.#virtual?.dispose();
    this.#virtual = mounted.virtual;
    this.#service = mounted.service;
    this.#inspections.clear();
    for (const [path, inspected] of mounted.inspections)
      this.#inspections.set(path, inspected);
    this.#expansionDependencies = expanded.dependencies ?? [];
    this.#fingerprint = this.#computeFingerprint();
    return mounted.service;
  }

  #materialize(
    project: LoadedSweetProject,
    provider: DefaultProjectExpansionProvider,
    expanded: ReturnType<DefaultProjectExpansionProvider["expandProject"]>,
  ): {
    readonly service: MappedLanguageService;
    readonly virtual: VirtualLanguageServiceProject;
    readonly inspections: Map<string, SourceExpansionInspection>;
  } {
    const sweet = selectSweetSources({
      fileNames: project.typescript.fileNames,
      macroExtensions: project.sweet.macroExtensions,
    });
    const sweetPaths = new Set(sweet.map(({ fileName }) => resolve(fileName)));
    const inspections = new Map<string, SourceExpansionInspection>();
    const mappings = [];
    for (const source of sweet) {
      const inspected = provider.inspectSource(source.fileName);
      if (inspected === undefined) continue;
      const path = resolve(source.fileName);
      inspections.set(path, inspected);
      mappings.push(
        Object.freeze({
          sourceFileName: path,
          sourceId: inspected.sourceId,
          virtualFileName: source.kind.virtualFileName,
          printed: inspected.generated,
          index: inspected.index,
          origins: inspected.origins,
        }),
      );
    }
    const virtual = new VirtualLanguageServiceProject({
      compilerOptions: {
        moduleDetection: ts.ModuleDetectionKind.Force,
        ...project.typescript.options,
        noEmit: true,
      },
      currentDirectory: dirname(project.configPath),
      files: expanded.files.map(({ fileName, generated }) =>
        Object.freeze({ fileName, generated }),
      ),
      additionalRootNames: project.typescript.fileNames.filter(
        (fileName) => !sweetPaths.has(resolve(fileName)),
      ),
    });
    return {
      service: new MappedLanguageService(virtual, mappings),
      virtual,
      inspections,
    };
  }

  /**
   * The same inputs the compiler session reuses: the config and its `extends`
   * chain, the project sources, and the macro modules and package manifests
   * the expansion actually read. An open buffer is hashed from memory.
   */
  #dependencyPaths(): readonly string[] {
    const expanded = this.#provider.macroDependencies(this.#loaded);
    return [
      ...new Set(
        [
          ...(this.#loaded.configurationDependencies ?? [
            this.#loaded.configPath,
          ]),
          ...this.#loaded.typescript.fileNames,
          ...expanded,
          ...this.#expansionDependencies,
        ].map((fileName) => resolve(fileName)),
      ),
    ];
  }

  #fileDigest(fileName: string): string {
    const open = this.#documents.get(fileName);
    if (open !== undefined) return contentHash(open.text);
    let stamp: { readonly mtimeMs: number; readonly size: number } | undefined;
    try {
      const stat = statSync(fileName);
      stamp = { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return "<missing>";
    }
    const previous = this.#contentStamps.get(fileName);
    if (
      previous !== undefined &&
      previous.mtimeMs === stamp.mtimeMs &&
      previous.size === stamp.size
    )
      return previous.hash;
    const hash = contentHash(readFileSync(fileName, "utf8"));
    this.#contentStamps.set(fileName, { ...stamp, hash });
    return hash;
  }

  #computeFingerprint(
    paths: readonly string[] = this.#dependencyPaths(),
  ): string {
    const ordered = [...paths].sort();
    const hash = createHash("sha256");
    for (const fileName of ordered) {
      hash.update(fileName);
      hash.update("\0");
      hash.update(this.#fileDigest(fileName));
      hash.update("\0");
    }
    // Names of Sweetener files in those directories. A new `.sts` shows up
    // here. An unrelated file does not change the hash, so it does not
    // rebuild the project.
    const directories = [
      ...new Set(ordered.map((fileName) => dirname(fileName))),
    ].sort();
    for (const directory of directories) {
      let names: string;
      try {
        names = readdirSync(directory)
          .filter(
            (name) =>
              name.endsWith(".sts") ||
              name.endsWith(".stsx") ||
              name.endsWith(".json"),
          )
          .sort()
          .join("\n");
      } catch {
        names = "<missing>";
      }
      hash.update(directory);
      hash.update("\0");
      hash.update(names);
      hash.update("\0");
    }
    return hash.digest("hex");
  }

  #diagnostics(uri: string): {
    readonly kind: "full";
    readonly items: readonly {
      readonly range: LspRange;
      readonly message: string;
      readonly severity: 1 | 2 | 3 | 4;
      readonly source: string;
      readonly code: number | string;
      readonly tags?: readonly number[];
      readonly relatedInformation?: readonly {
        readonly location: { readonly uri: string; readonly range: LspRange };
        readonly message: string;
      }[];
    }[];
  } {
    const document = this.#require(uri);
    const service = this.#boundService();
    const inspected = this.#boundInspections().get(document.path);
    const text = this.#text(document.path);
    const items = [];
    if (inspected !== undefined) {
      for (const diagnostic of service.diagnostics(document.path)) {
        const origin = diagnostic.primaryOrigin;
        if (origin === undefined || origin.sourceId !== inspected.sourceId)
          continue;
        const range = rangeFor(text, origin.start, origin.end);
        if (range === undefined) continue;
        const related = [];
        for (const info of diagnostic.relatedOrigins) {
          const path = this.#pathForSource(info.origin.sourceId);
          const location = this.#location(
            path,
            info.origin.start,
            info.origin.end,
          );
          if (location === undefined) continue;
          related.push(Object.freeze({ location, message: info.message }));
        }
        items.push(
          Object.freeze({
            range,
            message: diagnostic.messageText,
            severity: severity(diagnostic.category),
            source: "typescript",
            code: diagnostic.typescriptCode,
            ...(diagnostic.tags.length === 0 ? {} : { tags: diagnostic.tags }),
            ...(related.length === 0
              ? {}
              : { relatedInformation: Object.freeze(related) }),
          }),
        );
      }
      for (const diagnostic of inspected.diagnostics) {
        if (diagnostic.start === undefined) continue;
        const range = rangeFor(
          text,
          diagnostic.start,
          diagnostic.start + (diagnostic.length ?? 0),
        );
        if (range === undefined) continue;
        items.push(
          Object.freeze({
            range,
            message: ts.flattenDiagnosticMessageText(
              diagnostic.messageText,
              "\n",
            ),
            severity: severity(diagnostic.category),
            source: "sweetener",
            code: diagnostic.code,
          }),
        );
      }
    }
    return Object.freeze({ kind: "full", items: Object.freeze(items) });
  }

  #publish(uri: string): void {
    try {
      const report = this.#diagnostics(uri);
      this.#outgoing.push({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: report.items },
      });
    } catch {
      // The document went away between the edit and the publish.
    }
  }

  #pathForSource(sourceId: SourceId): string | undefined {
    for (const [path, inspected] of this.#boundInspections())
      if (inspected.sourceId === sourceId) return path;
    return undefined;
  }

  /**
   * The macro name under the cursor: a call, a `for syntax` import, or the
   * definition itself. The call's generated spelling is the expansion.
   */
  #macroAt(
    path: string,
    offset: number,
  ):
    | {
        readonly name: string;
        readonly category: string;
        readonly start: number;
        readonly end: number;
        readonly expansion: string;
        readonly definitionPath: string;
        readonly definitionStart: number;
        readonly definitionEnd: number;
      }
    | undefined {
    const inspected = this.#boundInspections().get(path);
    const macros = inspected?.macros;
    if (inspected === undefined || macros === undefined) return undefined;
    const head = invocationHead(inspected, offset);
    const macro =
      head === undefined
        ? macros.find(
            (candidate) =>
              candidate.imports.some(
                (site) => offset >= site.start && offset < site.end,
              ) ||
              (candidate.definitionSourceId === inspected.sourceId &&
                offset >= candidate.definitionStart &&
                offset < candidate.definitionEnd),
          )
        : macros.find((candidate) => candidate.binding === head.binding);
    if (macro === undefined) return undefined;
    const definitionPath = this.#pathForSource(macro.definitionSourceId);
    if (definitionPath === undefined) return undefined;
    const definition = nameSpan(
      this.#text(definitionPath),
      macro.definitionStart,
      macro.definitionEnd,
      macro.name,
    );
    const imported = macro.imports.find(
      (site) => offset >= site.start && offset < site.end,
    );
    const use =
      head !== undefined
        ? { start: head.start, end: head.end }
        : imported !== undefined
          ? imported
          : definition;
    return Object.freeze({
      name: macro.name,
      category: macro.category,
      start: use.start,
      end: use.end,
      expansion:
        head === undefined ? "" : expandedCall(inspected, head.invocationId),
      definitionPath,
      definitionStart: definition.start,
      definitionEnd: definition.end,
    });
  }

  #hover(path: string, offset: number): unknown {
    const service = this.#boundService();
    const inspected = this.#boundInspections().get(path);
    if (inspected === undefined) return null;
    const macro = this.#macroAt(path, offset);
    const text = this.#text(path);
    if (macro !== undefined) {
      const range = rangeFor(text, macro.start, macro.end);
      if (range === undefined) return null;
      return Object.freeze({
        contents: this.#hoverContents(
          path,
          `(macro) ${macro.name}: ${macro.category}`,
          macro.expansion,
        ),
        range,
      });
    }
    const info = service.quickInfo(path, offset);
    if (info !== undefined) {
      if (info.textSpan === undefined) return null;
      const range = rangeFor(text, info.textSpan.start, info.textSpan.end);
      if (range === undefined) return null;
      return Object.freeze({
        contents: this.#hoverContents(
          path,
          ts.displayPartsToString([...info.displayParts]),
          "",
          ts.displayPartsToString([...info.documentation]),
          info.tags,
        ),
        range,
      });
    }
    // A copied token TypeScript has no quick info for still has an expanded
    // spelling. The range stays on the source character that produced it.
    const generated = inspected.index.originalToGenerated(
      inspected.sourceId,
      offset,
    )[0];
    if (generated === undefined) return null;
    const range = rangeFor(
      text,
      generated.primary.span.start,
      generated.primary.span.end,
    );
    const value = inspected.generated.text.slice(
      generated.generatedStart,
      generated.generatedEnd,
    );
    if (range === undefined || value.length === 0) return null;
    return Object.freeze({
      contents: this.#hoverContents(path, value, ""),
      range,
    });
  }

  #hoverContents(
    fileName: string,
    signature: string,
    code: string,
    documentation = "",
    tags: readonly ts.JSDocTagInfo[] = [],
  ): { readonly kind: "markdown" | "plaintext"; readonly value: string } {
    const body = [signature, code].filter((part) => part.length > 0).join("\n");
    const notes = [documentation.trim(), ...tags.map(formatTag)].filter(
      (part) => part.length > 0,
    );
    if (!this.#hoverMarkdown)
      return Object.freeze({
        kind: "plaintext",
        value: [body, ...notes].join("\n\n"),
      });
    return Object.freeze({
      kind: "markdown",
      value: [fence(hoverLanguage(fileName), body), ...notes].join("\n\n"),
    });
  }

  #location(
    path: string | undefined,
    start: number | undefined,
    end: number | undefined,
  ): { readonly uri: string; readonly range: LspRange } | undefined {
    if (path === undefined || start === undefined || end === undefined)
      return undefined;
    const range = rangeFor(this.#text(path), start, end);
    if (range === undefined) return undefined;
    return Object.freeze({ uri: this.#uri(path), range });
  }

  #definitions(path: string, offset: number): unknown {
    this.#boundService();
    const macro = this.#macroAt(path, offset);
    if (macro !== undefined) {
      const located = this.#location(
        macro.definitionPath,
        macro.definitionStart,
        macro.definitionEnd,
      );
      return located === undefined ? null : Object.freeze([located]);
    }
    const definitions = this.#boundService().definitions(path, offset);
    if (definitions.length === 0) {
      const keyword = this.#blockKeyword(path, offset);
      if (keyword !== undefined) {
        const located = this.#location(
          keyword.definitionPath,
          keyword.definitionStart,
          keyword.definitionEnd,
        );
        return located === undefined ? null : Object.freeze([located]);
      }
    }
    const locations = [];
    for (const definition of definitions) {
      if (definition.expansionView) continue;
      const located =
        definition.source === undefined
          ? this.#location(
              definition.sourceFileName,
              definition.generatedTextSpan.start,
              definition.generatedTextSpan.start +
                definition.generatedTextSpan.length,
            )
          : this.#location(
              definition.sourceFileName,
              definition.source.start,
              definition.source.end,
            );
      if (located !== undefined) locations.push(located);
    }
    return locations.length === 0 ? null : Object.freeze(locations);
  }

  #references(
    path: string,
    offset: number,
    includeDeclaration: boolean,
  ): unknown {
    const references = this.#boundService().references(path, offset);
    const locations = [];
    for (const reference of references) {
      if (reference.expansionView) continue;
      if (!includeDeclaration && reference.isDefinition) continue;
      // An ordinary `.ts` hit has no Sweetener span. Its generated span is the
      // span in that file, the same way a definition in `runtime.ts` is.
      const located =
        reference.source === undefined
          ? this.#location(
              reference.sourceFileName,
              reference.generatedTextSpan.start,
              reference.generatedTextSpan.start +
                reference.generatedTextSpan.length,
            )
          : this.#location(
              reference.sourceFileName,
              reference.source.start,
              reference.source.end,
            );
      if (located !== undefined) locations.push(located);
    }
    return locations.length === 0 ? null : Object.freeze(locations);
  }

  #completions(path: string, offset: number): unknown {
    const syntaxImport = this.#syntaxImportCompletion(path, offset);
    if (syntaxImport !== undefined) return syntaxImport;
    const completions = this.#boundService().completions(path, offset);
    if (completions === undefined) return null;
    const text = this.#text(path);
    return Object.freeze({
      isIncomplete: false,
      items: Object.freeze(
        completions.entries.map((entry) => {
          const replacement =
            entry.replacementSpan === undefined
              ? undefined
              : rangeFor(
                  text,
                  entry.replacementSpan.start,
                  entry.replacementSpan.end,
                );
          return Object.freeze({
            label: entry.name,
            kind: completionKinds[entry.kind] ?? 1,
            sortText: entry.sortText,
            insertTextFormat: entry.isSnippet ? 2 : 1,
            data: Object.freeze({
              uri: this.#uri(path),
              offset,
              name: entry.name,
              ...(entry.source === undefined ? {} : { source: entry.source }),
            }),
            ...(entry.insertText === undefined
              ? {}
              : { insertText: entry.insertText }),
            ...(replacement === undefined
              ? {}
              : {
                  textEdit: Object.freeze({
                    range: replacement,
                    newText: entry.insertText ?? entry.name,
                  }),
                }),
          });
        }),
      ),
    });
  }

  #prepareRename(path: string, offset: number): unknown {
    const rename = this.#boundService().rename(path, offset);
    if (!rename.canRename) throw new RequestError(-32803, rename.reason);
    const text = this.#text(path);
    const here = rename.locations.find(
      (location) =>
        location.source !== undefined &&
        offset >= location.source.start &&
        offset < location.source.end,
    );
    const span = here?.source ?? rename.locations[0]?.source;
    if (span === undefined) return null;
    const range = rangeFor(text, span.start, span.end);
    if (range === undefined) return null;
    return Object.freeze({ range, placeholder: rename.displayName });
  }

  #rename(path: string, offset: number, newName: string): unknown {
    const rename = this.#boundService().rename(path, offset);
    if (!rename.canRename) throw new RequestError(-32803, rename.reason);
    const changes: Record<
      string,
      { readonly range: LspRange; readonly newText: string }[]
    > = {};
    for (const location of rename.locations) {
      if (location.sourceFileName === undefined) continue;
      const range =
        location.source === undefined
          ? rangeFor(
              this.#text(location.sourceFileName),
              location.generatedTextSpan.start,
              location.generatedTextSpan.start +
                location.generatedTextSpan.length,
            )
          : rangeFor(
              this.#text(location.sourceFileName),
              location.source.start,
              location.source.end,
            );
      if (range === undefined) continue;
      const uri = this.#uri(location.sourceFileName);
      const edits = changes[uri] ?? [];
      edits.push(Object.freeze({ range, newText: newName }));
      changes[uri] = edits;
    }
    if (Object.keys(changes).length === 0)
      throw new RequestError(-32803, "No source location can be renamed.");
    return Object.freeze({ changes });
  }

  #syntaxImportCompletion(path: string, offset: number): unknown {
    const text = this.#text(path);
    const from = text.lastIndexOf("import", offset);
    if (from < 0 || offset - from > 400) return undefined;
    const clause = text.slice(from, Math.min(text.length, from + 400));
    if (!clause.includes("for syntax")) return undefined;
    const open = clause.indexOf("{");
    const close = clause.indexOf("}");
    if (open < 0 || close < open) return undefined;
    const absoluteOpen = from + open;
    const absoluteClose = from + close;
    if (offset <= absoluteOpen || offset > absoluteClose) return undefined;
    const specifier = /from\s+["']([^"']+)["']/u.exec(clause);
    if (specifier === null) return undefined;
    const importedFrom = specifier[1];
    if (importedFrom === undefined) return undefined;
    const target = resolve(dirname(path), importedFrom);
    const imported = this.#boundInspections().get(target);
    if (imported?.macros === undefined) return undefined;
    let wordStart = offset;
    while (
      wordStart > absoluteOpen &&
      /[A-Za-z0-9_$]/u.test(text[wordStart - 1] ?? "")
    )
      wordStart -= 1;
    const prefix = text.slice(wordStart, offset);
    const range = rangeFor(text, wordStart, offset);
    const items = imported.macros
      .filter(
        (macro) =>
          macro.definitionSourceId === imported.sourceId &&
          macro.name.startsWith(prefix),
      )
      .map((macro) =>
        Object.freeze({
          label: macro.name,
          kind: 3,
          detail: macro.category,
          insertText: macro.name,
          insertTextFormat: 1,
          ...(range === undefined
            ? {}
            : {
                textEdit: Object.freeze({ range, newText: macro.name }),
              }),
        }),
      );
    return Object.freeze({ isIncomplete: false, items: Object.freeze(items) });
  }

  #resolveCompletion(params: unknown): unknown {
    const item = record(params);
    const data = record(item?.["data"]);
    const uri = data?.["uri"];
    const offset = data?.["offset"];
    const name = data?.["name"];
    if (
      typeof uri !== "string" ||
      typeof offset !== "number" ||
      typeof name !== "string"
    )
      return params;
    const path = resolve(fileURLToPath(uri));
    const source =
      typeof data?.["source"] === "string" ? data["source"] : undefined;
    const fill = (): unknown => {
      const details = this.#boundService().completionDetails(
        path,
        offset,
        name,
        source,
      );
      if (details === undefined) return params;
      return {
        ...(item ?? {}),
        detail: details.detail,
        ...(details.documentation.length === 0
          ? {}
          : {
              documentation: Object.freeze({
                kind: "markdown",
                value: details.documentation,
              }),
            }),
      };
    };
    return this.#inspections.has(path) ? fill() : this.#once(path, fill);
  }

  #located(
    definitions: readonly {
      readonly expansionView: boolean;
      readonly source:
        { readonly start: number; readonly end: number } | undefined;
      readonly sourceFileName: string | undefined;
      readonly generatedTextSpan: {
        readonly start: number;
        readonly length: number;
      };
    }[],
  ): unknown {
    const locations = [];
    for (const definition of definitions) {
      if (definition.expansionView) continue;
      const located =
        definition.source === undefined
          ? this.#location(
              definition.sourceFileName,
              definition.generatedTextSpan.start,
              definition.generatedTextSpan.start +
                definition.generatedTextSpan.length,
            )
          : this.#location(
              definition.sourceFileName,
              definition.source.start,
              definition.source.end,
            );
      if (located !== undefined) locations.push(located);
    }
    return locations.length === 0 ? null : Object.freeze(locations);
  }

  #signatureHelp(path: string, offset: number): unknown {
    const help = this.#boundService().signatureHelp(path, offset);
    if (help === undefined) return null;
    return Object.freeze({
      activeSignature: help.selectedItemIndex,
      activeParameter: help.argumentIndex,
      signatures: Object.freeze(
        help.items.map((item) => {
          const parameters = item.parameters.map((parameter) =>
            ts.displayPartsToString(parameter.displayParts),
          );
          const label = [
            ts.displayPartsToString(item.prefixDisplayParts),
            parameters.join(
              ts.displayPartsToString(item.separatorDisplayParts),
            ),
            ts.displayPartsToString(item.suffixDisplayParts),
          ].join("");
          return Object.freeze({
            label,
            parameters: Object.freeze(
              parameters.map((parameter) =>
                Object.freeze({ label: parameter }),
              ),
            ),
          });
        }),
      ),
    });
  }

  #highlights(path: string, offset: number): unknown {
    const text = this.#text(path);
    const highlights = [];
    for (const span of this.#boundService().documentHighlights(path, offset)) {
      const range = rangeFor(text, span.source.start, span.source.end);
      if (range === undefined) continue;
      highlights.push(
        Object.freeze({
          range,
          kind: span.kind === "write" ? 3 : span.kind === "read" ? 2 : 1,
        }),
      );
    }
    return highlights.length === 0 ? null : Object.freeze(highlights);
  }

  #symbols(path: string): unknown {
    const text = this.#text(path);
    const convert = (symbol: MappedDocumentSymbol): object | undefined => {
      const range = rangeFor(text, symbol.source.start, symbol.source.end);
      if (range === undefined) return undefined;
      return Object.freeze({
        name: symbol.name,
        kind: completionKinds[symbol.kind] ?? 1,
        range,
        selectionRange: range,
        children: Object.freeze(
          symbol.children.flatMap((child) => {
            const converted = convert(child);
            return converted === undefined ? [] : [converted];
          }),
        ),
      });
    };
    return Object.freeze(
      this.#boundService()
        .documentSymbols(path)
        .flatMap((symbol) => {
          const converted = convert(symbol);
          return converted === undefined ? [] : [converted];
        }),
    );
  }

  #blockKeyword(
    path: string,
    offset: number,
  ):
    | {
        readonly definitionPath: string;
        readonly definitionStart: number;
        readonly definitionEnd: number;
      }
    | undefined {
    const text = this.#text(path);
    if (wordAt(text, offset) !== "else" && wordAt(text, offset) !== "end")
      return undefined;
    const before = text.slice(0, offset);
    const whenAt = before.lastIndexOf("{when");
    const eachAt = before.lastIndexOf("{each");
    const at = Math.max(whenAt, eachAt);
    if (at < 0) return undefined;
    const name = whenAt > eachAt ? "when" : "each";
    let macro:
      NonNullable<SourceExpansionInspection["macros"]>[number] | undefined;
    for (const inspected of this.#boundInspections().values()) {
      macro = inspected.macros?.find(
        (candidate) =>
          candidate.name === name &&
          candidate.definitionSourceId === inspected.sourceId,
      );
      if (macro !== undefined) break;
    }
    if (macro === undefined) return undefined;
    const definitionPath = this.#pathForSource(macro.definitionSourceId);
    if (definitionPath === undefined) return undefined;
    const definition = nameSpan(
      this.#text(definitionPath),
      macro.definitionStart,
      macro.definitionEnd,
      macro.name,
    );
    return {
      definitionPath,
      definitionStart: definition.start,
      definitionEnd: definition.end,
    };
  }
}

export function createLanguageServerSession(
  projectDirectory: string,
): LanguageServerSession {
  return new LanguageServerSession(projectDirectory);
}

export function handleLanguageServerMessage(
  session: LanguageServerSession,
  message: JsonRpcMessage,
):
  | {
      readonly jsonrpc: "2.0";
      readonly id: number | string | null;
      readonly result?: unknown;
      readonly error?: { readonly code: number; readonly message: string };
    }
  | undefined {
  const method = message.method;
  if (typeof method !== "string") {
    return Object.freeze({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: Object.freeze({ code: -32600, message: "request has no method" }),
    });
  }
  const answer = session.answer(method, message.params);
  if (answer.kind === "notification" || message.id === undefined)
    return undefined;
  if (answer.kind === "error")
    return Object.freeze({
      jsonrpc: "2.0",
      id: message.id,
      error: Object.freeze({ code: answer.code, message: answer.message }),
    });
  return Object.freeze({
    jsonrpc: "2.0",
    id: message.id,
    result: answer.result,
  });
}

function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${String(body.length)}\r\n\r\n`, "ascii"),
    body,
  ]);
}

/** Speak LSP JSON-RPC on a pair of streams until the client closes them. */
export function serveLanguageServer(
  projectDirectory: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): void {
  const session = createLanguageServerSession(projectDirectory);
  let pending = Buffer.alloc(0);
  let exited = false;
  const finish = (): void => {
    if (exited) return;
    exited = true;
    session.dispose();
    process.exit(0);
  };
  input.on("data", (chunk: Buffer | string) => {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    for (;;) {
      const headerEnd = pending.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = pending.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/iu.exec(header);
      if (match === null) {
        pending = Buffer.alloc(0);
        output.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "missing Content-Length" },
          }),
        );
        return;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (pending.length < start + length) return;
      const body = pending.subarray(start, start + length).toString("utf8");
      pending = pending.subarray(start + length);
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(body) as JsonRpcMessage;
      } catch (error) {
        output.write(
          encodeMessage({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
        continue;
      }
      const response = handleLanguageServerMessage(session, message);
      for (const note of session.takeOutgoing())
        output.write(encodeMessage(note));
      if (response !== undefined) output.write(encodeMessage(response));
      if (message.method === "exit") finish();
    }
  });
  input.on("end", finish);
  input.on("close", finish);
}
