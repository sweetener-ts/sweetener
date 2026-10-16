import type {
  CancellationToken,
  Diagnostic,
  ResourceBudget,
  SourceId,
} from "@sweetener/shared";
import type {
  LexicalMode,
  TokenReadings,
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
  /** How the slashes and `<`s at given offsets are read; see `TokenReadings`. */
  readonly readings?: TokenReadings;
  readonly cancellation?: CancellationToken;
  readonly budget?: ResourceBudget;
}

export interface ScanResult {
  readonly tokens: readonly ScannerToken[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * The readings the scan was given that it read their token at. One it read
   * none at was found in an earlier read of the text, at a slash that a
   * reading in front of it has since taken inside a regular expression or
   * split out of one, or at a `<` that has since been read into an element's
   * text; it no longer applies, and is not in this.
   */
  readonly readings: TokenReadings;
  readonly typescriptVersion: string;
}
