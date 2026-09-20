// Every temporary file a test run creates lives under one directory that the
// run removes when it ends.
//
// The tests make their scratch space with `mkdtempSync(join(tmpdir(), …))`, a
// hundred and fifty call sites across sixty files, and none removes what it
// made. Each run therefore left a few hundred directories in the system
// temporary directory, and nothing there is ever collected while the machine
// stays up: it reached 368,000 entries. That is not only clutter. Other
// programs resolve paths beneath that directory, and libc's `realpath` lists
// the parent of the working directory entry by entry, so every compile started
// from a temporary project took minutes instead of milliseconds.
//
// `os.tmpdir()` reads `TMPDIR` each time it is called, and Vitest starts its
// workers after global setup has run, so pointing `TMPDIR` at a directory of
// this run's own moves every one of those call sites at once, and anything
// they spawn inherits it. Teardown removes the directory.
//
// A run that is killed never reaches teardown, so each run first removes the
// directories of runs whose process is gone. The owner's pid is in the name:
// a directory is only swept once nothing can still be using it.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const prefix = "sweetener-test-run-";

/** Whether a process with this id exists, whoever owns it. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else. ESRCH: it is gone.
    return error.code === "EPERM";
  }
}

/** Removes the run directories under `root` whose run is no longer alive. */
export function sweepAbandonedRuns(root) {
  const swept = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(prefix)) continue;
    const pid = Number.parseInt(name.slice(prefix.length), 10);
    if (!Number.isInteger(pid) || alive(pid)) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    swept.push(name);
  }
  return swept;
}

/** Vitest global setup: returns the teardown. */
export default function setup() {
  const root = tmpdir();
  sweepAbandonedRuns(root);
  const directory = mkdtempSync(join(root, `${prefix}${process.pid}-`));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
}
