import type { OriginQueryIndex, PrintedExpandedFile } from "@sweetener/printer";
import { resolve } from "node:path";
import type { BindingId, SourceId, SourceSpan } from "@sweetener/shared";
import type { OriginStore } from "@sweetener/syntax";
import ts from "typescript";
import { remapTypeScriptDiagnostic } from "./diagnostic-remap.js";
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
  readonly source: string | undefined;
  readonly replacementSpan: SourceSpan | undefined;
  readonly expansionView: boolean;
}

export interface MappedDocumentSymbol {
  readonly name: string;
  readonly kind: ts.ScriptElementKind;
  readonly source: SourceSpan;
  readonly children: readonly MappedDocumentSymbol[];
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
    return Object.freeze(
      diagnostics.map((diagnostic) =>
        remapTypeScriptDiagnostic({
          diagnostic,
          generated: mapping.printed,
          origins: mapping.origins,
          expansionFrames: (origin) =>
            mapping.index.regions().find((region) => region.origin === origin)
              ?.expansionStack ?? [],
        }),
      ),
    );
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
    // `getReferencesAtPosition` returns `ReferenceEntry`, which has no
    // `isDefinition`. `findReferences` names the definition separately and
    // leaves the flag unset on the matching entry, so mark that span here.
    const references =
      this.#project.languageService
        .findReferences(position.mapping.virtualFileName, position.offset)
        ?.flatMap((symbol) => {
          const definition = symbol.definition;
          return symbol.references.map((reference) =>
            reference.fileName === definition.fileName &&
            reference.textSpan.start === definition.textSpan.start &&
            reference.textSpan.length === definition.textSpan.length
              ? { ...reference, isDefinition: true as const }
              : reference,
          );
        }) ?? [];
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
            source: entry.source,
            replacementSpan,
            expansionView:
              generatedSpan !== undefined && replacementSpan === undefined,
          });
        }),
      ),
    });
  }

  completionDetails(
    sourceFileName: string,
    originalOffset: number,
    name: string,
    source: string | undefined,
  ):
    | {
        readonly detail: string;
        readonly documentation: string;
      }
    | undefined {
    const position = this.#generatedPosition(
      sourceFileName,
      originalOffset,
      true,
    );
    if (position === undefined) return undefined;
    const details = this.#project.languageService.getCompletionEntryDetails(
      position.mapping.virtualFileName,
      position.offset,
      name,
      {},
      source,
      {},
      undefined,
    );
    if (details === undefined) return undefined;
    return Object.freeze({
      detail: ts.displayPartsToString(details.displayParts),
      documentation: ts.displayPartsToString([
        ...(details.documentation ?? []),
      ]),
    });
  }

  typeDefinitions(
    sourceFileName: string,
    originalOffset: number,
  ): readonly MappedDefinition[] {
    return this.#definitionsAt(
      sourceFileName,
      originalOffset,
      (service, file, offset) =>
        service.getTypeDefinitionAtPosition(file, offset) ?? [],
    );
  }

  implementations(
    sourceFileName: string,
    originalOffset: number,
  ): readonly MappedDefinition[] {
    return this.#definitionsAt(
      sourceFileName,
      originalOffset,
      (service, file, offset) =>
        service.getImplementationAtPosition(file, offset) ?? [],
    );
  }

  signatureHelp(
    sourceFileName: string,
    originalOffset: number,
  ): ts.SignatureHelpItems | undefined {
    const position = this.#generatedPosition(sourceFileName, originalOffset);
    if (position === undefined) return undefined;
    return this.#project.languageService.getSignatureHelpItems(
      position.mapping.virtualFileName,
      position.offset,
      {},
    );
  }

  documentHighlights(
    sourceFileName: string,
    originalOffset: number,
  ): readonly {
    readonly source: SourceSpan;
    readonly kind: "read" | "write" | "text";
  }[] {
    const position = this.#generatedPosition(sourceFileName, originalOffset);
    if (position === undefined) return Object.freeze([]);
    const highlights =
      this.#project.languageService.getDocumentHighlights(
        position.mapping.virtualFileName,
        position.offset,
        [position.mapping.virtualFileName],
      ) ?? [];
    const spans = [];
    for (const highlight of highlights)
      for (const span of highlight.highlightSpans) {
        const source = sourceSpanForTextSpan(position.mapping, span.textSpan);
        if (source === undefined) continue;
        spans.push(
          Object.freeze({
            source,
            kind:
              span.kind === ts.HighlightSpanKind.writtenReference
                ? ("write" as const)
                : span.kind === ts.HighlightSpanKind.reference
                  ? ("read" as const)
                  : ("text" as const),
          }),
        );
      }
    return Object.freeze(spans);
  }

  documentSymbols(sourceFileName: string): readonly MappedDocumentSymbol[] {
    const mapping = this.#bySource.get(canonical(sourceFileName));
    if (mapping === undefined) return Object.freeze([]);
    const tree = this.#project.languageService.getNavigationTree(
      mapping.virtualFileName,
    );
    return Object.freeze(this.#symbols(mapping, tree.childItems ?? []));
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

  #definitionsAt(
    sourceFileName: string,
    originalOffset: number,
    query: (
      service: ts.LanguageService,
      fileName: string,
      offset: number,
    ) => readonly {
      readonly fileName: string;
      readonly textSpan: ts.TextSpan;
      readonly name?: string;
      readonly kind?: ts.ScriptElementKind;
    }[],
  ): readonly MappedDefinition[] {
    const position = this.#generatedPosition(sourceFileName, originalOffset);
    if (position === undefined) return Object.freeze([]);
    return Object.freeze(
      query(
        this.#project.languageService,
        position.mapping.virtualFileName,
        position.offset,
      ).map((definition) => {
        const target = this.#byVirtual.get(canonical(definition.fileName));
        const source =
          target === undefined
            ? undefined
            : sourceSpanForTextSpan(target, definition.textSpan);
        return Object.freeze({
          name: definition.name ?? "",
          kind: definition.kind ?? ts.ScriptElementKind.unknown,
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

  #symbols(
    mapping: LanguageServiceSourceMapping,
    items: readonly ts.NavigationTree[],
  ): readonly MappedDocumentSymbol[] {
    const symbols = [];
    for (const item of items) {
      const span = item.nameSpan ?? item.spans[0];
      const source =
        span === undefined ? undefined : sourceSpanForTextSpan(mapping, span);
      const children = this.#symbols(mapping, item.childItems ?? []);
      if (source === undefined) {
        symbols.push(...children);
        continue;
      }
      symbols.push(
        Object.freeze({
          name: item.text,
          kind: item.kind,
          source,
          children,
        }),
      );
    }
    return Object.freeze(symbols);
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
