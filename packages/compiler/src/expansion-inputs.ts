import { statSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

/** The text of the file at `path`, or `undefined` where there was no file. */
export interface ExpansionFileInput {
  readonly kind: "file";
  readonly path: string;
  readonly text: string | undefined;
}

/** Whether there is a directory at `path`. */
export interface ExpansionDirectoryInput {
  readonly kind: "directory";
  readonly path: string;
  readonly exists: boolean;
}

/** The directories directly inside `path`, as TypeScript lists a type root. */
export interface ExpansionSubdirectoriesInput {
  readonly kind: "subdirectories";
  readonly path: string;
  readonly names: readonly string[];
}

/** Where `path` leads once every link on the way to it is followed. */
export interface ExpansionRealpathInput {
  readonly kind: "realpath";
  readonly path: string;
  readonly target: string;
}

/**
 * One question an expansion asked of the file system, with the answer it got.
 *
 * Expanding the same project again gives the same output for as long as each
 * question gets the same answer, so these are what an expansion is kept
 * against. A lookup that came back empty counts as much as one that found
 * something: a package installed later, or a file appearing ahead of the one
 * used, changes what an import resolves to.
 */
export type ExpansionInput =
  | ExpansionFileInput
  | ExpansionDirectoryInput
  | ExpansionSubdirectoriesInput
  | ExpansionRealpathInput;

/**
 * What expansion asks of a file system. These are `ts.System`'s own methods,
 * so a TypeScript program expansion builds over the same files asks the same
 * questions in the same terms.
 */
export type ExpansionSystem = Pick<
  ts.System,
  "fileExists" | "readFile" | "directoryExists" | "getDirectories" | "realpath"
>;

/**
 * The file system an expansion reads, and so the one what it read is checked
 * against later. Checking against any other -- the disk, for an expansion of
 * files held in memory -- asks about different files.
 */
export interface ExpansionFileSystem {
  readonly system: ExpansionSystem;
  /**
   * The stat of the file at a path, where the file system is the disk, so a
   * stat a file was read under can stand in for reading it again; `undefined`
   * for one that keeps no stats, whose files are read again every time.
   */
  readonly stat: ((path: string) => BigIntStats | undefined) | undefined;
}

/** The disk, read the way TypeScript reads it. */
export const diskFileSystem: ExpansionFileSystem = Object.freeze({
  system: ts.sys,
  stat: (path: string) =>
    statSync(path, { bigint: true, throwIfNoEntry: false }),
});

/** A file system supplied in place of the disk, such as one held in memory. */
export function suppliedFileSystem(
  system: ExpansionSystem,
): ExpansionFileSystem {
  return Object.freeze({ system, stat: undefined });
}

/**
 * The text of the file at a path, or `undefined` where there is none: nothing
 * at all, a directory -- which reading as a module crashed expansion with a
 * bare `EISDIR` -- or a file that cannot be read.
 */
function fileText(system: ExpansionSystem, path: string): string | undefined {
  return system.fileExists(path) ? system.readFile(path) : undefined;
}

function realpathOf(system: ExpansionSystem, path: string): string {
  if (system.realpath === undefined)
    throw new Error(
      `Cannot ask where ${path} leads: the file system expansion reads does not resolve links`,
    );
  return system.realpath(path);
}

function remember<K, T>(answers: Map<K, T>, key: K, ask: () => T): T {
  const existing = answers.get(key);
  if (existing !== undefined) return existing;
  const answer = ask();
  answers.set(key, answer);
  return answer;
}

/**
 * Asks a file system what an expansion needs to know, once per question, and
 * keeps each answer as an input.
 *
 * Everyone asking during one expansion -- expansion itself, and a TypeScript
 * program over the same files -- hears the answer recorded, so no two of them
 * can see a file differently and no read goes unrecorded.
 */
export class InputRecorder {
  readonly #system: ExpansionSystem;
  readonly #files = new Map<string, ExpansionFileInput>();
  readonly #directories = new Map<string, ExpansionDirectoryInput>();
  readonly #subdirectories = new Map<string, ExpansionSubdirectoriesInput>();
  readonly #realpaths = new Map<string, ExpansionRealpathInput>();

  constructor(system: ExpansionSystem) {
    this.#system = system;
  }

  file(fileName: string): ExpansionFileInput {
    const path = resolve(fileName);
    return remember(this.#files, path, () =>
      Object.freeze({
        kind: "file",
        path,
        text: fileText(this.#system, path),
      }),
    );
  }

  directory(directoryName: string): ExpansionDirectoryInput {
    const path = resolve(directoryName);
    return remember(this.#directories, path, () =>
      Object.freeze({
        kind: "directory",
        path,
        exists: this.#system.directoryExists(path),
      }),
    );
  }

  subdirectories(directoryName: string): ExpansionSubdirectoriesInput {
    const path = resolve(directoryName);
    return remember(this.#subdirectories, path, () =>
      Object.freeze({
        kind: "subdirectories",
        path,
        names: Object.freeze([...this.#system.getDirectories(path)]),
      }),
    );
  }

  realpath(fileName: string): ExpansionRealpathInput {
    const path = resolve(fileName);
    return remember(this.#realpaths, path, () =>
      Object.freeze({
        kind: "realpath",
        path,
        target: realpathOf(this.#system, path),
      }),
    );
  }

  /** Every answer recorded so far. */
  get inputs(): readonly ExpansionInput[] {
    return Object.freeze([
      ...this.#files.values(),
      ...this.#directories.values(),
      ...this.#subdirectories.values(),
      ...this.#realpaths.values(),
    ]);
  }
}

/**
 * How long ago a file's last write has to be before its stat can stand in for
 * its text.
 *
 * A file system stamps a write no finer than it keeps time -- two seconds on
 * FAT, one on HFS+ -- so a file written within that window of being read can
 * be written again, at the same size, without its stat changing. Git calls
 * such a file racily clean, and webpack starts from the same two seconds for
 * the same reason. Until its last write is further in the past than this, a
 * file's stat says nothing and the file is read.
 *
 * This compares the file system's stamps with this process's clock, so it
 * holds while the two agree to within this window less the file system's
 * granularity -- which a local disk does by construction, its stamps being
 * taken from the same clock. A network or virtual-machine mount whose clock
 * runs ahead only keeps its files from being confirmed; one running behind by
 * more than this can have a racy rewrite taken for settled.
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

/**
 * Everything a write changes. The change time is in it because nothing can
 * set it back: a tool that rewrites a file and restores its modification
 * time, as `rsync -t` and `tar` do, leaves the size and that time as they
 * were. A file deleted and made again has a new change time too, whether or
 * not it is given its old inode.
 */
function statKey(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}

/** An input, and what is known about checking it again cheaply. */
export interface CheckedInput {
  readonly fileSystem: ExpansionFileSystem;
  readonly input: ExpansionInput;
  /** A stat under which the file is known to still hold its text. */
  confirmed: string | undefined;
}

/**
 * Records of inputs read from `fileSystem` after `readAfter`, confirmed
 * against their stats now, one per input however many lists name it -- so a
 * macro module every file of a project reads is confirmed once for all of
 * them. A list asked for again is the same list of records, so files whose
 * expansions all depend on one list share it.
 *
 * Each file was read after `readAfter`. One whose last write is settled by
 * then has not been written since, so it still holds what was read and its
 * stat can say so from here on.
 */
export function checkedInputs(
  fileSystem: ExpansionFileSystem,
  readAfter: bigint,
): (inputs: readonly ExpansionInput[]) => readonly CheckedInput[] {
  const records = new Map<ExpansionInput, CheckedInput>();
  const lists = new Map<readonly ExpansionInput[], readonly CheckedInput[]>();
  return (inputs) =>
    remember(lists, inputs, () =>
      Object.freeze(
        inputs.map((input) =>
          remember(records, input, () => {
            const stats =
              input.kind === "file" && input.text !== undefined
                ? fileSystem.stat?.(input.path)
                : undefined;
            return {
              fileSystem,
              input,
              confirmed:
                stats?.isFile() === true && settled(stats, readAfter)
                  ? statKey(stats)
                  : undefined,
            };
          }),
        ),
      ),
    );
}

function sameNames(
  names: readonly string[],
  others: readonly string[],
): boolean {
  return (
    names.length === others.length &&
    names.every((name, index) => name === others[index])
  );
}

/**
 * Whether a file still holds the text it was read with. A file whose stat is
 * one it was confirmed under is not read; any other is, and its text decides.
 */
function fileHolds(checked: CheckedInput, input: ExpansionFileInput): boolean {
  const { system, stat } = checked.fileSystem;
  if (stat === undefined) return fileText(system, input.path) === input.text;
  const checkedAt = nowNanoseconds();
  const stats = stat(input.path);
  if (stats?.isFile() !== true) return input.text === undefined;
  const key = statKey(stats);
  if (key === checked.confirmed) return true;
  const text = fileText(system, input.path);
  if (text !== input.text) return false;
  checked.confirmed =
    text !== undefined && settled(stats, checkedAt) ? key : undefined;
  return true;
}

/** Whether one question still gets the answer it got. */
function inputHolds(record: CheckedInput): boolean {
  const { input } = record;
  const { system } = record.fileSystem;
  switch (input.kind) {
    case "file":
      return fileHolds(record, input);
    case "directory":
      return system.directoryExists(input.path) === input.exists;
    case "subdirectories":
      return sameNames(system.getDirectories(input.path), input.names);
    case "realpath":
      return realpathOf(system, input.path) === input.target;
  }
}

/**
 * One round of asking whether inputs still hold, whose answers serve every
 * request that arrived before the round began.
 *
 * An answer is as of the moment it was asked, and a request is answered
 * rightly from anything asked after the request arrived, so the requests
 * that arrived before a round began can share its answers: each input is
 * asked once for all of them, and a list of inputs that many files share is
 * walked once. A request arriving later needs a round of its own; reusing
 * an answer from before it arrived could miss a change made in between.
 */
export class InputCheckRound {
  readonly #answers = new Map<CheckedInput, boolean>();
  readonly #lists = new Map<readonly CheckedInput[], boolean>();

  /**
   * Whether every question an expansion asked still gets the answer it got,
   * asked of the file system that answered it.
   *
   * Files are confirmed by stat where the file system keeps one. Whether a
   * directory is there, which directories it holds and where a link leads
   * are asked again outright; none of them reads a file.
   */
  hold(checked: readonly CheckedInput[]): boolean {
    return remember(this.#lists, checked, () =>
      checked.every((record) =>
        remember(this.#answers, record, () => inputHolds(record)),
      ),
    );
  }
}

/** Whether every question an expansion asked still gets the answer it got. */
export function inputsHold(checked: readonly CheckedInput[]): boolean {
  return new InputCheckRound().hold(checked);
}
