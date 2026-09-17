import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findSweetenerDirective,
  type ScannerLanguageVariant,
} from "@sweetener/reader";

/**
 * How a source file opted into expansion and what the expander should produce
 * for it.
 *
 * Two opt-in mechanisms exist. A macro extension (`.sts`, `.sjs`, …) names a
 * file that is entirely owned by the expander and is rewritten to an ordinary
 * `.ts`/`.js` virtual file. A `"use sweetener"` directive opts in a file that
 * keeps its own name and extension; its virtual file shadows the file on disk.
 */
export interface SourceKind {
  /** Name the expanded file is presented to TypeScript under. */
  readonly virtualFileName: string;
  /** Lexical variant the reader scans the source with. */
  readonly variant: ScannerLanguageVariant;
  /** Whether the expansion output is checked and emitted as JavaScript. */
  readonly javascript: boolean;
  readonly optIn: "extension" | "directive";
}

/**
 * Extension of the virtual file produced for each supported macro extension.
 *
 * This is a closed table rather than a string transformation: an unrecognized
 * extension would produce a silently wrong virtual name, which would feed the
 * unexpanded macro source to TypeScript.
 */
const macroExtensionTargets = new Map<string, string>([
  [".sts", ".ts"],
  [".stsx", ".tsx"],
  [".sjs", ".js"],
  [".sjsx", ".jsx"],
]);

/** Macro extensions a project may list in `sweet.macroExtensions`. */
export const supportedMacroExtensions: readonly string[] = Object.freeze([
  ...macroExtensionTargets.keys(),
]);

/**
 * Extensions a `"use sweetener"` directive can opt in. TypeScript will not
 * accept a directive-marked file under any other extension, so recognizing one
 * here would only defer the failure.
 */
const directiveExtensions: readonly string[] = Object.freeze([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export function isSupportedMacroExtension(extension: string): boolean {
  return macroExtensionTargets.has(extension);
}

function extensionOf(fileName: string, candidates: readonly string[]) {
  // Longest match first so `.stsx` is never read as `.sts` plus a stray `x`.
  return [...candidates]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => fileName.endsWith(candidate));
}

function isJavaScriptExtension(extension: string): boolean {
  return [".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}

/**
 * Classify a file that an explicit `for syntax` import named.
 *
 * Such a file is a macro module by virtue of being imported as one, so it is
 * classified by extension alone and never needs a directive.
 */
export function importedMacroModuleKind(
  fileName: string,
  macroExtensions: readonly string[],
): SourceKind {
  const macroExtension = extensionOf(fileName, macroExtensions);
  const target =
    macroExtension === undefined
      ? undefined
      : macroExtensionTargets.get(macroExtension);
  if (macroExtension !== undefined && target !== undefined)
    return Object.freeze({
      virtualFileName: fileName.slice(0, -macroExtension.length) + target,
      variant: target.endsWith("x") ? "jsx" : "standard",
      javascript: isJavaScriptExtension(target),
      optIn: "extension",
    });
  const extension = extensionOf(fileName, directiveExtensions) ?? ".ts";
  return Object.freeze({
    virtualFileName: fileName,
    variant: extension.endsWith("x") ? "jsx" : "standard",
    javascript: isJavaScriptExtension(extension),
    optIn: "directive",
  });
}

/**
 * Classify a project file, or return undefined when it did not opt in.
 *
 * `readSource` is only called for files whose extension makes a directive
 * possible, so ordinary `.ts` project files still cost one read rather than a
 * parse.
 */
export function classifySource(options: {
  readonly fileName: string;
  readonly macroExtensions: readonly string[];
  readonly readSource: (fileName: string) => string | undefined;
}): SourceKind | undefined {
  const macroExtension = extensionOf(options.fileName, options.macroExtensions);
  if (macroExtension !== undefined) {
    const target = macroExtensionTargets.get(macroExtension);
    if (target === undefined)
      throw new Error(
        `Unsupported macro extension ${macroExtension}; expected one of ${supportedMacroExtensions.join(", ")}`,
      );
    return Object.freeze({
      virtualFileName:
        options.fileName.slice(0, -macroExtension.length) + target,
      variant: target.endsWith("x") ? "jsx" : "standard",
      javascript: isJavaScriptExtension(target),
      optIn: "extension",
    });
  }
  const extension = extensionOf(options.fileName, directiveExtensions);
  if (extension === undefined) return undefined;
  const source = options.readSource(options.fileName);
  if (source === undefined || findSweetenerDirective(source) === undefined)
    return undefined;
  return Object.freeze({
    // A directive-marked file keeps its name: the expanded text shadows the
    // file on disk, so imports of it and its emitted output path are unchanged.
    virtualFileName: options.fileName,
    variant: extension.endsWith("x") ? "jsx" : "standard",
    javascript: isJavaScriptExtension(extension),
    optIn: "directive",
  });
}

export interface SelectedSweetSource {
  /** File name as the project lists it, used to match TypeScript root names. */
  readonly fileName: string;
  readonly kind: SourceKind;
}

/**
 * Project files that opted into expansion, by macro extension or by a
 * `"use sweetener"` directive.
 *
 * Both the expander and the project command need this list and must agree on
 * it: the expander decides which files to produce, and the project command
 * substitutes the produced virtual file for each source in the root names.
 */
export function selectSweetSources(project: {
  readonly fileNames: readonly string[];
  readonly macroExtensions: readonly string[];
}): readonly SelectedSweetSource[] {
  return Object.freeze(
    project.fileNames.flatMap((fileName) => {
      const kind = classifySource({
        fileName: resolve(fileName),
        macroExtensions: project.macroExtensions,
        readSource: (candidate) => {
          try {
            return readFileSync(candidate, "utf8");
          } catch {
            // A listed file that cannot be read did not opt in; TypeScript
            // reports the missing file itself.
            return undefined;
          }
        },
      });
      return kind === undefined ? [] : [Object.freeze({ fileName, kind })];
    }),
  );
}
