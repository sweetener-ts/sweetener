import type { OriginId } from "@sweetener/shared";
import type {
  OriginStore,
  TokenReading,
  TokenReadings,
  SourceOrigin,
} from "@sweetener/syntax";

/**
 * How many reads in a row may settle no token that no read before them
 * settled, before the last of them reports what it still finds.
 *
 * The enforester finds a slash or a `<` read the other way from the grammar
 * wherever it reaches one, and a source is read again with every token it
 * found read as it found it. Its finding at a token depends on what was read
 * in front of it, which the readings of the tokens there settle, so the reads
 * come to agree with the enforester. A read that asks for a reading no read
 * asked for before has made progress, and there are only two readings of each
 * token in a source, so reads that make progress end by themselves however
 * many a source needs: a regular expression holding a bracket hides the next
 * one from the enforester until it is read as one, so a source of many such
 * needs a read for each. A read that asks only for readings asked for before
 * goes round where an earlier one went -- a finding made in syntax that a
 * later reading took apart, or a macro's rule that decides by what is written
 * after the token -- and only those reads are counted against this.
 */
export const readLimit = 8;

/** What reading a source with given readings came to. */
export type ReadAttempt<Settled, Readings> =
  | { readonly kind: "settled"; readonly settled: Settled }
  | { readonly kind: "reread"; readonly readings: Readings };

/**
 * Reads a source, by `attempt`, until its readings settle: from `readings`,
 * and then with each set of readings an attempt asks to be read with.
 * `asked` names each reading a set holds, so that a read asking for one no
 * read asked for before is told from one that only asks again; after `limit`
 * reads in a row of the second kind the next is told it is the last, and
 * settles with whatever it found. Each attempt is told how many reads it
 * makes, itself included.
 */
export function settleReadings<Settled, Readings>(
  readings: Readings,
  asked: (readings: Readings) => Iterable<string>,
  attempt: (
    readings: Readings,
    final: boolean,
    reads: number,
  ) => ReadAttempt<Settled, Readings>,
  limit: number = readLimit,
): Settled {
  const seen = new Set(asked(readings));
  let current = readings;
  /** How many reads in a row have asked for nothing new. */
  let repeated = 0;
  for (let reads = 1; ; reads += 1) {
    const final = repeated >= limit - 1;
    const result = attempt(current, final, reads);
    if (result.kind === "settled") return result.settled;
    if (final)
      throw new RangeError(
        `A read told it was the last after ${String(limit)} that settled nothing new asked to be read again`,
      );
    let progressed = false;
    for (const reading of asked(result.readings))
      if (!seen.has(reading)) {
        seen.add(reading);
        progressed = true;
      }
    repeated = progressed ? 0 : repeated + 1;
    current = result.readings;
  }
}

/** Names each reading of one source's `readings`, for `settleReadings`. */
export function askedReadings(readings: TokenReadings): Iterable<string> {
  return [...readings].map(
    ([offset, reading]) => `${String(offset)} ${reading}`,
  );
}

/**
 * The readings to read a source with next, `readings` being what it was read
 * with and `found` how the enforester found the tokens it read the other way
 * should read; undefined where it found nothing the readings do not already
 * say. A finding about a token given a reading replaces it: that reading was
 * found in syntax read before the tokens in front of it were settled.
 */
export function nextReadings(
  readings: TokenReadings,
  found: TokenReadings,
): TokenReadings | undefined {
  const changed = [...found].filter(
    ([offset, reading]) => readings.get(offset) !== reading,
  );
  if (changed.length === 0) return undefined;
  const next = new Map<number, TokenReading>(readings);
  for (const [offset, reading] of changed) next.set(offset, reading);
  return next;
}

/**
 * The source text a token was read from: where it was read, or where the
 * token a capture copied it from was. Undefined for a token a macro's
 * template or the expander wrote, which no read of a source holds.
 */
export function writtenSource(
  origins: OriginStore,
  origin: OriginId,
): SourceOrigin | undefined {
  let current = origins.get(origin);
  while (current?.kind === "copied") current = origins.get(current.parent);
  return current?.kind === "source" ? current : undefined;
}
