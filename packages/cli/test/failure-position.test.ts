import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function diagnose(source: string, code = 4001) {
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
  return expanded.diagnostics
    .filter((diagnostic) => diagnostic.code === code)
    .map(({ start, messageText }) => ({
      at: text.slice(start ?? 0, (start ?? 0) + 12),
      message: String(messageText),
    }));
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
    [
      "in an export clause",
      "const query2 = 1;\nexport { query2 as a, query };",
    ],
    ["as an object literal shorthand", "export const q = { query };"],
  ];
  for (const [name, source] of bare) {
    test(`${name} is reported as a name, not as a failed match`, () => {
      const reported = diagnose(source, 4024);
      expect(reported).toHaveLength(1);
      // Reported at the name, which is the whole of what was written.
      expect(reported[0]?.at.startsWith("query")).toBe(true);
      expect(reported[0]?.message).toBe(message);
      expect(diagnose(source)).toEqual([]);
    });
  }

  test("a malformed invocation is still reported as a failed match", () => {
    const reported = diagnose("export const q = query(db) { limit 20 };");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain("No rule for macro query accepted");
    expect(diagnose("export const q = query(db) { limit 20 };", 4024)).toEqual(
      [],
    );
  });

  test("a name that only shares the spelling is left alone", () => {
    expect(
      diagnose(
        "export const o = { query: 1 };\nexport const r = o.query;",
        4024,
      ),
    ).toEqual([]);
  });

  test("an invocation a rule accepts still expands", () => {
    expect(
      diagnose("export const q = query(db) { from users };", 4024),
    ).toEqual([]);
  });
});
