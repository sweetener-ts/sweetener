import { createSpan, createTrivia, type Trivia } from "@sweetener/syntax";
import {
  defaultResourceBudget,
  neverCancelled,
  ResourceTracker,
} from "@sweetener/shared";
import {
  scanWithSupportedTypeScript,
  type TypeScriptScannedToken,
  type TypeScriptScanResult,
} from "../typescript-version/adapter.js";
import { readerDiagnosticRegistry, scannerErrorCode } from "./diagnostics.js";
import type { ScanOptions, ScanResult, ScannerToken } from "./types.js";

function tokenValue(
  token: TypeScriptScannedToken,
): string | number | undefined {
  switch (token.projectKind) {
    case "numeric-literal": {
      const number = Number(token.value);
      return Number.isNaN(number) ? token.value : number;
    }
    case "identifier":
    case "private-identifier":
    case "keyword":
    case "string-literal":
    case "bigint-literal":
    case "regular-expression-literal":
    case "no-substitution-template":
    case "template-head":
    case "template-middle":
    case "template-tail":
    case "jsx-identifier":
    case "jsx-text":
      return token.value;
    default:
      return undefined;
  }
}

function toTrivia(token: TypeScriptScannedToken): Trivia | undefined {
  if (token.triviaKind === undefined || token.raw.length === 0)
    return undefined;
  return createTrivia({
    kind: token.triviaKind,
    raw: token.raw,
    span: createSpan(token.start, token.end),
  });
}

/**
 * The tokens of a scan, each with the trivia written in front of it, ending
 * with the end of the file.
 */
export function scannerTokens(
  scanned: TypeScriptScanResult,
): readonly ScannerToken[] {
  const tokens: ScannerToken[] = [];
  let leadingTrivia: Trivia[] = [];
  for (const token of scanned.tokens) {
    if (token.projectKind === undefined) {
      const trivia = toTrivia(token);
      if (trivia !== undefined) leadingTrivia.push(trivia);
      continue;
    }
    const kind = token.projectKind;
    tokens.push(
      Object.freeze({
        kind,
        typescriptKind: token.kind,
        typescriptKindName: token.kindName,
        raw: token.raw,
        value: tokenValue(token),
        span: createSpan(token.start, token.end),
        leadingTrivia: Object.freeze(leadingTrivia),
        trailingTrivia: Object.freeze([]),
        lexicalMode: token.lexicalMode,
        precededByLineBreak: token.precededByLineBreak,
        unterminated: token.unterminated,
      }),
    );
    leadingTrivia = [];
  }
  return Object.freeze(tokens);
}

export function scanTypeScript(
  source: string,
  options: ScanOptions,
): ScanResult {
  const tracker = new ResourceTracker(options.budget ?? defaultResourceBudget);
  const readings = options.readings ?? new Map();
  const scanned = scanWithSupportedTypeScript(
    source,
    options.variant ?? "standard",
    () => {
      (options.cancellation ?? neverCancelled).throwIfCancellationRequested();
      tracker.chargeInputTokens();
    },
    readings,
  );
  const unread = new Set(scanned.unread);
  return Object.freeze({
    tokens: scannerTokens(scanned),
    diagnostics: Object.freeze(
      scanned.errors.map((error) =>
        readerDiagnosticRegistry.create(scannerErrorCode, {
          primaryOrigin: {
            sourceId: options.sourceId,
            start: error.start,
            end: error.start + error.length,
          },
          messageArguments: [error.message],
        }),
      ),
    ),
    readings: new Map(
      [...readings].filter(([offset]) => !unread.has(offset)),
    ),
    typescriptVersion: scanned.version,
  });
}

export function reconstructScannedSource(
  tokens: readonly ScannerToken[],
): string {
  return tokens
    .map(
      (token) =>
        token.leadingTrivia.map((trivia) => trivia.raw).join("") + token.raw,
    )
    .join("");
}
