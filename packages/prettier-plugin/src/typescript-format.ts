import type { GroupSyntax, RootSyntax, Syntax } from "@sweetener/syntax";
import {
  formatSweetener,
  readSweetenerSyntax,
  type SweetenerFormatOptions,
} from "./format.js";

interface Mask {
  readonly marker: string;
  readonly original: string;
  readonly start: number;
  readonly end: number;
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
 * A semicolon standing between statements is left out. Prettier inserts them
 * where the source relied on automatic insertion, and treating that as a token
 * change meant any file written without semicolons failed this guard and was
 * handed back exactly as it came in — the whole file unformatted, reported as
 * already correct. Only semicolons directly inside a root or a brace group are
 * ignored, so one inside an invocation's arguments, a `for` header, or any
 * other delimiter still counts: those are tokens a macro can match on.
 */
function tokenFingerprint(
  syntax: Syntax,
  betweenStatements = false,
): readonly TokenFingerprint[] {
  switch (syntax.tag) {
    case "token":
      if (betweenStatements && syntax.raw === ";") return [];
      return [{ kind: syntax.kind, raw: syntax.raw }];
    case "group": {
      const inStatements = syntax.delimiter === "brace";
      return [
        { kind: syntax.open.kind, raw: syntax.open.raw },
        ...syntax.children.flatMap((child) =>
          tokenFingerprint(child, inStatements),
        ),
        ...(syntax.close.tag === "token"
          ? [{ kind: syntax.close.kind, raw: syntax.close.raw }]
          : []),
      ];
    }
    case "protected":
      return syntax.children.flatMap((child) =>
        tokenFingerprint(child, betweenStatements),
      );
    case "root":
      return syntax.children.flatMap((child) => tokenFingerprint(child, true));
  }
}

/**
 * Whether two string literals differ only in which quote character encloses
 * them. Prettier normalizes quotes to whatever the project configured, and
 * counting that as a changed token left every file containing a single-quoted
 * string — the default in a great many projects — completely unformatted.
 * The text between the quotes still has to match exactly.
 */
function sameStringExceptQuotes(left: string, right: string): boolean {
  const quoted = /^(['"])(.*)\1$/su;
  const before = quoted.exec(left);
  const after = quoted.exec(right);
  if (before === null || after === null) return false;
  const unescape = (text: string, quote: string) =>
    text.replaceAll(`\\${quote}`, quote);
  return (
    unescape(before[2]!, before[1]!) === unescape(after[2]!, after[1]!) &&
    !before[2]!.includes("\\") === !after[2]!.includes("\\")
  );
}

function sameToken(
  left: TokenFingerprint,
  right: TokenFingerprint | undefined,
): boolean {
  if (right === undefined || left.kind !== right.kind) return false;
  if (left.raw === right.raw) return true;
  return (
    left.kind === "string-literal" &&
    sameStringExceptQuotes(left.raw, right.raw)
  );
}

function preservesTokens(before: RootSyntax, after: RootSyntax): boolean {
  const left = tokenFingerprint(before);
  const right = tokenFingerprint(after);
  return (
    left.length === right.length &&
    left.every((token, index) => sameToken(token, right[index]))
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
    for (; end < children.length && tokenRaw(children[end]) !== ";"; end += 1) {
      const child = children[end];
      if (child?.tag === "group")
        for (const name of importedIdentifiers(child)) imports.add(name);
    }
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (
        tokenRaw(children[cursor]) !== "for" ||
        tokenRaw(children[cursor + 1]) !== "syntax"
      )
        continue;
      const firstNode = children[cursor];
      const lastNode = children[end];
      if (firstNode === undefined || lastNode === undefined) continue;
      const marker = `with { type: "__SWEETENER_FORMAT_IMPORT_${String(
        masks.length,
      )}__" };`;
      masks.push({
        marker,
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
    masks.push({
      marker: nextMarker(source, masks.length),
      original: prefix.raw,
      start: prefix.span.start,
      end: prefix.span.end,
    });
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
    const first = restored.indexOf(mask.marker);
    if (first < 0 || restored.indexOf(mask.marker, first + 1) >= 0)
      return undefined;
    restored =
      restored.slice(0, first) +
      mask.original +
      restored.slice(first + mask.marker.length);
  }
  return restored;
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

  try {
    const formatted = await format(masked.source, {
      parser: "typescript",
      plugins: [typescriptPlugin, estreePlugin],
      // A trailing comma is a real token to a macro matcher. Prettier's
      // default (`all`) would therefore change which macro rules accept an
      // invocation even though it appears to be a layout-only operation.
      trailingComma: "none",
      // The project's own Prettier settings. Only `trailingComma` is pinned,
      // for the reason above; forwarding nothing else meant a `.sts` was
      // formatted to Prettier's defaults no matter what the repository had
      // configured, so `semi: false` or `singleQuote: true` applied to every
      // file except these.
      ...pick(options, [
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
    const restored = restoreSweetenerSyntax(formatted, masked.masks);
    if (restored === undefined) return structurallyFormatted;

    // Sweetener macros match token trees, so formatting is allowed to change
    // trivia only. Guard against every other token-generating Prettier option
    // too (quote normalization, inserted parentheses, semicolons, and future
    // printer changes), rather than relying on a growing list of exceptions.
    const formattedRoot = readSweetenerSyntax(restored, options);
    const withoutInsertedJsxLayout = removeInsertedJsxLayout(
      restored,
      root,
      formattedRoot,
    );
    const safeRoot = readSweetenerSyntax(withoutInsertedJsxLayout, options);
    return preservesTokens(root, safeRoot)
      ? withoutInsertedJsxLayout
      : structurallyFormatted;
  } catch {
    return structurallyFormatted;
  }
}
