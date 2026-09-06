import type { OriginId, ScopeSetId, SyntaxId } from "@sweetener/shared";
import type {
  DelimiterKind,
  LexicalMode,
  Precedence,
  SyntaxCategory,
  TokenKind,
} from "./kinds.js";
import { delimiterText } from "./kinds.js";
import type { Span } from "./span.js";
import { createSpan } from "./span.js";
import type { Trivia } from "./trivia.js";
import { createTrivia } from "./trivia.js";

export interface SyntaxBase {
  readonly id: SyntaxId;
  readonly span: Span;
  readonly origin: OriginId;
  readonly scopes: ScopeSetId;
}

export interface TokenSyntax extends SyntaxBase {
  readonly tag: "token";
  readonly kind: TokenKind;
  readonly raw: string;
  readonly value: string | number | undefined;
  readonly leadingTrivia: readonly Trivia[];
  readonly trailingTrivia: readonly Trivia[];
  readonly lexicalMode: LexicalMode;
}

export interface MissingToken extends SyntaxBase {
  readonly tag: "missing";
  readonly expectedRaw: string;
}

export interface GroupSyntax extends SyntaxBase {
  readonly tag: "group";
  readonly delimiter: DelimiterKind;
  readonly open: TokenSyntax;
  readonly children: readonly Syntax[];
  readonly close: TokenSyntax | MissingToken;
}

export interface ProtectedSyntax extends SyntaxBase {
  readonly tag: "protected";
  readonly category: SyntaxCategory;
  readonly precedence: Precedence | undefined;
  readonly children: readonly Syntax[];
}

export interface RootSyntax extends SyntaxBase {
  readonly tag: "root";
  readonly children: readonly Syntax[];
}

export type Syntax = TokenSyntax | GroupSyntax | ProtectedSyntax | RootSyntax;
export type SyntaxSequence = readonly Syntax[];

export interface SyntaxBaseFields {
  readonly id: SyntaxId;
  readonly span: Span;
  readonly origin: OriginId;
  readonly scopes: ScopeSetId;
}

export interface CreateTokenOptions extends SyntaxBaseFields {
  readonly kind: TokenKind;
  readonly raw: string;
  readonly value?: string | number | undefined;
  readonly leadingTrivia?: readonly Trivia[];
  readonly trailingTrivia?: readonly Trivia[];
  readonly lexicalMode?: LexicalMode;
}

/** Shared, so the overwhelmingly common empty case allocates nothing. */
const noTrivia: readonly Trivia[] = Object.freeze([]);

function freezeTrivia(
  trivia: readonly Trivia[] | undefined,
): readonly Trivia[] {
  if (trivia === undefined || trivia.length === 0) return noTrivia;
  // Trivia that is already immutable is already what this would build. Copying
  // it anyway rebuilt and re-froze an object per piece of whitespace in the
  // file, which is one of the largest sources of garbage in a read.
  if (Object.isFrozen(trivia) && trivia.every(isFrozenTrivia)) return trivia;
  return Object.freeze(
    trivia.map((item) =>
      createTrivia({ kind: item.kind, raw: item.raw, span: item.span }),
    ),
  );
}

function isFrozenTrivia(item: Trivia): boolean {
  return Object.isFrozen(item) && Object.isFrozen(item.span);
}

function requireFrozenSyntax(
  syntax: Syntax | MissingToken,
  field: string,
): void {
  if (!Object.isFrozen(syntax)) {
    throw new TypeError(`${field} must be an immutable syntax node`);
  }
}

export function createSyntaxSequence(
  syntax: readonly Syntax[],
): SyntaxSequence {
  for (const child of syntax) {
    requireFrozenSyntax(child, "Syntax sequence child");
  }
  return Object.freeze([...syntax]);
}

function base(fields: SyntaxBaseFields): SyntaxBaseFields {
  return {
    id: fields.id,
    span: createSpan(fields.span.start, fields.span.end),
    origin: fields.origin,
    scopes: fields.scopes,
  };
}

export function createToken(options: CreateTokenOptions): TokenSyntax {
  if (options.kind !== "end-of-file" && options.raw.length === 0) {
    throw new RangeError("Token raw text must not be empty");
  }
  if (options.kind === "end-of-file" && options.raw.length !== 0) {
    throw new RangeError("End-of-file token raw text must be empty");
  }
  return Object.freeze({
    ...base(options),
    tag: "token",
    kind: options.kind,
    raw: options.raw,
    value: options.value,
    leadingTrivia: freezeTrivia(options.leadingTrivia),
    trailingTrivia: freezeTrivia(options.trailingTrivia),
    lexicalMode: options.lexicalMode ?? "standard",
  });
}

export interface CreateMissingTokenOptions extends SyntaxBaseFields {
  readonly expectedRaw: string;
}

export function createMissingToken(
  options: CreateMissingTokenOptions,
): MissingToken {
  if (options.expectedRaw.length === 0) {
    throw new RangeError("Missing token must name expected text");
  }
  if (options.span.start !== options.span.end) {
    throw new RangeError("Missing token span must have zero width");
  }
  return Object.freeze({
    ...base(options),
    tag: "missing",
    expectedRaw: options.expectedRaw,
  });
}

export interface CreateGroupOptions extends SyntaxBaseFields {
  readonly delimiter: DelimiterKind;
  readonly open: TokenSyntax;
  readonly children?: readonly Syntax[];
  readonly close: TokenSyntax | MissingToken;
}

export function createGroup(options: CreateGroupOptions): GroupSyntax {
  requireFrozenSyntax(options.open, "Group open token");
  requireFrozenSyntax(options.close, "Group close token");
  const expected = delimiterText[options.delimiter];
  const validOpen =
    options.open.raw === expected.open ||
    (options.delimiter === "template" &&
      options.open.kind === "template-head" &&
      options.open.raw.startsWith("`"));
  if (!validOpen) {
    throw new RangeError(
      `${options.delimiter} group must open with ${expected.open}`,
    );
  }
  const validClose =
    options.close.tag === "token" &&
    (options.close.raw === expected.close ||
      (options.delimiter === "template" &&
        options.close.kind === "template-tail" &&
        options.close.raw.endsWith("`")));
  if (options.close.tag === "token" && !validClose) {
    throw new RangeError(
      `${options.delimiter} group must close with ${expected.close}`,
    );
  }
  if (
    options.close.tag === "missing" &&
    options.close.expectedRaw !== expected.close
  ) {
    throw new RangeError(
      `${options.delimiter} missing close must expect ${expected.close}`,
    );
  }
  return Object.freeze({
    ...base(options),
    tag: "group",
    delimiter: options.delimiter,
    open: options.open,
    children: createSyntaxSequence(options.children ?? []),
    close: options.close,
  });
}

export interface CreateProtectedSyntaxOptions extends SyntaxBaseFields {
  readonly category: SyntaxCategory;
  readonly precedence?: Precedence | undefined;
  readonly children: readonly Syntax[];
}

export function createProtectedSyntax(
  options: CreateProtectedSyntaxOptions,
): ProtectedSyntax {
  if (options.children.length === 0) {
    throw new RangeError("Protected syntax must contain at least one child");
  }
  return Object.freeze({
    ...base(options),
    tag: "protected",
    category: options.category,
    precedence: options.precedence,
    children: createSyntaxSequence(options.children),
  });
}

export interface CreateRootSyntaxOptions extends SyntaxBaseFields {
  readonly children: readonly Syntax[];
}

export function createRootSyntax(options: CreateRootSyntaxOptions): RootSyntax {
  return Object.freeze({
    ...base(options),
    tag: "root",
    children: createSyntaxSequence(options.children),
  });
}
