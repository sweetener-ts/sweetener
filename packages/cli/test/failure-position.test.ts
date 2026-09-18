import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Where a macro that no rule accepts is reported, and with what words.
 *
 * A no-match is reported where the farthest failure is, including one deep
 * inside a syntax class, in the words of the innermost class that describes
 * what belongs there. Reported at the start of the invocation instead, a `=`
 * written for `==` in the fourth clause of a query points at `query(`, naming
 * what the first optional clause wanted.
 */

const macros = `
export syntax class Column {
  fields { table: ident; name: ident; }
  rule { $table:ident.$name:ident }
  expect "a column written \`table.column\`";
}

export syntax class Comparison {
  fields { left: Column; eq: expr?; ge: expr?; }
  rule { $left:Column == $eq:expr }
  rule { $left:Column >= $ge:expr }
  expect "a comparison: == or >=";
}

export syntax class Condition {
  fields { comparisons: Comparison*; }
  rule { $($comparisons:Comparison) and + }
  expect "comparisons joined by \`and\`";
}

export syntax class Join {
  fields { table: ident; on: Condition; }
  rule { join $table:ident on $on:Condition }
  expect "\`join table on condition\`";
}

export syntax class Filter {
  fields { condition: Condition; }
  rule { where $condition:Condition }
}

export syntax class Limit {
  fields { count: expr; }
  rule { limit $count:expr }
}

export syntax query:expr {
  rule {
    query($database:expr) {
      from $table:ident
      $($joins:Join)*
      $($filter:Filter)?
      $($limit:Limit)?
    }
  }
  expect "from, then any of join, where and limit, in that order";
  => { [$table] }
}
`;

/** Expand a project holding `source`, and read one of the two channels. */
function expandOnce(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-failure-position-"));
  const text = `import { query } from "./macros.sts" for syntax;\ndeclare const db: unknown;\ndeclare const users: unknown;\ndeclare const minAge: number;\n${source}\n`;
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), text);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: true, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  const read = (diagnostics: readonly ts.Diagnostic[], code: number) =>
    diagnostics
      .filter((diagnostic) => diagnostic.code === code)
      .map(({ start, messageText }) => ({
        at: text.slice(start ?? 0, (start ?? 0) + 12),
        message: String(messageText),
      }));
  return {
    reported: (code: number) => read(expanded.diagnostics, code),
    held: (code: number) =>
      read(expanded.unresolvedNameExplanations ?? [], code),
  };
}

/** What expansion reports on its own account. */
function diagnose(source: string, code = 4001) {
  return expandOnce(source).reported(code);
}

/**
 * What expansion writes but does not report: a sentence about what defines a
 * name, held for TypeScript and spoken only where TypeScript says the name is
 * missing. `packages/cli/test/macro-name-resolution.test.ts` checks both
 * directions of that, against a whole program.
 */
function explain(source: string, code = 4024) {
  return expandOnce(source).held(code);
}

describe("a macro no rule accepts is reported at the mistake", () => {
  test("inside an optional clause, in the innermost described class's words", () => {
    const reported = diagnose(`export const found = query(db) {
  from users
  join posts on posts.authorId == users.id
  where users.age = minAge and users.id == 1
  limit 20
};`);
    expect(reported).toEqual([
      {
        at: "= minAge and",
        message:
          "No rule for macro query accepted this input: a comparison: == or >=.",
      },
    ]);
  });

  test("inside a repeated clause", () => {
    const reported = diagnose(`export const found = query(db) {
  from users
  join posts on posts.authorId = users.id
};`);
    expect(reported).toEqual([
      {
        at: "= users.id\n}",
        message:
          "No rule for macro query accepted this input: a comparison: == or >=.",
      },
    ]);
  });

  test("an incomplete column is described by the column, where it stops", () => {
    const reported = diagnose(`export const found = query(db) {
  from users
  where users. >= minAge
};`);
    expect(reported).toEqual([
      {
        at: ">= minAge\n};",
        message:
          "No rule for macro query accepted this input: a column written `table.column`.",
      },
    ]);
  });

  test("a clause out of order takes the rule's own words, where it stands", () => {
    const reported = diagnose(`export const found = query(db) {
  from users
  limit 20
  where users.age >= minAge
};`);
    expect(reported).toEqual([
      {
        at: "where users.",
        message:
          "No rule for macro query accepted this input: from, then any of join, where and limit, in that order.",
      },
    ]);
  });
});

/**
 * A macro name written with nothing after it was offered no syntax at all, so
 * no rule could read even its head. Reported as a failed match it read as the
 * macro's own fault -- "expected a parenthesised group" -- for code that never
 * meant to invoke it; what is wrong is that the name itself is not something
 * the emitted code defines.
 *
 * Which is a claim about the whole program, so it is written rather than
 * reported: a macro spelled `Event` or `JSON` leaves an ordinary global
 * standing where the name is, and TypeScript is the side that knows. These say
 * which sentence expansion wrote and where, and `macro-name-resolution.test.ts`
 * says where it is spoken and where it is dropped.
 */
describe("a macro name written on its own", () => {
  const message =
    "Macro query is written here as a name on its own, where an expr is read. " +
    "A macro is a compile-time name, so nothing defines query in the emitted code. " +
    "Write an invocation its rules accept.";

  const bare: readonly (readonly [string, string])[] = [
    ["in an array literal", "export const q = [query];"],
    ["as an argument", "export const q = String(query);"],
    ["as an initializer", "export const q = query;"],
    ["as what a function returns", "export function f() { return query; }"],
    ["as a spread element", "export const q = [...query];"],
    ["as an object literal shorthand", "export const q = { query };"],
    // Nothing follows the name in any of those, so the rules were offered no
    // syntax at all. In these something does follow, and it is still not the
    // macro's: a terminator, the `.` of a member access, the `,` of an
    // argument list. No rule read past the name, which is what makes the name
    // a name.
    ["as what a module exports by default", "export default query;"],
    ["as the object of a member access", "export const q = query.length;"],
    ["as the object of an optional member", "export const q = query?.length;"],
    ["as one entry of several", "export const q = [query, 1].length;"],
    [
      "as an argument beside another",
      "declare function pair(a: unknown, b: number): void;\npair(query, 1);",
    ],
  ];
  for (const [name, source] of bare) {
    test(`${name} is written as a name, not as a failed match`, () => {
      const held = explain(source);
      expect(held).toHaveLength(1);
      // Written at the name, which is the whole of what was written.
      expect(held[0]?.at.startsWith("query")).toBe(true);
      expect(held[0]?.message).toBe(message);
      expect(diagnose(source)).toEqual([]);
    });
  }

  /**
   * An export clause is not a value position: its names are specifiers, which
   * TypeScript resolves against this module's own bindings and reports on
   * itself. Reported here, a re-export of another module's name -- which the
   * emitted code does define -- was rejected as a macro written wrongly.
   */
  test("an export clause is left for TypeScript to resolve", () => {
    const source = "const query2 = 1;\nexport { query2 as a, query };";
    expect(explain(source)).toEqual([]);
    expect(diagnose(source)).toEqual([]);
  });

  test("a malformed invocation is still reported as a failed match", () => {
    const reported = diagnose("export const q = query(db) { limit 20 };");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("No rule for macro query accepted");
    expect(explain("export const q = query(db) { limit 20 };")).toEqual([]);
  });

  /**
   * A rule that read into the group written after the name was offered syntax
   * of the macro's own, however it ended. What went wrong there is what the
   * rule was still waiting for, not that the name stands alone.
   */
  test("a group a rule read into is still reported as a failed match", () => {
    const source = "export const q = query(db, 1) { from users };";
    const reported = diagnose(source);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("No rule for macro query accepted");
    expect(explain(source)).toEqual([]);
  });

  /**
   * Only a terminator, a separator and a member access say that the syntax
   * around the name goes on without it. Anything else written after a name
   * could have been a rule's: a macro may be written `q neither` or `q = 1`
   * as readily as `q(...)`, so a rule that stopped in front of one was
   * offered syntax it refused rather than a name standing alone.
   */
  test.each([
    ["a word", "export const q = query db;"],
    ["an operator", "export const q = (query = db);"],
    ["a group", "export const q = query[db];"],
  ])("%s written after the name is still a failed match", (_, source) => {
    expect(explain(source)).toEqual([]);
    expect(diagnose(source)).toHaveLength(1);
  });

  test("a name that only shares the spelling is left alone", () => {
    expect(
      explain("export const o = { query: 1 };\nexport const r = o.query;"),
    ).toEqual([]);
  });

  test("an invocation a rule accepts still expands", () => {
    expect(explain("export const q = query(db) { from users };")).toEqual([]);
  });
});
