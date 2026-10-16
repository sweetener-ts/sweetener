import {
  createIdAllocator,
  defaultResourceBudget,
  neverCancelled,
  ResourceLimitError,
  ResourceTracker,
  type CancellationToken,
  type Diagnostic,
  type ResourceBudget,
  type ScopeSetId,
  type SourceId,
  type SyntaxId,
} from "@sweetener/shared";
import {
  createGroup,
  createMissingToken,
  createRootSyntax,
  createSpan,
  createToken,
  delimiterText,
  OriginStore,
  type DelimiterKind,
  type RootSyntax,
  type TokenReadings,
  type Syntax,
  type TokenSyntax,
} from "@sweetener/syntax";
import {
  missingCloserCode,
  nestingLimitCode,
  readerDiagnosticRegistry,
  unexpectedCloserCode,
} from "./scanner/diagnostics.js";
import { scanTypeScript } from "./scanner/scan.js";
import type { ScannerLanguageVariant } from "./typescript-version/adapter.js";

export interface ReadSyntaxOptions {
  readonly sourceId: SourceId;
  readonly scopes: ScopeSetId;
  readonly variant?: ScannerLanguageVariant;
  /**
   * How the slashes and `<`s at given offsets are read, as the enforester
   * found them in an earlier read of the same text; see `TokenReadings`.
   */
  readonly readings?: TokenReadings;
  readonly originStore?: OriginStore;
  readonly cancellation?: CancellationToken;
  readonly budget?: ResourceBudget;
}

export interface ReadSyntaxResult {
  readonly root: RootSyntax;
  readonly diagnostics: readonly Diagnostic[];
  readonly origins: OriginStore;
  /** The readings the read applied; see `ScanResult.readings`. */
  readonly readings: TokenReadings;
  readonly typescriptVersion: string;
}

interface GroupFrame {
  delimiter: DelimiterKind;
  readonly open: TokenSyntax;
  readonly children: Syntax[];
  jsxOpeningComplete: boolean;
  jsxClosing: boolean;
  /**
   * How many `<` of a tag's type arguments are still open. `<Comp<string> />`
   * is a generic element, and its inner `<` is scanned in tag mode like the
   * tag's own, so pushing an element frame for it read the type argument as a
   * nested element and the tag never closed.
   */
  jsxTypeArguments: number;
  /**
   * Whether the frame opens deeper than the nesting limit allows. Its
   * delimiters are read as the tokens they are rather than as a group, and
   * what it holds stands in the frame around it, whose children these are.
   */
  readonly flat?: true;
}

const ordinaryOpen = new Map<string, DelimiterKind>([
  ["(", "parenthesis"],
  ["[", "bracket"],
  ["{", "brace"],
]);

const ordinaryClose = new Map<string, DelimiterKind>([
  [")", "parenthesis"],
  ["]", "bracket"],
  ["}", "brace"],
]);

function isJsx(delimiter: DelimiterKind): boolean {
  return delimiter === "jsx-element" || delimiter === "jsx-fragment";
}

export function readSyntax(
  source: string,
  options: ReadSyntaxOptions,
): ReadSyntaxResult {
  const scanned = scanTypeScript(source, options);
  const nesting = new ResourceTracker(options.budget ?? defaultResourceBudget);
  const cancellation = options.cancellation ?? neverCancelled;
  const syntaxIds = createIdAllocator<SyntaxId>();
  const origins = options.originStore ?? new OriginStore();
  const diagnostics: Diagnostic[] = [...scanned.diagnostics];
  const rootChildren: Syntax[] = [];
  const stack: GroupFrame[] = [];

  /**
   * Opens `frame`. One deeper than the nesting limit allows is read flat:
   * every tree read from a file is then as deep as the limit at most, which is
   * what lets everything that reads one recurse into it, and what nests deeper
   * is reported where it begins rather than ending the read.
   */
  const pushFrame = (frame: GroupFrame): void => {
    cancellation.throwIfCancellationRequested();
    try {
      nesting.enterNesting();
    } catch (error) {
      if (!(error instanceof ResourceLimitError)) throw error;
      const enclosing = stack.at(-1);
      const children = enclosing?.children ?? rootChildren;
      if (enclosing?.flat !== true)
        diagnostics.push(
          readerDiagnosticRegistry.create(nestingLimitCode, {
            primaryOrigin: {
              sourceId: options.sourceId,
              start: frame.open.span.start,
              end: frame.open.span.end,
              originId: frame.open.origin,
            },
            messageArguments: [error.limit],
          }),
        );
      children.push(frame.open);
      stack.push({ ...frame, children, flat: true });
      return;
    }
    stack.push(frame);
  };

  const popFrame = (): GroupFrame | undefined => {
    const frame = stack.pop();
    if (frame !== undefined && frame.flat !== true) nesting.leaveNesting();
    return frame;
  };

  const toToken = (token: (typeof scanned.tokens)[number]): TokenSyntax =>
    createToken({
      id: syntaxIds.allocate(),
      span: token.span,
      origin: origins.source(options.sourceId, token.span),
      scopes: options.scopes,
      kind: token.kind,
      raw: token.raw,
      value: token.value,
      leadingTrivia: token.leadingTrivia,
      trailingTrivia: token.trailingTrivia,
      lexicalMode: token.lexicalMode,
    });

  const append = (syntax: Syntax): void => {
    const frame = stack.at(-1);
    if (frame === undefined) rootChildren.push(syntax);
    else frame.children.push(syntax);
  };

  const finish = (
    frame: GroupFrame,
    close: TokenSyntax | ReturnType<typeof createMissingToken>,
  ): void => {
    if (frame.flat === true) {
      if (close.tag === "token") frame.children.push(close);
      return;
    }
    const end = close.span.end;
    append(
      createGroup({
        id: syntaxIds.allocate(),
        span: createSpan(frame.open.span.start, end),
        origin: origins.source(
          options.sourceId,
          createSpan(frame.open.span.start, end),
        ),
        scopes: options.scopes,
        delimiter: frame.delimiter,
        open: frame.open,
        children: frame.children,
        close,
      }),
    );
  };

  const closeMissing = (position: number): void => {
    const frame = popFrame();
    if (frame === undefined) return;
    const expectedRaw = delimiterText[frame.delimiter].close;
    const anchorSpan = createSpan(position, position);
    const anchor = origins.source(options.sourceId, anchorSpan);
    const missing = createMissingToken({
      id: syntaxIds.allocate(),
      span: anchorSpan,
      origin: origins.synthesized(anchor, "missing-token"),
      scopes: options.scopes,
      expectedRaw,
    });
    diagnostics.push(
      readerDiagnosticRegistry.create(missingCloserCode, {
        primaryOrigin: {
          sourceId: options.sourceId,
          start: frame.open.span.start,
          end: frame.open.span.end,
          originId: frame.open.origin,
        },
        messageArguments: [expectedRaw],
      }),
    );
    finish(frame, missing);
  };

  const closeMatching = (
    delimiter: DelimiterKind,
    close: TokenSyntax,
  ): boolean => {
    let matchingIndex = -1;
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]?.delimiter === delimiter) {
        matchingIndex = index;
        break;
      }
    }
    if (matchingIndex < 0) return false;
    while (stack.length - 1 > matchingIndex) closeMissing(close.span.start);
    const frame = popFrame();
    if (frame === undefined) return false;
    finish(frame, close);
    return true;
  };

  const unexpected = (token: TokenSyntax): void => {
    diagnostics.push(
      readerDiagnosticRegistry.create(unexpectedCloserCode, {
        primaryOrigin: {
          sourceId: options.sourceId,
          start: token.span.start,
          end: token.span.end,
          originId: token.origin,
        },
        messageArguments: [token.raw],
      }),
    );
    append(token);
  };

  for (const scannerToken of scanned.tokens) {
    const token = toToken(scannerToken);
    if (token.kind === "end-of-file") {
      while (stack.length > 0) closeMissing(token.span.start);
      append(token);
      continue;
    }

    if (token.kind === "template-head") {
      pushFrame({
        delimiter: "template",
        open: token,
        children: [],
        jsxOpeningComplete: false,
        jsxClosing: false,
        jsxTypeArguments: 0,
      });
      continue;
    }
    if (token.kind === "template-tail") {
      if (!closeMatching("template", token)) unexpected(token);
      continue;
    }

    if (token.lexicalMode === "jsx-tag" && token.raw === "<") {
      const enclosing = stack.at(-1);
      // Inside a tag that has already been named, a `<` opens that tag's type
      // arguments rather than a nested element -- but for one written as an
      // attribute's value, straight after its `=`, which opens an element:
      // `<a b=<c />>`. The scanner reads it so, and the groups agree.
      const previous = enclosing?.children.at(-1);
      if (
        enclosing !== undefined &&
        isJsx(enclosing.delimiter) &&
        !enclosing.jsxOpeningComplete &&
        !enclosing.jsxClosing &&
        enclosing.children.length > 0 &&
        !(
          enclosing.jsxTypeArguments === 0 &&
          previous?.tag === "token" &&
          previous.raw === "="
        )
      ) {
        enclosing.jsxTypeArguments += 1;
        enclosing.children.push(token);
        continue;
      }
      pushFrame({
        delimiter: "jsx-element",
        open: token,
        children: [],
        jsxOpeningComplete: false,
        jsxClosing: false,
        jsxTypeArguments: 0,
      });
      continue;
    }

    const top = stack.at(-1);
    if (top !== undefined && isJsx(top.delimiter)) {
      if (token.lexicalMode === "jsx-tag" && token.raw === "</") {
        top.jsxClosing = true;
        top.children.push(token);
        continue;
      }
      if (token.lexicalMode === "jsx-tag" && token.raw === ">") {
        if (top.jsxTypeArguments > 0) {
          top.jsxTypeArguments -= 1;
          top.children.push(token);
          continue;
        }
        if (!top.jsxOpeningComplete) {
          if (top.children.length === 0) top.delimiter = "jsx-fragment";
          const previous = top.children.at(-1);
          const selfClosing = previous?.tag === "token" && previous.raw === "/";
          if (selfClosing) {
            popFrame();
            finish(top, token);
          } else {
            top.jsxOpeningComplete = true;
            top.children.push(token);
          }
        } else if (top.jsxClosing) {
          popFrame();
          finish(top, token);
        } else {
          top.children.push(token);
        }
        continue;
      }
    }

    // JSX text is text, however it is spelled: an element's text written as a
    // `(` alone opens nothing, as one that holds more than the `(` does not.
    if (token.kind === "jsx-text") {
      append(token);
      continue;
    }
    const opener = ordinaryOpen.get(token.raw);
    if (opener !== undefined) {
      pushFrame({
        delimiter: opener,
        open: token,
        children: [],
        jsxOpeningComplete: false,
        jsxClosing: false,
        jsxTypeArguments: 0,
      });
      continue;
    }
    const closer = ordinaryClose.get(token.raw);
    if (closer !== undefined) {
      if (!closeMatching(closer, token)) unexpected(token);
      continue;
    }
    append(token);
  }

  const rootSpan = createSpan(0, source.length);
  const root = createRootSyntax({
    id: syntaxIds.allocate(),
    span: rootSpan,
    origin: origins.source(options.sourceId, rootSpan),
    scopes: options.scopes,
    children: rootChildren,
  });
  return Object.freeze({
    root,
    diagnostics: Object.freeze(diagnostics),
    origins,
    readings: scanned.readings,
    typescriptVersion: scanned.typescriptVersion,
  });
}
