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

function diagnose(source: string) {
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
    .filter(({ code }) => code === 4001)
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
