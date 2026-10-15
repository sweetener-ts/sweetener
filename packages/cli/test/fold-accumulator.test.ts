import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * What a `#fold`'s accumulator is follows from how its step writes `$acc`, the
 * way what a capture is follows from the class it is declared with.
 *
 * Written as an operand, `$acc` is one expression or one type -- whichever is
 * read where the fold stands -- built a step at a time with the accumulator
 * before each step read as one node, so `$acc * 2 + $item` keeps `$acc`
 * together the way `$item` always was. Written as a part of a list, it is the
 * run of parts built so far, spliced as those parts. A step that writes it
 * both ways is reported where the template is defined.
 */

const macros = `
export syntax scale:expr {
  rule { scale($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc * 2 + $item } }
  }
}
export syntax total:expr {
  rule { total($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc + $item } }
  }
}
export syntax list:expr {
  rule { list($($x:expr),*) } => {
    [#fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc, $item } }]
  }
}
export syntax listed:expr {
  rule { listed($($x:expr),*) } => {
    [#fold($x, init: { }) { ($acc, $item, $index) => { $acc $item, } }]
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
export syntax arrayOf:type {
  rule { arrayOf($($t:type),*) } => {
    Array<#fold($t, init: { never }) { ($acc, $item, $index) => { $acc | $item } }>
  }
}
export syntax mapOf:type {
  rule { mapOf($($t:type),*) } => {
    Map<#fold($t, init: { string }) { ($acc, $item, $index) => { $acc, $item } }>
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
      $acc [#fold($x, init: { 1 }) { ($acc, $item, $index) => { $acc * $item } }, $item],
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
export syntax twice:expr { rule { twice($e:expr) } => { $e * 2 } }
export syntax inner:expr { rule { inner($e:expr) } => { [$e] } }
export syntax doubling:expr {
  rule { doubling($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { twice($acc) - $item } }
  }
}
export syntax handed:expr {
  rule { handed($($x:expr),*) } => {
    inner(1 + #fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc - $item } })
  }
}
export syntax spelled:expr {
  rule { spelled($($x:expr),*) } => {
    \`v=\${#fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc - $item } }}\`
  }
}
export syntax juxtaposed:expr {
  rule { juxtaposed($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { ($acc) $item } }
  }
}
`;

const names = [...macros.matchAll(/export syntax (\w+)/gu)].map(
  ([, name]) => name!,
);

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly diagnostics: readonly ts.Diagnostic[];
  readonly messages: readonly string[];
}

function expand(main: string, definitions = macros): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-fold-"));
  writeFileSync(join(directory, "macros.sts"), definitions);
  const exported = [...definitions.matchAll(/export syntax (\w+)/gu)].map(
    ([, name]) => name!,
  );
  writeFileSync(
    join(directory, "main.sts"),
    `import { ${(definitions === macros ? names : exported).join(", ")} } from "./macros.sts" for syntax;\n${main}`,
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
  return {
    text: (generated ?? "").replaceAll(/\s+/gu, " ").trim(),
    diagnostics: result.diagnostics,
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

describe("a fold whose step writes $acc as an operand", () => {
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

  test("is one expression standing alone as an element", () => {
    const { text, messages } = expand("export const s = scaledList(1, 2);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("export const s = [(0 * 2 + 1) * 2 + 2];");
    expect(run(text)["s"]).toEqual([4]);
  });

  test("hands each accumulator to a macro written in the step as one expression", () => {
    // The step's `twice` reads the accumulator before it as the one
    // expression it is, already built, rather than as a marker it cannot
    // match.
    const { text, messages } = expand("export const d = doubling(1, 2);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("export const d = (0 * 2 - 1) * 2 - 2;");
    expect(run(text)["d"]).toBe((0 * 2 - 1) * 2 - 2);
  });

  test("is one operand to a macro written around it", () => {
    const { text, messages } = expand("export const h = handed(1, 2);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("export const h = [1 + (0 - 1 - 2)];");
    expect(run(text)["h"]).toEqual([1 + (0 - 1 - 2)]);
  });

  test("is built inside a template literal's substitution", () => {
    const { text, messages } = expand("export const t = spelled(1, 2);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("export const t = `v=${(0 - 1 - 2)}`;");
    expect(run(text)["t"]).toBe("v=-3");
  });

  test("reports a step that is not one expression, once, where it is used", () => {
    const { diagnostics, messages } = expand(
      "export const j = juxtaposed(1, 2);\n",
    );
    // Nothing around the fold is reported as well: it stands as one operand.
    expect(messages).toEqual([
      "This #fold builds one expression, and one of its steps built `( 0) 1`.",
    ]);
    const [reported] = diagnostics;
    expect(reported?.file?.fileName).toMatch(/main\.sts$/u);
    expect(reported?.relatedInformation?.[0]?.messageText).toBe(
      "The #fold is written here",
    );
    expect(reported?.relatedInformation?.[0]?.file?.fileName).toMatch(
      /macros\.sts$/u,
    );
  });
});

describe("a fold whose step writes $acc as a type", () => {
  test("splices each accumulator as the type it is, one union deep", () => {
    const { text, messages } = expand(
      'export const values: anyOf(string, number)[] = ["a", 1];\n',
    );
    expect(messages).toEqual([]);
    expect(text).toContain(
      "export const values: (never | string | number)[] =",
    );
    expect(run(text)["values"]).toEqual(["a", 1]);
  });

  test("builds a type argument", () => {
    const { text, messages } = expand(
      'export const values: arrayOf(string, number) = ["a", 1];\n',
    );
    expect(messages).toEqual([]);
    expect(text).toContain(
      "export const values: Array<never | string | number> =",
    );
  });
});

describe("a fold whose step writes $acc as a part of a list", () => {
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

  test("builds type arguments", () => {
    const { text, messages } = expand(
      "export const map: mapOf(number) = new Map();\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const map: Map<string, number> =");
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
    // The bracket after `$acc` begins the next element: the step builds a
    // list, so it is not an index.
    const { text, messages } = expand("export const p = pairs(2, 3);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("[[1 * 2 * 3, 2], [1 * 2 * 3, 3],]");
    expect(run(text)["p"]).toEqual([
      [6, 2],
      [6, 3],
    ]);
  });
});

describe("a fold over many items", () => {
  const items = (count: number, item: (at: number) => string) =>
    Array.from({ length: count }, (_, at) => item(at)).join(", ");

  test("builds ten thousand of them, nested no deeper than one step", () => {
    const count = 10_000;
    const numbers = items(count, String);
    const { text, messages } = expand(
      [
        `export const sum = total(${numbers});`,
        `export const elements = listed(${numbers});`,
        `export const logged: number[] = [];`,
        `logAll(${numbers});`,
        `export const value: anyOf(${items(count, (at) => `"t${String(at)}"`)}) = "t9999";`,
      ].join("\n"),
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const sum = 0 + 0 + 1 + 2 + 3 +");
    expect(text).toContain('never | "t0" | "t1" |');
    const exported = run(text);
    expect(exported["sum"]).toBe((count * (count - 1)) / 2);
    expect(exported["elements"]).toHaveLength(count);
    expect(exported["logged"]).toHaveLength(count);
  }, 120_000);

  test("reports one that nests deeper than the limit as nesting", () => {
    // Each accumulator stands inside a product, which the sum of the next
    // step holds: the expression is as deep as the list is long.
    const { messages } = expand(
      `export const deep = scale(${items(1_100, String)});\n`,
    );
    expect(messages).toEqual([
      "Expanding scale reached the nesting-depth limit. No further macros in it were expanded.",
    ]);
  });
});

describe("a step that writes $acc ambiguously", () => {
  const defined = (step: string, initial = "0") => `
export syntax folded:expr {
  rule { folded($($x:expr),*) } => {
    #fold($x, init: { ${initial} }) { ($acc, $item, $index) => { ${step} } }
  }
}
`;
  /** The one diagnostic, and the text of the template where it points. */
  function reported(definitions: string) {
    const { diagnostics, messages } = expand(
      "export const f = folded(1, 2);\n",
      definitions,
    );
    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic?.file?.fileName).toMatch(/macros\.sts$/u);
    return {
      message: messages[0],
      at: definitions.slice(diagnostic!.start!),
    };
  }

  test("is reported where it is written both ways", () => {
    const { message, at } = reported(defined("$acc, $acc + $item"));
    expect(message).toBe(
      "This #fold writes $acc both as an operand and as a part of the list its step builds.",
    );
    expect(at).toMatch(/^\$acc \+ \$item/u);
  });

  test("is reported where an operand's step builds a list", () => {
    const { message, at } = reported(defined("$acc + $item,"));
    expect(message).toBe(
      "This #fold writes $acc as an operand, so each step builds one expression or one type, and this step builds a list: a `,` or `;` stands outside its brackets.",
    );
    expect(at).toMatch(/^\$acc \+ \$item,/u);
  });

  test("is reported where an operand starts from nothing", () => {
    const { message, at } = reported(defined("$acc + $item", ""));
    expect(message).toBe(
      "This #fold writes $acc as an operand, so its initial template builds one expression or one type, and it is empty.",
    );
    expect(at).toMatch(/^\{ *\}/u);
  });
});
