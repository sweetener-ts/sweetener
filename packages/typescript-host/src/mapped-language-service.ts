import type { OriginQueryIndex, PrintedExpandedFile } from "@sweetener/printer";
import { resolve } from "node:path";
import type { BindingId, SourceId, SourceSpan } from "@sweetener/shared";
import type { OriginStore } from "@sweetener/syntax";
import * as ts from "typescript";
import { remapTypeScriptDiagnostic } from "./diagnostic-remap.js";
import {
  heldSentenceAnswers,
  nameTypeScriptNamed,
  typescriptChecks,
} from "./held-names.js";
import type { RemappedTypeScriptDiagnostic } from "./diagnostic-remap.js";
import type { VirtualLanguageServiceProject } from "./language-service-host.js";

export interface LanguageServiceSourceMapping {
  readonly sourceFileName: string;
  readonly sourceId: SourceId;
  readonly virtualFileName: string;
  readonly printed: PrintedExpandedFile;
  readonly index: OriginQueryIndex;
  readonly origins: OriginStore;
  readonly bindingAtGenerated?:
    ((generatedOffset: number) => BindingId | undefined) | undefined;
  /**
   * What expansion says about the source, which TypeScript cannot. Without it
   * an editor shows `Cannot find name` where the command line names the
   * macro, and nothing at all where expansion itself failed or warned.
   */
  readonly expansion?: LanguageServiceExpansion | undefined;
}

/** What expansion says about one source, positioned in that source. */
export interface LanguageServiceExpansion {
  /** What it reported about the source: its errors and its warnings. */
  readonly diagnostics: readonly ts.Diagnostic[];
  /**
   * The sentences it holds about names it left standing, each with the name
   * it is about. Where TypeScript checks the source, one is said where
   * TypeScript reports that name at that place, in place of what TypeScript
   * said; elsewhere TypeScript found the name, and nothing is said.
   */
  readonly heldNames: readonly {
    readonly name: string;
    readonly diagnostic: ts.Diagnostic;
  }[];
  /**
   * The same sentences as warnings, said as they stand where TypeScript does
   * not check the source -- unchecked JavaScript, `// @ts-nocheck`, `noCheck`
   * -- since nothing there will ever report the name.
   */
  readonly heldWarnings: readonly ts.Diagnostic[];
}

export interface MappedQuickInfo {
  readonly kind: ts.ScriptElementKind;
  readonly kindModifiers: string;
  readonly textSpan: SourceSpan | undefined;
  readonly displayParts: readonly ts.SymbolDisplayPart[];
  readonly documentation: readonly ts.SymbolDisplayPart[];
  readonly tags: readonly ts.JSDocTagInfo[];
  readonly generatedFileName: string;
  readonly generatedTextSpan: ts.TextSpan;
  readonly expansionView: boolean;
}

export interface MappedDefinition {
  readonly name: string;
  readonly kind: ts.ScriptElementKind;
  readonly source: SourceSpan | undefined;
  readonly generatedFileName: string;
  readonly generatedTextSpan: ts.TextSpan;
  readonly expansionView: boolean;
  readonly sourceFileName: string | undefined;
}

export interface MappedReference {
  readonly source: SourceSpan | undefined;
  readonly sourceFileName: string | undefined;
  readonly generatedFileName: string;
  readonly generatedTextSpan: ts.TextSpan;
  readonly isDefinition: boolean;
  readonly isWriteAccess: boolean;
  readonly expansionView: boolean;
}

export interface MappedCompletion {
  readonly name: string;
  readonly kind: ts.ScriptElementKind;
  readonly kindModifiers: string;
  readonly sortText: string;
  readonly insertText: string | undefined;
  readonly isSnippet: boolean;
  readonly replacementSpan: SourceSpan | undefined;
  readonly expansionView: boolean;
}

export interface MappedCompletions {
  readonly isGlobalCompletion: boolean;
  readonly isMemberCompletion: boolean;
  readonly isNewIdentifierLocation: boolean;
  readonly entries: readonly MappedCompletion[];
}

export type MappedRenameResult =
  | {
      readonly canRename: false;
      readonly reason: string;
      readonly expansionView: boolean;
    }
  | {
      readonly canRename: true;
      readonly displayName: string;
      readonly fullDisplayName: string;
      readonly kind: ts.ScriptElementKind;
      readonly locations: readonly MappedReference[];
    };

function canonical(fileName: string): string {
  return resolve(fileName).replaceAll("\\", "/");
}

function sourceSpanForTextSpan(
  mapping: LanguageServiceSourceMapping,
  generatedSpan: ts.TextSpan,
): SourceSpan | undefined {
  const start = mapping.index.generatedToOriginal(generatedSpan.start)[0];
  if (start === undefined) return undefined;
  if (generatedSpan.length === 0) {
    return Object.freeze({
      sourceId: start.primary.sourceId,
      start: start.projectedOriginalOffset,
      end: start.projectedOriginalOffset,
      originId: start.origin,
    });
  }
  const end = mapping.index.generatedToOriginal(
    generatedSpan.start + generatedSpan.length - 1,
  )[0];
  return Object.freeze({
    sourceId: start.primary.sourceId,
    start: start.projectedOriginalOffset,
    end:
      end?.primary.sourceId === start.primary.sourceId
        ? Math.min(end.projectedOriginalOffset + 1, end.primary.span.end)
        : Math.min(start.projectedOriginalOffset + 1, start.primary.span.end),
    originId: start.origin,
  });
}

/**
 * A diagnostic expansion reported, in the shape the language service reports
 * TypeScript's in, for the source `mapping` maps. It is already in source
 * coordinates, so it is mapped through nothing.
 *
 * Not every one is about that source: a macro module's errors stop the macros
 * a file reads from it, so the file reports them too, and they are positioned
 * in the module. Placed in the file at the module's offset, one pointed at
 * unrelated text, or past the end. It is reported against the file as a
 * whole, saying where in the module it was raised, and points there.
 */
function sourceDiagnostic(
  mapping: LanguageServiceSourceMapping,
  diagnostic: ts.Diagnostic,
): RemappedTypeScriptDiagnostic {
  const messageText = ts.flattenDiagnosticMessageText(
    diagnostic.messageText,
    "\n",
  );
  const related = [...(diagnostic.relatedInformation ?? [])];
  const elsewhere =
    diagnostic.file !== undefined &&
    canonical(diagnostic.file.fileName) !== canonical(mapping.sourceFileName);
  if (elsewhere) {
    const file = diagnostic.file!;
    const at =
      diagnostic.start === undefined
        ? ""
        : (() => {
            const { line, character } = ts.getLineAndCharacterOfPosition(
              file,
              diagnostic.start,
            );
            return `:${String(line + 1)}:${String(character + 1)}`;
          })();
    return Object.freeze({
      typescriptCode: diagnostic.code,
      category: diagnostic.category,
      messageText: `${messageText} (raised in ${file.fileName}${at})`,
      primaryOrigin: undefined,
      relatedOrigins: Object.freeze([]),
      expansionStack: Object.freeze([]),
      generatedStart: undefined,
      generatedLength: undefined,
      typescriptRelatedInformation: Object.freeze([
        Object.freeze({
          category: ts.DiagnosticCategory.Message,
          code: diagnostic.code,
          file,
          start: diagnostic.start,
          length: diagnostic.length,
          messageText: "Where it was raised",
        }),
        ...related,
      ]),
    });
  }
  return Object.freeze({
    typescriptCode: diagnostic.code,
    category: diagnostic.category,
    messageText,
    primaryOrigin:
      diagnostic.start === undefined
        ? undefined
        : Object.freeze({
            sourceId: mapping.sourceId,
            start: diagnostic.start,
            end: diagnostic.start + (diagnostic.length ?? 0),
          }),
    relatedOrigins: Object.freeze([]),
    expansionStack: Object.freeze([]),
    generatedStart: undefined,
    generatedLength: undefined,
    typescriptRelatedInformation: Object.freeze(related),
  });
}

export class MappedLanguageService {
  readonly #project: VirtualLanguageServiceProject;
  readonly #bySource = new Map<string, LanguageServiceSourceMapping>();
  readonly #byVirtual = new Map<string, LanguageServiceSourceMapping>();

  constructor(
    project: VirtualLanguageServiceProject,
    mappings: readonly LanguageServiceSourceMapping[] = [],
  ) {
    this.#project = project;
    for (const mapping of mappings) this.setMapping(mapping);
  }

  setMapping(mapping: LanguageServiceSourceMapping): void {
    if (
      this.#project.generatedFor(mapping.virtualFileName)?.text !==
      mapping.printed.text
    )
      throw new RangeError(
        "Language-service mapping does not match virtual text",
      );
    const sourceKey = canonical(mapping.sourceFileName);
    const virtualKey = canonical(mapping.virtualFileName);
    const previousSource = this.#bySource.get(sourceKey);
    if (previousSource !== undefined)
      this.#byVirtual.delete(canonical(previousSource.virtualFileName));
    const previousVirtual = this.#byVirtual.get(virtualKey);
    if (previousVirtual !== undefined)
      this.#bySource.delete(canonical(previousVirtual.sourceFileName));
    const frozen = Object.freeze({ ...mapping });
    this.#bySource.set(sourceKey, frozen);
    this.#byVirtual.set(virtualKey, frozen);
  }

  diagnostics(sourceFileName: string): readonly RemappedTypeScriptDiagnostic[] {
    const mapping = this.#bySource.get(canonical(sourceFileName));
    if (mapping === undefined) return Object.freeze([]);
    const diagnostics = [
      ...this.#project.languageService.getSyntacticDiagnostics(
        mapping.virtualFileName,
      ),
      ...this.#project.languageService.getSemanticDiagnostics(
        mapping.virtualFileName,
      ),
    ];
    const remapped = diagnostics.map((diagnostic) =>
      remapTypeScriptDiagnostic({
        diagnostic,
        generated: mapping.printed,
        origins: mapping.origins,
        expansionFrames: (origin) =>
          mapping.index.regions().find((region) => region.origin === origin)
            ?.expansionStack ?? [],
      }),
    );
    const { expansion } = mapping;
    if (expansion === undefined) return Object.freeze(remapped);
    const inSource = (diagnostic: ts.Diagnostic) =>
      sourceDiagnostic(mapping, diagnostic);
    const program = this.#project.languageService.getProgram();
    const virtual = program?.getSourceFile(mapping.virtualFileName);
    if (program === undefined || virtual === undefined)
      throw new Error(
        `The language service holds no program with ${mapping.virtualFileName}, which it reported diagnostics for`,
      );
    // Where TypeScript does not check the file it reports no name, so nothing
    // would ask for a held sentence: each is said as a warning instead.
    if (!typescriptChecks(virtual, program.getCompilerOptions()))
      return Object.freeze([
        ...remapped,
        ...expansion.diagnostics.map(inSource),
        ...expansion.heldWarnings.map(inSource),
      ]);
    return Object.freeze([
      ...remapped.map((diagnostic) => {
        const name = nameTypeScriptNamed(
          diagnostic.typescriptCode,
          diagnostic.messageText,
        );
        const at = diagnostic.primaryOrigin;
        if (name === undefined || at?.sourceId !== mapping.sourceId)
          return diagnostic;
        const held = expansion.heldNames.find(
          (candidate) =>
            candidate.name === name &&
            candidate.diagnostic.start === at.start &&
            heldSentenceAnswers(
              diagnostic.typescriptCode,
              candidate.diagnostic.code,
            ),
        );
        return held === undefined ? diagnostic : inSource(held.diagnostic);
      }),
      ...expansion.diagnostics.map(inSource),
    ]);
  }

  quickInfo(
    sourceFileName: string,
    originalOffset: number,
  ): MappedQuickInfo | undefined {
    const mapping = this.#bySource.get(canonical(sourceFileName));
    if (mapping === undefined) return undefined;
    const generated = mapping.index.originalToGenerated(
      mapping.sourceId,
      originalOffset,
    )[0];
    if (generated === undefined) return undefined;
    const info = this.#project.languageService.getQuickInfoAtPosition(
      mapping.virtualFileName,
      generated.projectedGeneratedOffset,
    );
    if (info === undefined) return undefined;
    const textSpan = sourceSpanForTextSpan(mapping, info.textSpan);
    return Object.freeze({
      kind: info.kind,
      kindModifiers: info.kindModifiers,
      textSpan,
      displayParts: Object.freeze([...(info.displayParts ?? [])]),
      documentation: Object.freeze([...(info.documentation ?? [])]),
      tags: Object.freeze([...(info.tags ?? [])]),
      generatedFileName: mapping.virtualFileName,
      generatedTextSpan: info.textSpan,
      expansionView: textSpan === undefined,
    });
  }

  definitions(
    sourceFileName: string,
    originalOffset: number,
  ): readonly MappedDefinition[] {
    const mapping = this.#bySource.get(canonical(sourceFileName));
    if (mapping === undefined) return Object.freeze([]);
    const generated = mapping.index.originalToGenerated(
      mapping.sourceId,
      originalOffset,
    )[0];
    if (generated === undefined) return Object.freeze([]);
    const definitions =
      this.#project.languageService.getDefinitionAtPosition(
        mapping.virtualFileName,
        generated.projectedGeneratedOffset,
      ) ?? [];
    return Object.freeze(
      definitions.map((definition) => {
        const target = this.#byVirtual.get(canonical(definition.fileName));
        const source =
          target === undefined
            ? undefined
            : sourceSpanForTextSpan(target, definition.textSpan);
        return Object.freeze({
          name: definition.name,
          kind: definition.kind,
          source,
          generatedFileName: definition.fileName,
          generatedTextSpan: definition.textSpan,
          expansionView: target !== undefined && source === undefined,
          sourceFileName:
            target === undefined ? definition.fileName : target.sourceFileName,
        });
      }),
    );
  }

  references(
    sourceFileName: string,
    originalOffset: number,
  ): readonly MappedReference[] {
    const position = this.#generatedPosition(sourceFileName, originalOffset);
    if (position === undefined) return Object.freeze([]);
    const references =
      this.#project.languageService.getReferencesAtPosition(
        position.mapping.virtualFileName,
        position.offset,
      ) ?? [];
    // A macro can copy one written occurrence into several generated ones. The
    // editor lists what the author wrote, so the copies collapse back into the
    // single span they came from, and that span is a definition or a write if
    // any copy of it is.
    const bySpan = new Map<string, MappedReference>();
    for (const reference of references) {
      const mapped = this.#mapReference(reference);
      const key =
        mapped.source === undefined
          ? `generated:${canonical(mapped.generatedFileName)}:${String(mapped.generatedTextSpan.start)}`
          : `source:${String(mapped.source.sourceId)}:${String(mapped.source.start)}:${String(mapped.source.end)}`;
      const previous = bySpan.get(key);
      bySpan.set(
        key,
        previous === undefined
          ? mapped
          : Object.freeze({
              ...previous,
              isDefinition: previous.isDefinition || mapped.isDefinition,
              isWriteAccess: previous.isWriteAccess || mapped.isWriteAccess,
            }),
      );
    }
    return Object.freeze([...bySpan.values()]);
  }

  completions(
    sourceFileName: string,
    originalOffset: number,
  ): MappedCompletions | undefined {
    const position = this.#generatedPosition(
      sourceFileName,
      originalOffset,
      true,
    );
    if (position === undefined) return undefined;
    const result = this.#project.languageService.getCompletionsAtPosition(
      position.mapping.virtualFileName,
      position.offset,
      { includeCompletionsWithInsertText: true },
    );
    if (result === undefined) return undefined;
    return Object.freeze({
      isGlobalCompletion: result.isGlobalCompletion,
      isMemberCompletion: result.isMemberCompletion,
      isNewIdentifierLocation: result.isNewIdentifierLocation,
      entries: Object.freeze(
        result.entries.map((entry) => {
          const generatedSpan =
            entry.replacementSpan ?? result.optionalReplacementSpan;
          const replacementSpan =
            generatedSpan === undefined
              ? undefined
              : sourceSpanForTextSpan(position.mapping, generatedSpan);
          return Object.freeze({
            name: entry.name,
            kind: entry.kind,
            kindModifiers: entry.kindModifiers ?? "",
            sortText: entry.sortText,
            insertText: entry.insertText,
            isSnippet: entry.isSnippet ?? false,
            replacementSpan,
            expansionView:
              generatedSpan !== undefined && replacementSpan === undefined,
          });
        }),
      ),
    });
  }

  rename(sourceFileName: string, originalOffset: number): MappedRenameResult {
    const position = this.#generatedPosition(sourceFileName, originalOffset);
    if (position === undefined)
      return Object.freeze({
        canRename: false,
        reason: "The source position has no generated TypeScript location.",
        expansionView: false,
      });
    const occurrences = position.mapping.index.originalToGenerated(
      position.mapping.sourceId,
      originalOffset,
    );
    const signatures = new Set<string>();
    for (const occurrence of occurrences) {
      const occurrenceLocations =
        this.#project.languageService.findRenameLocations(
          position.mapping.virtualFileName,
          occurrence.projectedGeneratedOffset,
          false,
          false,
          true,
        ) ?? [];
      signatures.add(
        occurrenceLocations
          .map(
            ({ fileName, textSpan }) =>
              `${canonical(fileName)}:${String(textSpan.start)}:${String(textSpan.length)}`,
          )
          .sort()
          .join("|"),
      );
    }
    if (signatures.size > 1)
      return this.#renameRefusal(
        "Repeated source occurrences resolve to distinct TypeScript bindings.",
        true,
      );
    const info = this.#project.languageService.getRenameInfo(
      position.mapping.virtualFileName,
      position.offset,
    );
    if (!info.canRename)
      return Object.freeze({
        canRename: false,
        reason: info.localizedErrorMessage,
        expansionView: false,
      });
    const locations =
      this.#project.languageService.findRenameLocations(
        position.mapping.virtualFileName,
        position.offset,
        false,
        false,
        true,
      ) ?? [];
    const expectedBinding = position.mapping.bindingAtGenerated?.(
      position.offset,
    );
    const mapped = new Map<string, MappedReference>();
    for (const location of locations) {
      const target = this.#byVirtual.get(canonical(location.fileName));
      if (target === undefined)
        return this.#renameRefusal(
          "Rename reaches a file without macro origin metadata.",
          false,
        );
      const region = target.index.generatedToOriginal(
        location.textSpan.start,
      )[0];
      const source = sourceSpanForTextSpan(target, location.textSpan);
      if (region === undefined || source === undefined)
        return this.#renameRefusal(
          "Rename reaches generated-only syntax; edit it in the expansion view.",
          true,
        );
      const originKind = target.origins.get(region.origin)?.kind;
      if (originKind !== "source" && originKind !== "copied")
        return this.#renameRefusal(
          `Rename crosses an unsafe ${originKind ?? "unknown"} macro boundary.`,
          true,
        );
      const binding = target.bindingAtGenerated?.(location.textSpan.start);
      if (originKind === "copied" && binding === undefined)
        return this.#renameRefusal(
          "A captured macro reference has no binding identity proof.",
          true,
        );
      if (
        expectedBinding !== undefined &&
        binding !== undefined &&
        binding !== expectedBinding
      )
        return this.#renameRefusal(
          "Rename would merge distinct hygienic bindings.",
          true,
        );
      const reference = this.#mapReference(location);
      const key = `${String(source.sourceId)}:${String(source.start)}:${String(source.end)}`;
      mapped.set(key, reference);
    }
    return Object.freeze({
      canRename: true,
      displayName: info.displayName,
      fullDisplayName: info.fullDisplayName,
      kind: info.kind,
      locations: Object.freeze([...mapped.values()]),
    });
  }

  #generatedPosition(
    sourceFileName: string,
    originalOffset: number,
    allowBoundary = false,
  ) {
    const mapping = this.#bySource.get(canonical(sourceFileName));
    if (mapping === undefined) return undefined;
    const generated = mapping.index.originalToGenerated(
      mapping.sourceId,
      originalOffset,
    )[0];
    if (generated !== undefined)
      return { mapping, offset: generated.projectedGeneratedOffset };
    if (!allowBoundary || originalOffset === 0) return undefined;
    const previous = mapping.index.originalToGenerated(
      mapping.sourceId,
      originalOffset - 1,
    )[0];
    return previous !== undefined &&
      previous.primary.span.end === originalOffset
      ? {
          mapping,
          offset: Math.min(
            previous.projectedGeneratedOffset + 1,
            previous.generatedEnd,
          ),
        }
      : undefined;
  }

  #mapReference(
    reference: Pick<ts.ReferenceEntry, "fileName" | "textSpan"> &
      Partial<Pick<ts.ReferenceEntry, "isWriteAccess">> & {
        readonly isDefinition?: boolean | undefined;
      },
  ): MappedReference {
    const target = this.#byVirtual.get(canonical(reference.fileName));
    const source =
      target === undefined
        ? undefined
        : sourceSpanForTextSpan(target, reference.textSpan);
    return Object.freeze({
      source,
      sourceFileName:
        target === undefined ? reference.fileName : target.sourceFileName,
      generatedFileName: reference.fileName,
      generatedTextSpan: reference.textSpan,
      isDefinition: reference.isDefinition ?? false,
      isWriteAccess: reference.isWriteAccess ?? false,
      expansionView: target !== undefined && source === undefined,
    });
  }

  #renameRefusal(reason: string, expansionView: boolean): MappedRenameResult {
    return Object.freeze({ canRename: false, reason, expansionView });
  }
}
