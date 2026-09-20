import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearRawOutput, readRawOutput } from "../../../scripts/run-tests.mjs";

/**
 * `unit.json` is what `STATUS.md`'s validation table is rendered from, so a
 * report that did not come from this run is a green recorded at a commit where
 * nothing ran.
 *
 * The file Vitest writes has a fixed name, and nothing about it says which run
 * wrote it. So the runner removes it first and refuses to read a missing one,
 * and both halves are checked here rather than left to a Vitest crash to
 * demonstrate.
 */
describe("the unit test report", () => {
  function raw(): string {
    return join(mkdtempSync(join(tmpdir(), "sweet-report-")), "vitest.raw");
  }

  it("removes what the last run left", async () => {
    const path = raw();
    writeFileSync(path, JSON.stringify({ numPassedTests: 9_999 }));
    await clearRawOutput(path);
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("removes nothing where there is nothing to remove", async () => {
    await expect(clearRawOutput(raw())).resolves.toBeUndefined();
  });

  it("refuses to report a run that wrote no result", async () => {
    await expect(readRawOutput(raw())).rejects.toThrow(
      /Vitest wrote no report/u,
    );
  });

  it("reads the report a run did write", async () => {
    const path = raw();
    writeFileSync(path, JSON.stringify({ numPassedTests: 3 }));
    await expect(readRawOutput(path)).resolves.toEqual({ numPassedTests: 3 });
  });
});
