import type {
  ExpansionFrame,
  RelatedDiagnosticOrigin,
  SourceSpan,
} from "@sweetener/shared";
import {
  projectGeneratedOffset,
  type OriginMapEntry,
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

/** Text that lays out what is printed around it and says nothing itself. */
const layout = /^\s*$/u;

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
 * Whether a region prints text the author wrote, where they wrote it or as a
 * macro copied it.
 */
function written(origins: OriginStore, entry: OriginMapEntry): boolean {
  const kind = origins.get(entry.origin)?.kind;
  return kind === "source" || kind === "copied";
}

/**
 * Where a span of generated text is reported in the sources, and what else in
 * them it is about.
 *
 * The first region the span touches decides where it is reported, by the
 * projection the origin index answers offset queries with. A region the
 * author wrote, or one a macro copied, keeps the span's position, and the
 * report runs on over the regions after it that print the same file's text in
 * the order it was written, with nothing but layout between them: an error
 * about `1, 2, 3` is reported over all of it. A region a macro's template
 * wrote is reported over the whole of the source it stands for: an introduced
 * name, over the invocation that wrote it.
 *
 * What a macro wrote is related to the sources it was written from, named
 * for what each is. For an introduced name that is the rule that wrote it,
 * which is what tells two names from one invocation apart. What the author
 * wrote is about nothing but itself, and is related to nothing.
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
  const project = (segment: OriginMapEntry, offset: number) =>
    projectGeneratedOffset(
      {
        kind: segment.kind,
        generatedStart: segment.generatedStart,
        primary: origins.selectPrimarySource(segment.origin, "invocation"),
      },
      offset,
    );
  const primaryStart = project(first, Math.max(start, first.generatedStart));
  let end = written(origins, first)
    ? Math.min(source.span.end, primaryStart + length)
    : source.span.end;
  if (written(origins, first)) {
    let previous = first;
    for (const segment of segments.slice(1)) {
      const text = generated.text.slice(
        segment.generatedStart,
        segment.generatedEnd,
      );
      if (layout.test(text)) continue;
      const next = origins.selectPrimarySource(segment.origin, "invocation");
      if (
        !written(origins, segment) ||
        next.sourceId !== source.sourceId ||
        next.span.start < end ||
        !layout.test(
          generated.text.slice(previous.generatedEnd, segment.generatedStart),
        )
      )
        break;
      end =
        project(segment, Math.min(start + length, segment.generatedEnd) - 1) +
        1;
      previous = segment;
    }
  }
  const primaryOrigin = Object.freeze({
    sourceId: source.sourceId,
    start: primaryStart,
    end,
    originId: first.origin,
  });
  const relatedOrigins: RelatedDiagnosticOrigin[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const origin = origins.get(segment.origin);
    if (origin === undefined || written(origins, segment)) continue;
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
