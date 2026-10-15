import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * What a `#fold`'s accumulator is follows from where the fold stands, the way
 * what a capture is follows from the class it was matched as.
 *
 * Standing where one expression or one type is written, each step builds one
 * and the accumulator is spliced as that expression or type, so `$acc * 2 +
 * $item` keeps `$acc` together the way `$item` always was. Standing as a part
 * of a list -- an element, an argument, a statement -- the fold builds parts
 * of that list, and the accumulator is a run of them, spliced where the
 * list's own parts are written. A step that builds something else is
 * reported at the fold rather than spliced for the syntax around it to read
 * however it reads.
 */

const macros = `
export syntax scale:expr {
  rule { scale($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc * 2 + $item } }
  }
}
export syntax list:expr {
  rule { list($($x:expr),*) } => {
    [#fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc, $item } }]
  }
}
export syntax logAll:stmt {
  rule { logAll($($x:expr),*); } => {
    #fold($x, init: { }) { ($acc, $item, $index) => { $acc logged.push($item); } }
  }
}
export syntax anyOf:type {
  rule { anyOf($($t:type),*) } => {
    #fold($t, init: { never }) { ($acc, $item, $index) => { $acc | $item } }
  }
}
export syntax applied:expr {
  rule { applied($f:expr, $($x:expr),*) } => {
    $f(#fold($x, init: { }) { ($acc, $item, $index) => { $acc $item, } })
  }
}
export syntax grid:expr {
  rule { grid([$($r:expr),*], [$($c:expr),*]) } => {
    #fold($r, init: { 0 }) { ($acc, $item, $index) => {
      $acc * 10 + #fold($c, init: { $item }) { ($acc, $item, $index) => { $acc * $item - 1 } }
    } }
  }
}
export syntax pairs:expr {
  rule { pairs($($x:expr),*) } => {
    [#fold($x, init: { }) { ($acc, $item, $index) => {
      $acc [(#fold($x, init: { 1 }) { ($acc, $item, $index) => { $acc * $item } }), $item],
    } }]
  }
}
export syntax returned:stmt {
  rule { returned($($x:expr),*); } => {
    return #fold($x, init: { 1 }) { ($acc, $item, $index) => { $acc / $item } };
  }
}
export syntax scaledList:expr {
  rule { scaledList($($x:expr),*) } => {
    [#fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc * 2 + $item } }]
  }
}
export syntax statements:expr {
  rule { statements($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc; $item } }
  }
}
export syntax emptySeed:expr {
  rule { emptySeed($($x:expr),*) } => {
    #fold($x, init: { }) { ($acc, $item, $index) => { $acc + $item } }
  }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(main: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-fold-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { scale, list, logAll, anyOf, applied, grid, pairs, returned, scaledList, statements, emptySeed } from "./macros.sts" for syntax;\n${main}`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const result = runConfiguredProjectCommand({
    command: "check",
    configPath: join(directory, "tsconfig.json"),
    writeThrough: false,
  });
  const generated = result.virtualFiles.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  if (generated === undefined) throw new Error("main.sts was not expanded");
  return {
    text: generated.replaceAll(/\s+/gu, " ").trim(),
    messages: result.diagnostics.map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    ),
  };
}

/** Everything a program exports, once its expansion has parsed and run. */
function run(text: string): Record<string, unknown> {
  const transpiled = ts.transpileModule(text, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  expect(transpiled.diagnostics ?? []).toEqual([]);
  const exports: Record<string, unknown> = {};
  new Function("exports", transpiled.outputText)(exports);
  return exports;
}

describe("a fold standing as one expression", () => {
  test("splices each accumulator as the expression it is", () => {
    // Spliced as tokens, `$acc * 2 + $item` printed `0 * 2 + a * 2 + ...`,
    // which computes a different number.
    const { text, messages } = expand(
      "const a = 1, b = 2, c = true;\nexport const scaled = scale(a, b + 1, c ? 1 : 2);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain(
      "export const scaled = ((0 * 2 + a) * 2 + (b + 1)) * 2 + (c ? 1 : 2);",
    );
    expect(run(text)["scaled"]).toBe(((0 * 2 + 1) * 2 + 3) * 2 + 1);
  });

  test("does so where a statement holds it", () => {
    const { text, messages } = expand(
      "export function halved() { returned(8, 2, 2); }\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("return 1 / 8 / 2 / 2;");
    expect((run(text)["halved"] as () => number)()).toBe(1 / 8 / 2 / 2);
  });

  test("keeps a fold inside it apart, with an accumulator of its own", () => {
    const { text, messages } = expand(
      "export const g = grid([1, 2], [3, 4]);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain(
      "export const g = (0 * 10 + ((1 * 3 - 1) * 4 - 1)) * 10 + ((2 * 3 - 1) * 4 - 1);",
    );
    expect(run(text)["g"]).toBe((0 * 10 + 7) * 10 + 19);
  });

  test("reports a step that is not one expression", () => {
    const { messages } = expand("export const s = statements(1, 2);\n");
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^This #fold stands where one expression is written, so each of its steps builds one expression, and one built `.*`\.$/u,
      ),
    );
  });

  test("reports a seed that builds nothing", () => {
    const { messages } = expand("export const e = emptySeed(1, 2);\n");
    expect(messages).toContain(
      "This #fold stands where one expression is written, so each of its steps builds one expression, and one built nothing.",
    );
  });
});

describe("a fold standing as one type", () => {
  test("splices each accumulator as the type it is", () => {
    const { text, messages } = expand(
      'export const values: anyOf(string, number)[] = ["a", 1];\n',
    );
    expect(messages).toEqual([]);
    expect(text).toContain(
      "export const values: ((never | string) | number)[] =",
    );
    expect(run(text)["values"]).toEqual(["a", 1]);
  });
});

describe("a fold standing as part of a list", () => {
  test("builds array elements", () => {
    const { text, messages } = expand("export const listed = list(1, 2, 3);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("export const listed = [0, 1, 2, 3];");
    expect(run(text)["listed"]).toEqual([0, 1, 2, 3]);
  });

  test("builds arguments", () => {
    const { text, messages } = expand(
      "const sum = (...values: number[]) => values.reduce((a, b) => a + b, 0);\nexport const total = applied(sum, 1, 2, 3);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("sum(1, 2, 3,)");
    expect(run(text)["total"]).toBe(6);
  });

  test("builds statements", () => {
    const { text, messages } = expand(
      "export const logged: number[] = [];\nlogAll(1, 2);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("logged.push(1); logged.push(2);");
    expect(run(text)["logged"]).toEqual([1, 2]);
  });

  test("builds elements that hold folds of their own", () => {
    // A fold standing alone as an element builds elements; grouped, it is
    // one expression there.
    const { text, messages } = expand("export const p = pairs(2, 3);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("[[(1 * 2 * 3), 2], [(1 * 2 * 3), 3],]");
    expect(run(text)["p"]).toEqual([
      [6, 2],
      [6, 3],
    ]);
  });

  test("reports an accumulator used as an operand", () => {
    // There the accumulator is a run of elements, and `$acc * 2` would read
    // only the last of them.
    const { messages } = expand("export const s = scaledList(1, 2);\n");
    expect(messages).toContain(
      "This #fold stands where a list of elements is written, so its accumulator is a run of those and is written only between them, not inside one or beside an operator.",
    );
  });
});
