import { readFileSync, statSync, type BigIntStats } from "node:fs";

/**
 * How long ago a file's last write has to be before its stat can stand in for
 * its text.
 *
 * A file system stamps a write no finer than it keeps time -- two seconds on
 * FAT, one on HFS+ -- so a file written within that window of being read can
 * be written again, at the same size, without its stat changing. Git calls
 * such a file racily clean. Until its last write is further in the past than
 * this, its stat says nothing and the file is read.
 */
const settledNanoseconds = 2_000_000_000n;

export function nowNanoseconds(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function settled(stats: BigIntStats, readAfter: bigint): boolean {
  return (
    stats.mtimeNs < readAfter - settledNanoseconds &&
    stats.ctimeNs < readAfter - settledNanoseconds
  );
}

function statKey(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** A file an expansion consulted, and what it found there. */
export interface ConsultedFile {
  readonly path: string;
  /** The text it read, or `undefined` where it found no file. */
  readonly text: string | undefined;
  /** A stat under which the file is known to still hold `text`. */
  confirmed: string | undefined;
}

/**
 * The files an expansion consulted, confirmed against their stats now.
 *
 * The expansion read each one after `expandedAt`. A file whose last write is
 * settled by then has not been written since, so it still holds what was read
 * and its stat can say so from here on.
 */
export function consulted(
  inputs: ReadonlyMap<string, string | undefined>,
  expandedAt: bigint,
): ConsultedFile[] {
  return [...inputs].map(([path, text]) => {
    const stats =
      text === undefined
        ? undefined
        : statSync(path, { bigint: true, throwIfNoEntry: false });
    return {
      path,
      text,
      confirmed:
        stats?.isFile() === true && settled(stats, expandedAt)
          ? statKey(stats)
          : undefined,
    };
  });
}

/**
 * Whether every file an expansion consulted still holds what it found there.
 *
 * Asked on every transform, so it has to cost little: reading back and hashing
 * every input each time made a build quadratic in the size of its project. A
 * file whose stat is one it was confirmed under is not read; any other file
 * is, and its text decides. A file that was missing has to be missing still.
 */
export function stillConsulted(files: readonly ConsultedFile[]): boolean {
  for (const file of files) {
    const checkedAt = nowNanoseconds();
    const stats = statSync(file.path, { bigint: true, throwIfNoEntry: false });
    if (stats?.isFile() !== true) {
      if (file.text === undefined) continue;
      return false;
    }
    if (file.text === undefined) return false;
    const key = statKey(stats);
    if (key === file.confirmed) continue;
    if (readFileSync(file.path, "utf8") !== file.text) return false;
    file.confirmed = settled(stats, checkedAt) ? key : undefined;
  }
  return true;
}
