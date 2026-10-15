import { readFileSync, statSync, type BigIntStats } from "node:fs";

/**
 * The text of the file at a path, or `undefined` where there is no file there:
 * nothing at all, or a directory, which reading as a module crashed expansion
 * with a bare `EISDIR` instead of saying the import resolves to nothing.
 */
export function fileText(fileName: string): string | undefined {
  return statSync(fileName, { throwIfNoEntry: false })?.isFile() === true
    ? readFileSync(fileName, "utf8")
    : undefined;
}

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
 * Records of what was consulted after `consultedAt`, confirmed against their
 * stats now, one per path however many lists name it -- so a macro module
 * every file of a project reads is confirmed once for all of them.
 *
 * Each file was read after `consultedAt`. One whose last write is settled by
 * then has not been written since, so it still holds what was read and its
 * stat can say so from here on.
 */
export function recordConsulted(
  consultedAt: bigint,
): (inputs: ReadonlyMap<string, string | undefined>) => ConsultedFile[] {
  const records = new Map<string, ConsultedFile>();
  return (inputs) =>
    [...inputs].map(([path, text]) => {
      const existing = records.get(path);
      if (existing !== undefined) return existing;
      const stats =
        text === undefined
          ? undefined
          : statSync(path, { bigint: true, throwIfNoEntry: false });
      const record: ConsultedFile = {
        path,
        text,
        confirmed:
          stats?.isFile() === true && settled(stats, consultedAt)
            ? statKey(stats)
            : undefined,
      };
      records.set(path, record);
      return record;
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
