import type {
  ExpansionFrame,
  RelatedDiagnosticOrigin,
  SourceSpan,
} from "@sweetener/shared";
import {
  projectGeneratedOffset,
  type PrintedExpandedFile,
} from "@sweetener/printer";
import type { Origin, OriginStore } from "@sweetener/syntax";
import type ts from "typescript";

export interface RemappedTypeScriptDiagnostic {
  readonly typescriptCode: number;
  readonly category: ts.DiagnosticCategory;
  readonly messageText: string;
  readonly primaryOrigin: SourceSpan | undefined;
  readonly relatedOrigins: readonly RelatedDiagnosticOrigin[];
  readonly expansionStack: readonly ExpansionFrame[];
  readonly generatedStart: number | undefined;
  readonly generatedLength: number | undefined;
  readonly typescriptRelatedInformation: readonly ts.DiagnosticRelatedInformation[];
}

function originLabel(origin: Origin): string {
  switch (origin.kind) {
    case "source":
      return "Original source";
    case "copied":
      return "Copied macro capture";
    case "introduced":
      return "Macro template definition";
    case "synthesized":
      return `Synthesized ${origin.reason}`;
    case "composed":
      return "Additional composed source";
  }
}

function intersectingEntries(
  generated: PrintedExpandedFile,
  start: number,
  length: number,
) {
  const end = start + length;
  if (length > 0)
    return generated.originMap.entries.filter(
      (entry) => entry.generatedStart < end && entry.generatedEnd > start,
    );
  const beginning = generated.originMap.entries.filter(
    (entry) => entry.generatedStart === start,
  );
  if (beginning.length > 0) return beginning;
  return generated.originMap.entries.filter(
    (entry) => entry.generatedStart < start && entry.generatedEnd >= start,
  );
}

export interface RemappedGeneratedSpan {
  readonly primaryOrigin: SourceSpan | undefined;
  readonly relatedOrigins: readonly RelatedDiagnosticOrigin[];
}

/**
 * Where a span of generated text is reported in the sources, and what else in
 * them it is about.
 *
 * The first region the span touches decides where it is reported, by the
 * projection the origin index answers offset queries with. A region the author
 * wrote, or one a macro copied, keeps the span's position and its length to the
 * end of that region. A region a macro's template wrote is reported over the
 * whole of the source it stands for: an introduced name, over the invocation
 * that wrote it.
 *
 * Every other source the touched regions lead to is related, and named for
 * what it is. For an introduced name that is the rule that wrote it, which is
 * what tells two names from one invocation apart.
 *
 * `check` and the language service both report through this, so an editor and
 * the command line say the same thing about the same expansion.
 */
export function remapGeneratedSpan(options: {
  readonly generated: PrintedExpandedFile;
  readonly origins: OriginStore;
  readonly start: number;
  readonly length: number;
}): RemappedGeneratedSpan {
  const { generated, origins, start, length } = options;
  const segments = intersectingEntries(generated, start, length);
  const first = segments[0];
  if (first === undefined)
    return Object.freeze({ primaryOrigin: undefined, relatedOrigins: [] });
  const source = origins.selectPrimarySource(first.origin, "invocation");
  const primaryStart = projectGeneratedOffset(
    { kind: first.kind, generatedStart: first.generatedStart, primary: source },
    Math.max(start, first.generatedStart),
  );
  const primaryOrigin = Object.freeze({
    sourceId: source.sourceId,
    start: primaryStart,
    end:
      first.kind === "source" || first.kind === "copied"
        ? Math.min(source.span.end, primaryStart + length)
        : source.span.end,
    originId: first.origin,
  });
  const relatedOrigins: RelatedDiagnosticOrigin[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const origin = origins.get(segment.origin);
    if (origin === undefined) continue;
    for (const related of origins.collectSourceOrigins(segment.origin)) {
      const key = `${String(related.sourceId)}:${String(related.span.start)}:${String(related.span.end)}`;
      if (
        seen.has(key) ||
        (source.sourceId === related.sourceId &&
          source.span.start === related.span.start &&
          source.span.end === related.span.end)
      )
        continue;
      seen.add(key);
      relatedOrigins.push(
        Object.freeze({
          message: originLabel(origin),
          origin: Object.freeze({
            sourceId: related.sourceId,
            start: related.span.start,
            end: related.span.end,
            originId: segment.origin,
          }),
        }),
      );
    }
  }
  return Object.freeze({
    primaryOrigin,
    relatedOrigins: Object.freeze(relatedOrigins),
  });
}

export function remapTypeScriptDiagnostic(options: {
  readonly diagnostic: ts.Diagnostic;
  readonly generated: PrintedExpandedFile | undefined;
  readonly origins: OriginStore;
  readonly expansionFrames?:
    | ((origin: Parameters<OriginStore["get"]>[0]) => readonly ExpansionFrame[])
    | undefined;
}): RemappedTypeScriptDiagnostic {
  const { diagnostic, generated, origins } = options;
  const { primaryOrigin, relatedOrigins } =
    generated === undefined || diagnostic.start === undefined
      ? { primaryOrigin: undefined, relatedOrigins: [] }
      : remapGeneratedSpan({
          generated,
          origins,
          start: diagnostic.start,
          length: diagnostic.length ?? 0,
        });
  const primaryId = primaryOrigin?.originId;
  return Object.freeze({
    typescriptCode: diagnostic.code,
    category: diagnostic.category,
    messageText: tsFlatten(diagnostic.messageText),
    primaryOrigin,
    relatedOrigins,
    expansionStack: Object.freeze(
      primaryId === undefined
        ? []
        : [...(options.expansionFrames?.(primaryId) ?? [])],
    ),
    generatedStart: diagnostic.start,
    generatedLength: diagnostic.length,
    typescriptRelatedInformation: Object.freeze([
      ...(diagnostic.relatedInformation ?? []),
    ]),
  });
}

function tsFlatten(message: string | ts.DiagnosticMessageChain): string {
  if (typeof message === "string") return message;
  return [message.messageText, ...(message.next ?? []).map(tsFlatten)].join(
    "\n",
  );
}
