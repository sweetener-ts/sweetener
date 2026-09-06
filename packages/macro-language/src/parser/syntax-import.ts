import type { Diagnostic, OriginId, SourceId } from "@sweetener/shared";
import type {
  GroupSyntax,
  RootSyntax,
  Syntax,
  TokenSyntax,
} from "@sweetener/syntax";
import {
  macroLanguageDiagnosticRegistry,
  malformedSyntaxImportCode,
} from "./diagnostics.js";

export interface CompileTimeImportBinding {
  readonly imported: string;
  readonly local: string;
  readonly origin: OriginId;
}

export interface CompileTimeSyntaxImport {
  readonly specifier: string;
  readonly bindings: readonly CompileTimeImportBinding[];
  readonly shadowsCore: boolean;
  readonly origin: OriginId;
  readonly span: { readonly start: number; readonly end: number };
}

export interface ParseCompileTimeSyntaxImportsResult {
  readonly imports: readonly CompileTimeSyntaxImport[];
  readonly diagnostics: readonly Diagnostic[];
}

function token(node: Syntax | undefined, raw?: string): node is TokenSyntax {
  return node?.tag === "token" && (raw === undefined || node.raw === raw);
}

function word(node: Syntax | undefined): node is TokenSyntax {
  return token(node) && (node.kind === "identifier" || node.kind === "keyword");
}

function namedGroup(node: Syntax | undefined): node is GroupSyntax {
  return node?.tag === "group" && node.delimiter === "brace";
}

/**
 * Whether an import with no semicolon after it ends here anyway.
 *
 * Every other statement may end at a line break, and a compile-time import
 * that insisted on a semicolon could not be written at all in a project that
 * does without them — which the default Vite template is, so the first import
 * anyone wrote in one was rejected.
 */
function automaticTerminator(node: Syntax | undefined): boolean {
  if (node === undefined) return true;
  const first = node.tag === "group" ? node.open : node;
  if (first.tag !== "token") return false;
  if (first.kind === "end-of-file") return true;
  return first.leadingTrivia.some((trivia) => trivia.hasLineBreak);
}

function importName(
  node: Syntax | undefined,
): { readonly value: string; readonly origin: OriginId } | undefined {
  if (word(node)) return { value: node.raw, origin: node.origin };
  if (node?.tag !== "group" || node.delimiter !== "parenthesis")
    return undefined;
  const value = node.children
    .filter((child): child is TokenSyntax => child.tag === "token")
    .map(({ raw }) => raw)
    .join("");
  return value.length === 0 ? undefined : { value, origin: node.origin };
}

function parseBindings(
  group: GroupSyntax,
): readonly CompileTimeImportBinding[] | undefined {
  const nodes = group.children.filter(
    (node) => !token(node) || node.kind !== "end-of-file",
  );
  const bindings: CompileTimeImportBinding[] = [];
  let index = 0;
  while (index < nodes.length) {
    const imported = importName(nodes[index]);
    if (imported === undefined) return undefined;
    index += 1;
    let local = imported;
    if (token(nodes[index], "as")) {
      const alias = importName(nodes[index + 1]);
      if (alias === undefined) return undefined;
      local = alias;
      index += 2;
    }
    const importedIsSymbolic =
      !/^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(
        imported.value,
      );
    if (importedIsSymbolic && local.value !== imported.value) return undefined;
    bindings.push(
      Object.freeze({
        imported: imported.value,
        local: local.value,
        origin: local.origin,
      }),
    );
    if (index === nodes.length) break;
    if (!token(nodes[index], ",")) return undefined;
    index += 1;
    if (index === nodes.length) break;
  }
  return Object.freeze(bindings);
}

export function parseCompileTimeSyntaxImports(
  root: RootSyntax,
  options: { readonly sourceId: SourceId },
): ParseCompileTimeSyntaxImportsResult {
  const imports: CompileTimeSyntaxImport[] = [];
  const diagnostics: Diagnostic[] = [];
  const nodes = root.children;
  for (let index = 0; index < nodes.length; index += 1) {
    const start = nodes[index];
    if (!token(start, "import")) continue;
    const names = nodes[index + 1];
    const from = nodes[index + 2];
    const specifier = nodes[index + 3];
    const forKeyword = nodes[index + 4];
    const syntaxKeyword = nodes[index + 5];
    const shadowsKeyword = nodes[index + 6];
    const coreKeyword = nodes[index + 7];
    const shadowsCore =
      token(shadowsKeyword, "shadows") && token(coreKeyword, "core");
    const width = shadowsCore ? 8 : 6;
    const terminator = nodes[index + width];
    const semicolon = token(terminator, ";") ? terminator : undefined;
    const terminated =
      semicolon !== undefined || automaticTerminator(terminator);
    // Where the import ends when nothing terminates it explicitly.
    const lastWord = shadowsCore ? coreKeyword : syntaxKeyword;
    const isSyntaxImport =
      token(forKeyword, "for") || token(syntaxKeyword, "syntax");
    if (!isSyntaxImport) continue;
    const bindings = namedGroup(names) ? parseBindings(names) : undefined;
    if (
      bindings === undefined ||
      bindings.length === 0 ||
      !token(from, "from") ||
      !token(specifier) ||
      specifier.kind !== "string-literal" ||
      typeof specifier.value !== "string" ||
      !token(forKeyword, "for") ||
      !token(syntaxKeyword, "syntax") ||
      !terminated
    ) {
      diagnostics.push(
        macroLanguageDiagnosticRegistry.create(malformedSyntaxImportCode, {
          primaryOrigin: {
            sourceId: options.sourceId,
            start: start.span.start,
            end: (terminator ?? syntaxKeyword ?? start).span.end,
            originId: start.origin,
          },
          messageArguments: [
            "expected named bindings, module string, `for syntax`, and optional `shadows core`",
          ],
        }),
      );
      continue;
    }
    imports.push(
      Object.freeze({
        specifier: specifier.value,
        bindings,
        shadowsCore,
        origin: start.origin,
        span: Object.freeze({
          start: start.span.start,
          end: (semicolon ?? lastWord ?? start).span.end,
        }),
      }),
    );
    index += semicolon === undefined ? width - 1 : width;
  }
  return Object.freeze({
    imports: Object.freeze(imports),
    diagnostics: Object.freeze(diagnostics),
  });
}
