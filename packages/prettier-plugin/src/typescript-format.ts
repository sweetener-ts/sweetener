import type { GroupSyntax, RootSyntax, Syntax } from "@sweetener/syntax";
import {
  formatSweetener,
  readSweetenerSyntax,
  type SweetenerFormatOptions,
} from "./format.js";

interface Mask {
  readonly marker: string;
  /**
   * What the marker looks like after Prettier has printed it.
   *
   * The import stand-in is written as an import-attributes clause, and
   * Prettier prints it under the project's own settings: `semi: false` drops
   * its semicolon and `singleQuote` rewrites its quotes. Searching for the
   * text as written then found nothing, restoration gave up, and the file came
   * back unformatted — for every file with a compile-time import in it, in any
   * project configured either of those ways.
   */
  readonly pattern: RegExp;
  readonly original: string;
  readonly start: number;
  readonly end: number;
}

function literalPattern(text: string): RegExp {
  return new RegExp(text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, "\\$&"), "gu");
}

interface TokenFingerprint {
  readonly kind: string;
  readonly raw: string;
}

function isMultilineJsxLayout(syntax: Syntax): boolean {
  return (
    syntax.tag === "token" &&
    syntax.kind === "jsx-text" &&
    /^[\t\n\r\u2028\u2029 ]+$/u.test(syntax.raw) &&
    /[\n\r\u2028\u2029]/u.test(syntax.raw)
  );
}

function jsxLayoutSpans(syntax: Syntax): readonly Syntax["span"][] {
  if (isMultilineJsxLayout(syntax)) return [syntax.span];
  switch (syntax.tag) {
    case "token":
      return [];
    case "group":
    case "protected":
    case "root":
      return syntax.children.flatMap(jsxLayoutSpans);
  }
}

function removeInsertedJsxLayout(
  source: string,
  before: RootSyntax,
  after: RootSyntax,
): string {
  // If the source has no JSX layout text, any such tokens in Prettier's output
  // came solely from line wrapping. Remove them so literal macro patterns see
  // the same tree. Existing JSX text is never rewritten or guessed at.
  if (jsxLayoutSpans(before).length > 0) return source;
  let result = source;
  for (const span of [...jsxLayoutSpans(after)].sort(
    (left, right) => right.start - left.start,
  ))
    result = result.slice(0, span.start) + result.slice(span.end);
  return result;
}

/**
 * Tokens that must survive formatting, in order.
 *
 * Every token counts, semicolons included. A semicolon is a real token to a
 * macro matcher, and a macro can match on one not being there: the
 * implicit-return example returns a function's final expression, and telling
 * it from an expression statement is exactly the absence of a `;`. Prettier
 * adding one there changes what the program means, so formatting that changes
 * any token is not applied.
 */
function tokenFingerprint(syntax: Syntax): readonly TokenFingerprint[] {
  switch (syntax.tag) {
    case "token":
      return [{ kind: syntax.kind, raw: syntax.raw }];
    case "group":
      return [
        { kind: syntax.open.kind, raw: syntax.open.raw },
        ...syntax.children.flatMap(tokenFingerprint),
        ...(syntax.close.tag === "token"
          ? [{ kind: syntax.close.kind, raw: syntax.close.raw }]
          : []),
      ];
    case "protected":
    case "root":
      return syntax.children.flatMap(tokenFingerprint);
  }
}

function preservesTokens(before: RootSyntax, after: RootSyntax): boolean {
  const left = tokenFingerprint(before);
  const right = tokenFingerprint(after);
  return (
    left.length === right.length &&
    left.every(
      (token, index) =>
        token.kind === right[index]?.kind && token.raw === right[index]?.raw,
    )
  );
}

/** The options that are set, so an absent one keeps Prettier's own default. */
function pick(
  options: SweetenerFormatOptions,
  keys: readonly (keyof SweetenerFormatOptions)[],
): Record<string, unknown> {
  const chosen: Record<string, unknown> = {};
  for (const key of keys)
    if (options[key] !== undefined) chosen[key] = options[key];
  return chosen;
}

/** Whether a node begins a line, which ends the statement before it. */
function startsNewLine(syntax: Syntax | undefined): boolean {
  if (syntax === undefined) return false;
  const first = syntax.tag === "group" ? syntax.open : syntax;
  return (
    first.tag === "token" &&
    first.leadingTrivia.some((trivia) => trivia.hasLineBreak)
  );
}

function tokenRaw(syntax: Syntax | undefined): string | undefined {
  return syntax?.tag === "token" ? syntax.raw : undefined;
}

function importedIdentifiers(group: GroupSyntax): readonly string[] {
  if (group.delimiter !== "brace") return [];
  return group.children.flatMap((child) =>
    child.tag === "token" && child.kind === "identifier" ? [child.raw] : [],
  );
}

function nextMarker(source: string, index: number): string {
  let suffix = index;
  for (;;) {
    const marker = `/*__SWEETENER_FORMAT_${String(suffix)}__*/`;
    if (!source.includes(marker)) return marker;
    suffix += 1;
  }
}

function nextBindingMarker(source: string, index: number): string {
  let suffix = index;
  for (;;) {
    // Short on purpose: a long stand-in changes where Prettier wraps the
    // import, and the wrap survives the shorter original going back in.
    const marker = `__sw${String(suffix)}__`;
    if (!source.includes(marker)) return marker;
    suffix += 1;
  }
}

/**
 * A binding that TypeScript cannot spell in an import clause.
 *
 * Sweetener imports a macro by whatever it is called, and two of the things it
 * can be called are not identifiers: an operator, written `(|>)`, and a core
 * form being shadowed, written `typeof`. Prettier parses what is left after
 * the compile-time tail is masked, and `import { (|>) }` is not TypeScript, so
 * it failed to parse and returned the file untouched — silently, and for the
 * headline example in the README among others.
 */
function unspellableBinding(syntax: Syntax): boolean {
  if (syntax.tag === "group") return syntax.delimiter === "parenthesis";
  return syntax.tag === "token" && syntax.kind === "keyword";
}

/** A mask whose marker Prettier prints back exactly as it was given. */
function textMask(
  marker: string,
  source: string,
  span: { readonly start: number; readonly end: number },
): Mask {
  return {
    marker,
    pattern: literalPattern(marker),
    original: source.slice(span.start, span.end),
    start: span.start,
    end: span.end,
  };
}

function maskSweetenerSyntax(
  source: string,
  root: RootSyntax,
): {
  readonly source: string;
  readonly masks: readonly Mask[];
} {
  const children = root.children;
  const imports = new Set<string>();
  const masks: Mask[] = [];

  for (let index = 0; index < children.length; index += 1) {
    if (tokenRaw(children[index]) !== "import") continue;
    let end = index + 1;
    // The import ends at its semicolon, or where the next line starts. It used
    // to look only for the semicolon, so a `for syntax` import written without
    // one — which the compiler accepts, as it does for any other statement —
    // was never masked, Prettier could not parse what it was handed, and the
    // whole file came back unformatted.
    for (
      ;
      end < children.length &&
      tokenRaw(children[end]) !== ";" &&
      !startsNewLine(children[end]);
      end += 1
    ) {
      const child = children[end];
      if (child?.tag === "group")
        for (const name of importedIdentifiers(child)) imports.add(name);
    }
    const terminator =
      tokenRaw(children[end]) === ";" ? children[end] : children[end - 1];
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (
        tokenRaw(children[cursor]) !== "for" ||
        tokenRaw(children[cursor + 1]) !== "syntax"
      )
        continue;
      const firstNode = children[cursor];
      const lastNode = terminator;
      if (firstNode === undefined || lastNode === undefined) continue;
      // Each binding Prettier could not read stands in as an identifier while
      // it formats, and goes back as written afterwards.
      const clause = children[index + 1];
      if (clause?.tag === "group" && clause.delimiter === "brace")
        for (const binding of clause.children)
          if (unspellableBinding(binding))
            masks.push(
              textMask(
                nextBindingMarker(source, masks.length),
                source,
                binding.span,
              ),
            );
      // The replacement keeps a semicolon whether or not the source had one:
      // it stands in for an import in a position where TypeScript expects a
      // statement, and the original text goes back verbatim afterwards.
      // Kept short for the same reason the binding stand-ins are: it occupies
      // the width of `for syntax;` while Prettier decides where to wrap.
      const name = `__swi${String(masks.length)}__`;
      const marker = `with { type: "${name}" };`;
      masks.push({
        marker,
        pattern: new RegExp(
          // Horizontal space only before the optional semicolon: \s* would
          // swallow the line break after it, and putting the original back
          // then joined the import to the statement below it.
          `with\\s*\\{\\s*type\\s*:\\s*['"]${name}['"]\\s*,?\\s*\\}[^\\S\\n]*;?`,
          "gu",
        ),
        original: source.slice(firstNode.span.start, lastNode.span.end),
        start: firstNode.span.start,
        end: lastNode.span.end,
      });
      break;
    }
    index = end;
  }

  const declarations = new Set([
    "abstract",
    "async",
    "class",
    "const",
    "enum",
    "function",
    "interface",
    "let",
    "namespace",
    "type",
    "var",
  ]);
  for (let index = 0; index + 1 < children.length; index += 1) {
    const prefix = children[index];
    const declaration = children[index + 1];
    if (
      prefix?.tag !== "token" ||
      !imports.has(prefix.raw) ||
      !declarations.has(tokenRaw(declaration) ?? "")
    )
      continue;
    masks.push(textMask(nextMarker(source, masks.length), source, prefix.span));
  }

  let masked = source;
  for (const mask of [...masks].sort((left, right) => right.start - left.start))
    masked = masked.slice(0, mask.start) + mask.marker + masked.slice(mask.end);
  return { source: masked, masks };
}

function restoreSweetenerSyntax(
  formatted: string,
  masks: readonly Mask[],
): string | undefined {
  let restored = formatted;
  for (const mask of masks) {
    mask.pattern.lastIndex = 0;
    const found = [...restored.matchAll(mask.pattern)];
    // Exactly one, or the text this puts back would land somewhere it was
    // never taken from.
    const match = found.length === 1 ? found[0] : undefined;
    if (match?.index === undefined) return undefined;
    restored =
      restored.slice(0, match.index) +
      mask.original +
      restored.slice(match.index + match[0].length);
  }
  return restored;
}

/**
 * The printing choices to try, in order.
 *
 * Prettier normalizes semicolons and quotes, and both are real tokens to a
 * macro matcher, so whichever the project asked for may be the one that
 * changes the program. Rather than tolerate the difference — the
 * implicit-return macro shows why that is not safe — the file is printed
 * again with the other choice and the result checked. A file already written
 * in the project's style is formatted on the first attempt; one written the
 * other way is formatted on a later one; a file mixing both, where no single
 * choice preserves every token, keeps its own layout.
 */
function printingAttempts(
  options: SweetenerFormatOptions,
): readonly SweetenerFormatOptions[] {
  const semi = options.semi ?? true;
  const singleQuote = options.singleQuote ?? false;
  return [
    options,
    { ...options, semi: !semi },
    { ...options, singleQuote: !singleQuote },
    { ...options, semi: !semi, singleQuote: !singleQuote },
  ];
}

export async function formatSweetenerWithPrettier(
  source: string,
  options: SweetenerFormatOptions = {},
): Promise<string> {
  const structurallyFormatted = formatSweetener(source, options);
  const root = readSweetenerSyntax(structurallyFormatted, options);
  const masked = maskSweetenerSyntax(structurallyFormatted, root);
  const [{ format }, typescriptPlugin, estreePlugin] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/estree"),
  ]);

  for (const attempt of printingAttempts(options)) {
    const printed = await printOnce(attempt);
    if (printed !== undefined) return printed;
  }
  return structurallyFormatted;

  /** One printing, or nothing when it did not survive the token check. */
  async function printOnce(
    attempt: SweetenerFormatOptions,
  ): Promise<string | undefined> {
    let formatted: string;
    try {
      formatted = await format(masked.source, {
        parser: "typescript",
        plugins: [typescriptPlugin, estreePlugin],
        // A trailing comma is a real token to a macro matcher. Prettier's
        // default (`all`) would therefore change which macro rules accept an
        // invocation even though it appears to be a layout-only operation.
        trailingComma: "none",
        // The project's own settings otherwise, so a `.sts` is formatted the
        // way every other file in the repository is.
        ...pick(attempt, [
          "filepath",
          "printWidth",
          "tabWidth",
          "useTabs",
          "semi",
          "singleQuote",
          "jsxSingleQuote",
          "quoteProps",
          "bracketSpacing",
          "bracketSameLine",
          "arrowParens",
          "endOfLine",
        ]),
      });
    } catch {
      return undefined;
    }
    const restored = restoreSweetenerSyntax(formatted, masked.masks);
    if (restored === undefined) return undefined;

    // Sweetener macros match token trees, so formatting may change trivia and
    // nothing else. This is what refuses a printing that would have changed
    // the program, whichever option produced it.
    const formattedRoot = readSweetenerSyntax(restored, options);
    const withoutInsertedJsxLayout = removeInsertedJsxLayout(
      restored,
      root,
      formattedRoot,
    );
    const safeRoot = readSweetenerSyntax(withoutInsertedJsxLayout, options);
    return preservesTokens(root, safeRoot)
      ? withoutInsertedJsxLayout
      : undefined;
  }
}
