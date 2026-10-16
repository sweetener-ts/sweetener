import type { OriginId } from "@sweetener/shared";
import type {
  OriginStore,
  SlashReading,
  SlashReadings,
  SourceOrigin,
} from "@sweetener/syntax";

/**
 * How many times one source is read to settle how its slashes read.
 *
 * The enforester finds a slash read the other way from the grammar wherever
 * it reaches one, and a source is read again with every slash it found read
 * as it found it. Its finding at a slash depends on what was read in front of
 * it, which the readings of the slashes there settle, so the reads come to
 * agree with the enforester, usually after one read again. A read whose
 * findings it acts on is one closer to that only while the findings were
 * made in syntax that stands, and a macro's rules decide by what is written
 * after the slash too; so the number of reads is bounded rather than trusted,
 * and the last one reports what it still finds instead of reading again.
 */
export const slashReadLimit = 8;

/** What reading a source with given slash readings came to. */
export type SlashAttempt<Settled, Readings> =
  | { readonly kind: "settled"; readonly settled: Settled }
  | { readonly kind: "reread"; readonly readings: Readings };

/**
 * Reads a source, by `attempt`, until its slashes settle: from `readings`,
 * and then with each set of readings an attempt asks to be read with, at most
 * `limit` times. The last attempt is told it is the last, and settles with
 * whatever it found.
 */
export function settleSlashReadings<Settled, Readings>(
  readings: Readings,
  attempt: (
    readings: Readings,
    final: boolean,
  ) => SlashAttempt<Settled, Readings>,
  limit: number = slashReadLimit,
): Settled {
  let current = readings;
  for (let read = 1; ; read += 1) {
    const result = attempt(current, read >= limit);
    if (result.kind === "settled") return result.settled;
    if (read >= limit)
      throw new RangeError(
        `A read told it was the last of ${String(limit)} asked to be read again`,
      );
    current = result.readings;
  }
}

/**
 * The readings to read a source with next, `readings` being what it was read
 * with and `found` how the enforester found the slashes it read the other way
 * should read; undefined where it found nothing the readings do not already
 * say. A finding about a slash given a reading replaces it: that reading was
 * found in syntax read before the slashes in front of it were settled.
 */
export function nextSlashReadings(
  readings: SlashReadings,
  found: SlashReadings,
): SlashReadings | undefined {
  const changed = [...found].filter(
    ([offset, reading]) => readings.get(offset) !== reading,
  );
  if (changed.length === 0) return undefined;
  const next = new Map<number, SlashReading>(readings);
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
