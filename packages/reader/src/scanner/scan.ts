import { createSpan, createTrivia, type Trivia } from "@sweetener/syntax";
import {
  defaultResourceBudget,
  neverCancelled,
  ResourceTracker,
} from "@sweetener/shared";
import {
  scanWithSupportedTypeScript,
  type TypeScriptScannedToken,
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

export function scanTypeScript(
  source: string,
  options: ScanOptions,
): ScanResult {
  const tracker = new ResourceTracker(options.budget ?? defaultResourceBudget);
  const scanned = scanWithSupportedTypeScript(
    source,
    options.variant ?? "standard",
    () => {
      (options.cancellation ?? neverCancelled).throwIfCancellationRequested();
      tracker.chargeInputTokens();
    },
    options.slashReadings,
  );
  // A reading names a slash the parser stood at in an earlier read of the
  // same text, and everything in front of a slash is scanned alike either
  // way. One that names no slash was given for some other text.
  const [unread] = scanned.unread;
  if (unread !== undefined)
    throw new RangeError(
      `No slash at offset ${String(unread)} to read as ${String(options.slashReadings?.get(unread))}`,
    );
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

  return Object.freeze({
    tokens: Object.freeze(tokens),
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
