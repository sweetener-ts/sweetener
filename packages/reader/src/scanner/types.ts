import type {
  CancellationToken,
  Diagnostic,
  ResourceBudget,
  SourceId,
} from "@sweetener/shared";
import type {
  LexicalMode,
  SlashReadings,
  Span,
  TokenKind,
  Trivia,
} from "@sweetener/syntax";
import type { ScannerLanguageVariant } from "../typescript-version/adapter.js";

export interface ScannerToken {
  readonly kind: TokenKind;
  readonly typescriptKind: number;
  readonly typescriptKindName: string;
  readonly raw: string;
  readonly value: string | number | undefined;
  readonly span: Span;
  readonly leadingTrivia: readonly Trivia[];
  readonly trailingTrivia: readonly Trivia[];
  readonly lexicalMode: LexicalMode;
  readonly precededByLineBreak: boolean;
  readonly unterminated: boolean;
}

export interface ScanOptions {
  readonly sourceId: SourceId;
  readonly variant?: ScannerLanguageVariant;
  /** How the slashes at given offsets are read; see `SlashReadings`. */
  readonly slashReadings?: SlashReadings;
  readonly cancellation?: CancellationToken;
  readonly budget?: ResourceBudget;
}

export interface ScanResult {
  readonly tokens: readonly ScannerToken[];
  readonly diagnostics: readonly Diagnostic[];
  readonly typescriptVersion: string;
}
