import type { ExpansionFrame, OriginId, SourceId } from "@sweetener/shared";
import type { OriginStore, SourceOrigin } from "@sweetener/syntax";
import type {
  GeneratedRegionKind,
  OriginMapEntry,
  PrintedExpandedFile,
} from "./printed-file.js";

export interface OriginQueryResult {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly origin: OriginId;
  readonly kind: GeneratedRegionKind;
  readonly primary: SourceOrigin;
  readonly sources: readonly SourceOrigin[];
  readonly expansionStack: readonly ExpansionFrame[];
}

export interface GeneratedOriginQueryResult extends OriginQueryResult {
  readonly queriedGeneratedOffset: number;
  readonly projectedOriginalOffset: number;
}

export interface OriginalOriginQueryResult extends OriginQueryResult {
  readonly queriedSourceId: SourceId;
  readonly queriedOriginalOffset: number;
  readonly projectedGeneratedOffset: number;
}

export type GeneratedPositionClassification = GeneratedRegionKind | "gap";

export interface OriginQueryIndex {
  generatedToOriginal(offset: number): readonly GeneratedOriginQueryResult[];
  originalToGenerated(
    sourceId: SourceId,
    offset: number,
  ): readonly OriginalOriginQueryResult[];
  classifyGenerated(offset: number): GeneratedPositionClassification;
  expansionStackAtGenerated(offset: number): readonly ExpansionFrame[];
  innermostInvocationAtGenerated(offset: number): ExpansionFrame | undefined;
  regions(kind?: GeneratedRegionKind): readonly OriginQueryResult[];
}

interface SourceIndexedRegion {
  readonly region: OriginQueryResult;
  readonly source: SourceOrigin;
  readonly maximumEndThroughHere: number;
}

interface PendingSourceIndex {
  readonly entries: Array<{
    readonly region: OriginQueryResult;
    readonly source: SourceOrigin;
  }>;
  readonly seen: Set<OriginQueryResult>;
}

function contains(start: number, end: number, offset: number): boolean {
  return start === end ? offset === start : start <= offset && offset < end;
}

/**
 * A printed region, which works out which macro produced it only if asked.
 *
 * Finding that means searching the file's invocation traces, twice per trace
 * through the origin graph. Doing it for every region made indexing a file cost
 * regions times traces, and a caller asks it of one position when reporting a
 * diagnostic — never of every token. A class rather than a literal with a
 * closure keeps the deferral from costing an allocation per region.
 */
class MaterializedRegion implements OriginQueryResult {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly origin: OriginId;
  readonly kind: GeneratedRegionKind;
  readonly primary: SourceOrigin;
  readonly sources: readonly SourceOrigin[];
  readonly #compute:
    ((origin: OriginId) => readonly ExpansionFrame[]) | undefined;
  #stack: readonly ExpansionFrame[] | undefined;

  constructor(
    entry: OriginMapEntry,
    primary: SourceOrigin,
    sources: readonly SourceOrigin[],
    compute: ((origin: OriginId) => readonly ExpansionFrame[]) | undefined,
  ) {
    this.generatedStart = entry.generatedStart;
    this.generatedEnd = entry.generatedEnd;
    this.origin = entry.origin;
    this.kind = entry.kind;
    this.primary = primary;
    this.sources = sources;
    this.#compute = compute;
    // Handed to callers like every other value here. The remembered stack
    // lives in a private field, which freezing does not reach, so deferring
    // it still works.
    Object.freeze(this);
  }

  get expansionStack(): readonly ExpansionFrame[] {
    this.#stack ??= Object.freeze([...(this.#compute?.(this.origin) ?? [])]);
    return this.#stack;
  }
}

/** Text-bearing regions before the layout printed around them. */
function substance(region: OriginQueryResult): number {
  return region.kind === "source" || region.kind === "copied" ? 0 : 1;
}

function bySubstanceThenPosition(
  left: SourceIndexedRegion,
  right: SourceIndexedRegion,
): number {
  return (
    substance(left.region) - substance(right.region) ||
    left.region.generatedStart - right.region.generatedStart
  );
}

/**
 * A region's data fields without its `expansionStack` accessor.
 *
 * Spreading an object that carries an accessor drops the engine's fast path for
 * copying it, and both queries below copy a region on every call. A query is
 * asking about this region in particular, so its stack is worth settling here:
 * the region remembers it, and the result stays a plain object.
 */
function plain(region: OriginQueryResult) {
  return {
    generatedStart: region.generatedStart,
    generatedEnd: region.generatedEnd,
    origin: region.origin,
    kind: region.kind,
    primary: region.primary,
    sources: region.sources,
  };
}

export function createOriginQueryIndex(options: {
  readonly file: PrintedExpandedFile;
  readonly origins: OriginStore;
  readonly expansionStack?:
    ((origin: OriginId) => readonly ExpansionFrame[]) | undefined;
}): OriginQueryIndex {
  let previousEnd = 0;
  const entries = options.file.originMap.entries.map((entry) => {
    if (
      entry.generatedStart < previousEnd ||
      entry.generatedEnd < entry.generatedStart ||
      entry.generatedEnd > options.file.text.length
    )
      throw new RangeError("Origin-map regions must be ordered and in bounds");
    previousEnd = entry.generatedEnd;
    if (!options.origins.has(entry.origin))
      throw new RangeError(
        `Origin map references unknown origin ${String(entry.origin)}`,
      );
    return materialize(entry);
  });

  function materialize(entry: OriginMapEntry): OriginQueryResult {
    return new MaterializedRegion(
      entry,
      options.origins.selectPrimarySource(entry.origin),
      options.origins.collectSourceOrigins(entry.origin),
      options.expansionStack,
    );
  }

  const frozen = Object.freeze(entries);
  const pendingBySource = new Map<SourceId, PendingSourceIndex>();
  for (const entry of frozen)
    for (const source of entry.sources) {
      const indexed = pendingBySource.get(source.sourceId) ?? {
        entries: [],
        seen: new Set<OriginQueryResult>(),
      };
      if (!indexed.seen.has(entry)) {
        indexed.entries.push({ region: entry, source });
        indexed.seen.add(entry);
      }
      pendingBySource.set(source.sourceId, indexed);
    }
  const bySource = new Map<SourceId, readonly SourceIndexedRegion[]>();
  for (const [sourceId, { entries: pending }] of pendingBySource) {
    pending.sort(
      (left, right) =>
        left.source.span.start - right.source.span.start ||
        left.region.generatedStart - right.region.generatedStart,
    );
    let maximumEnd = 0;
    bySource.set(
      sourceId,
      Object.freeze(
        pending.map(({ region, source }) => {
          maximumEnd = Math.max(
            maximumEnd,
            source.span.start === source.span.end
              ? source.span.end + 1
              : source.span.end,
          );
          return Object.freeze({
            region,
            source,
            maximumEndThroughHere: maximumEnd,
          });
        }),
      ),
    );
  }

  function validateGeneratedOffset(offset: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > options.file.text.length
    )
      throw new RangeError("Generated offset is outside the file");
  }

  function generatedRegion(offset: number): OriginQueryResult | undefined {
    let low = 0;
    let high = frozen.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (frozen[middle]!.generatedStart <= offset) low = middle + 1;
      else high = middle;
    }
    const candidate = frozen[low - 1];
    return candidate !== undefined &&
      contains(candidate.generatedStart, candidate.generatedEnd, offset)
      ? candidate
      : undefined;
  }

  function projectedOriginal(
    region: OriginQueryResult,
    generatedOffset: number,
  ): number {
    if (region.kind !== "source" && region.kind !== "copied")
      return region.primary.span.start;
    const length = region.primary.span.end - region.primary.span.start;
    return length === 0
      ? region.primary.span.start
      : region.primary.span.start +
          Math.min(generatedOffset - region.generatedStart, length - 1);
  }

  return Object.freeze({
    generatedToOriginal: (offset: number) => {
      validateGeneratedOffset(offset);
      const region = generatedRegion(offset);
      return region === undefined
        ? Object.freeze([])
        : Object.freeze([
            Object.freeze({
              ...plain(region),
              expansionStack: region.expansionStack,
              queriedGeneratedOffset: offset,
              projectedOriginalOffset: projectedOriginal(region, offset),
            }),
          ]);
    },
    originalToGenerated: (sourceId: SourceId, offset: number) => {
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new RangeError("Original offset must be non-negative");
      const indexed = bySource.get(sourceId) ?? [];
      let low = 0;
      let high = indexed.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (indexed[middle]!.source.span.start <= offset) low = middle + 1;
        else high = middle;
      }
      const matches: SourceIndexedRegion[] = [];
      for (let index = low - 1; index >= 0; index -= 1) {
        const candidate = indexed[index]!;
        if (candidate.maximumEndThroughHere <= offset) break;
        if (
          contains(
            candidate.source.span.start,
            candidate.source.span.end,
            offset,
          )
        )
          matches.push(candidate);
      }
      // One source offset can be covered by more than one region: the text
      // itself, and the layout printed around it — trivia, separators, the
      // parentheses that hold an expression together — which reach this index
      // under the very same source origin, because the printer gives layout
      // the origin of what it surrounds rather than minting one per token.
      //
      // Only a region carrying the source's own characters is a place that
      // source went. Layout indexed under a source origin that some region
      // here already holds the text of is that text's own spacing, not a
      // second occurrence of it, and reporting it as one made callers ask
      // what a space means: rename asked TypeScript which binding lived at
      // the offset of a separator, got no answer, and read the silence as a
      // second, distinct binding — refusing to rename `[seed, seed]` on the
      // grounds that the two copies of one written name denoted different
      // things. So the text speaks for its own layout and the layout drops
      // out. Layout under a source origin with no text here — a definition's
      // spacing seen from the definition file — is all that offset has, and
      // stands.
      //
      // Most offsets match a single region, which needs neither filtering nor
      // ordering at all.
      let reported: SourceIndexedRegion[] = matches;
      if (reported.length > 1) {
        const spokenFor = new Set<OriginId>();
        for (const match of reported)
          if (substance(match.region) === 0) spokenFor.add(match.source.id);
        if (spokenFor.size > 0)
          reported = reported.filter(
            (match) =>
              substance(match.region) === 0 || !spokenFor.has(match.source.id),
          );
        reported.sort(bySubstanceThenPosition);
      }
      return Object.freeze(
        reported.map(({ region }) =>
          Object.freeze({
            ...plain(region),
            expansionStack: region.expansionStack,
            queriedSourceId: sourceId,
            queriedOriginalOffset: offset,
            projectedGeneratedOffset:
              (region.kind === "source" || region.kind === "copied") &&
              region.primary.sourceId === sourceId
                ? region.generatedStart +
                  Math.min(
                    offset - region.primary.span.start,
                    Math.max(
                      region.generatedEnd - region.generatedStart - 1,
                      0,
                    ),
                  )
                : region.generatedStart,
          }),
        ),
      );
    },
    classifyGenerated: (offset: number) => {
      validateGeneratedOffset(offset);
      return generatedRegion(offset)?.kind ?? "gap";
    },
    expansionStackAtGenerated: (offset: number) => {
      validateGeneratedOffset(offset);
      return generatedRegion(offset)?.expansionStack ?? Object.freeze([]);
    },
    innermostInvocationAtGenerated: (offset: number) => {
      validateGeneratedOffset(offset);
      return generatedRegion(offset)?.expansionStack.at(-1);
    },
    regions: (kind?: GeneratedRegionKind) =>
      kind === undefined
        ? frozen
        : Object.freeze(frozen.filter((region) => region.kind === kind)),
  });
}

/**
 * An index that builds itself when it is first asked something.
 *
 * Indexing a file walks every printed region and sorts them by source, which
 * costs about a fifth of a build. Nothing reads the result unless a diagnostic
 * has to be moved back to the source it came from, or someone asks to explain
 * an expansion, so a build with no diagnostics pays for none of it.
 */
export function createLazyOriginQueryIndex(
  options: Parameters<typeof createOriginQueryIndex>[0],
): OriginQueryIndex {
  // Deferring the index would otherwise defer the check that its regions are
  // ordered and in bounds, so a malformed map — from a stale cache entry, or a
  // tool that wrote one — would be accepted and only rejected later, at
  // whichever query happened to touch it. This says so now, and reads nothing
  // but the entries themselves.
  let previousEnd = 0;
  for (const entry of options.file.originMap.entries) {
    if (
      entry.generatedStart < previousEnd ||
      entry.generatedEnd < entry.generatedStart ||
      entry.generatedEnd > options.file.text.length
    )
      throw new RangeError("Origin-map regions must be ordered and in bounds");
    previousEnd = entry.generatedEnd;
  }
  let built: OriginQueryIndex | undefined;
  const index = (): OriginQueryIndex => {
    built ??= createOriginQueryIndex(options);
    return built;
  };
  return Object.freeze({
    generatedToOriginal: (offset: number) =>
      index().generatedToOriginal(offset),
    originalToGenerated: (sourceId: SourceId, offset: number) =>
      index().originalToGenerated(sourceId, offset),
    classifyGenerated: (offset: number) => index().classifyGenerated(offset),
    expansionStackAtGenerated: (offset: number) =>
      index().expansionStackAtGenerated(offset),
    innermostInvocationAtGenerated: (offset: number) =>
      index().innermostInvocationAtGenerated(offset),
    regions: (kind?: GeneratedRegionKind) => index().regions(kind),
  });
}
