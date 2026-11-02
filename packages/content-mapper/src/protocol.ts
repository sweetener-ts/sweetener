/**
 * The TypeScript content-mapper protocol, version 1.
 *
 * TypeScript 7.1 starts a content mapper as a child process and speaks
 * JSON-RPC to it over stdin and stdout, framed the way the Language Server
 * Protocol frames messages. It asks for four things: `initialize` once per
 * process, `openProject` and `closeProject` around each tsconfig that lists
 * the mapper, and `transform` for every file whose extension the mapper
 * claimed. These shapes follow `internal/contentmapper` in typescript-go.
 */

export const protocolVersion = 1 as const;

export type PositionEncoding = "utf-8" | "utf-16";

export interface InitializeParams {
  readonly protocolVersion?: number;
  readonly locale?: string;
  readonly positionEncodings: readonly PositionEncoding[];
}

export interface InitializeResult {
  readonly protocolVersion: typeof protocolVersion;
  readonly positionEncoding: PositionEncoding;
  readonly diagnosticSource: string;
}

export interface OpenProjectParams {
  /** Absolute tsconfig path, or an empty string for a project without one. */
  readonly configFileName: string;
  readonly projectHandle: string;
  /** This mapper's `options` from its `contentMappers` entry. */
  readonly options?: unknown;
  readonly compilerOptions: Readonly<Record<string, unknown>>;
}

export interface OptionDiagnostic {
  readonly path: readonly (string | number)[];
  readonly messageText: string;
  readonly code: number;
}

export interface OpenProjectResult {
  /**
   * A fingerprint of everything outside a file that decides what it expands
   * to. TypeScript folds it into the key it caches transforms under, so a new
   * identity re-transforms every file. Required by `dynamicConfig: true`.
   */
  readonly configIdentity: string;
  /** Absolute files whose change makes TypeScript reopen the project. */
  readonly watchedFiles: readonly string[];
  readonly optionDiagnostics?: readonly OptionDiagnostic[];
}

export interface CloseProjectParams {
  readonly projectHandle: string;
}

export interface TransformParams {
  readonly fileName: string;
  /** The file's text as TypeScript holds it, which may be unsaved. */
  readonly content: string;
  readonly projectHandle: string;
}

export type VirtualExtension =
  ".js" | ".jsx" | ".mjs" | ".cjs" | ".ts" | ".tsx" | ".mts" | ".cts" | ".json";

/** How positions inside one segment relate to its original span. */
export const SpanMapKind = {
  /** Same text on both sides; positions inside map one to one. */
  Verbatim: 0,
  /** One unit; a position inside maps to the whole original span. */
  Atom: 1,
  /** An atom whose two texts name the same thing. */
  Alias: 2,
} as const;
export type SpanMapKind = (typeof SpanMapKind)[keyof typeof SpanMapKind];

/**
 * Language-service operations that may use a segment. Diagnostics are not
 * among them: TypeScript maps a diagnostic through any segment it lands in.
 */
export const SpanMapFeature = {
  None: 0,
  Rename: 1 << 8,
  LinkedEditing: 1 << 16,
  All: (1 << 20) - 1,
} as const;

/**
 * `[virtualStart, virtualLength, originalStart, originalLength, kind,
 * features?]`, with features omitted meaning all of them.
 */
export type SpanMapping =
  | readonly [number, number, number, number, SpanMapKind]
  | readonly [number, number, number, number, SpanMapKind, number];

export interface ContentMapperDiagnostic {
  readonly messageText: string;
  /** Original-source offset in the negotiated encoding. */
  readonly start: number;
  readonly length: number;
  readonly code: number;
}

export interface TransformResult {
  readonly text: string;
  readonly extension: VirtualExtension;
  readonly mappings: readonly SpanMapping[];
  readonly diagnostics?: readonly ContentMapperDiagnostic[];
}
