import { describe, expect, it } from "vitest";
import { staleReports } from "../../../scripts/status-lib.mjs";

/**
 * `STATUS.md` records the commit each check ran at, and until now nothing read
 * it back. A green validation table above a `Health: green` said nothing about
 * whether the suite had ever run against the tree in front of you.
 *
 * The question is asked when the dashboard is checked rather than when it is
 * rendered, because the file is committed alongside the change it describes:
 * anything written into it that named the current commit was one behind the
 * moment it landed, which is what made the byte-for-byte render comparison
 * fail for three alphas.
 */
describe("check report staleness", () => {
  const exists = (commit: string): boolean => commit !== "deadbee";

  it("says nothing about a report from this commit", () => {
    expect(
      staleReports([{ name: "unit", commit: "abc1234" }], "abc1234", exists),
    ).toEqual([]);
  });

  it("names a report that predates the tree", () => {
    expect(
      staleReports([{ name: "unit", commit: "abc1234" }], "def5678", exists),
    ).toEqual(["unit ran at abc1234, and HEAD is def5678."]);
  });

  it("names a report whose commit this repository does not hold", () => {
    expect(
      staleReports([{ name: "unit", commit: "deadbee" }], "def5678", exists),
    ).toEqual([
      "unit ran at deadbee, which is not a commit in this repository.",
    ]);
  });

  it("names a report that records no commit at all", () => {
    expect(staleReports([{ name: "unit" }], "def5678", exists)).toEqual([
      "unit records no commit, so nothing says when it ran.",
    ]);
  });

  it("says nothing where git cannot say what HEAD is", () => {
    // A tarball, a shallow checkout, a directory that is not a repository:
    // silence rather than a complaint nobody can act on.
    expect(
      staleReports([{ name: "unit", commit: "abc1234" }], undefined, exists),
    ).toEqual([]);
  });
});
