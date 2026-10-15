import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * An expression a macro produces is printed so that it reads back as the
 * expression it is, wherever it lands.
 *
 * Its own operators are not the only thing that can come apart. A position can
 * keep certain tokens out of its first place -- an expression statement and
 * `export default` read `function` and `class` as declarations, and a
 * statement or an arrow's concise body reads `{` as a block -- and an operator
 * written around an arrow runs into the arrow's body. Each of these printed
 * code that did not parse, or worse, code that parsed as something else and
 * type-checked: `() => obj(1)` printed `() => { value: 1 }`, a function
 * returning nothing.
 *
 * Every case is checked for what TypeScript reads, by parsing, type-checking
 * and running what was printed, not only for how it is spelled.
 */

const macros = `
export syntax obj:expr { rule { obj($v:expr) } => { { value: $v } } }
export syntax fn1:expr { rule { fn1($v:expr) } => { function () { return $v; } } }
export syntax afn:expr { rule { afn($v:expr) } => { async function () { return $v; } } }
export syntax cls:expr { rule { cls($v:expr) } => { class { value = $v; } } }
export syntax arrow:expr { rule { arrow($v:expr) } => { () => $v } }
export syntax first:expr {
  rule { first() } => { (strings: TemplateStringsArray) => strings[0] }
}
export syntax optional:expr { rule { optional($o:expr) } => { $o?.f } }
export syntax make:expr { rule { make($f:expr) } => { $f() } }
export syntax either:expr { rule { either($a:expr, $b:expr) } => { $a || $b } }
export syntax neg:expr { rule { neg($a:expr) } => { -$a } }
export syntax parameter it:expr;
export syntax withObject:expr {
  rule { withObject($body:expr) } => { #parameterize(it = { value: 6 }) { $body } }
}
export syntax sum:expr { rule { sum($a:expr, $b:expr) } => { $a + $b } }
export syntax members:expr {
  rule { members($v:expr) } => {
    {
      lookup: (key: string): Map<string, number> => new Map([[key, sum($v, 1)]]),
      made: make<string, number>(sum($v, 2)),
      pair: <A, B>(a: A, b: B): [A, B] => [a, b],
      low: $v < 2,
      high: $v > 0,
    }
  }
}
export syntax listOf:type { rule { listOf($t:type) } => { Array<$t> } }
export syntax has:expr { rule { has($k:expr, $o:expr) } => { $k in $o } }
export syntax scale:expr {
  rule { scale($($x:expr),*) } => {
    #fold($x, init: { 0 }) { ($acc, $item, $index) => { ($acc) * 2 + $item } }
  }
}
export syntax list:expr {
  rule { list($($x:expr),*) } => {
    [#fold($x, init: { 0 }) { ($acc, $item, $index) => { $acc, $item } }]
  }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
  readonly exports: Record<string, unknown>;
}

function expand(main: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-result-grouping-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { obj, fn1, afn, cls, arrow, first, optional, make, either, neg, it, withObject, sum, members, listOf, has, scale, list } from "./macros.sts" for syntax;\n${main}`,
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
        allowUnusedLabels: false,
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
  const transpiled = ts.transpileModule(generated, {
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const syntaxErrors = (transpiled.diagnostics ?? []).map(({ messageText }) =>
    ts.flattenDiagnosticMessageText(messageText, "\n"),
  );
  if (syntaxErrors.length > 0)
    throw new Error(
      `The expansion does not parse: ${syntaxErrors.join("; ")}\n${generated}`,
    );
  const exports: Record<string, unknown> = {};
  new Function("exports", transpiled.outputText)(exports);
  return {
    text: generated.replaceAll(/\s+/gu, " ").trim(),
    messages: result.diagnostics.map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    ),
    exports,
  };
}

describe("an expression a macro produces, where it begins something", () => {
  test("is an object literal as an arrow's concise body", () => {
    const { text, messages, exports } = expand(
      "export const make = () => obj(1);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const make = () => ({ value: 1 });");
    expect((exports["make"] as () => unknown)()).toEqual({ value: 1 });
  });

  test("is an object literal when it begins the body before an access", () => {
    const { text, messages, exports } = expand(
      "export const read = () => obj(2).value;\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("() => ({ value: 2 }).value;");
    expect((exports["read"] as () => unknown)()).toBe(2);
  });

  test("is an object literal at the start of a statement, and its key no label", () => {
    // Read as a block, `value:` was a label, and hygiene renamed it.
    const { text, messages } = expand("obj(3);\nobj(4).value;\n");
    expect(messages).toEqual([]);
    expect(text).toContain("({ value: 3 });");
    expect(text).toContain("({ value: 4 }).value;");
    expect(text).not.toContain("value_");
  });

  test("is a function expression when a statement calls it", () => {
    const { text, messages, exports } = expand(
      "export let seen = 0;\nfn1((seen = 3))();\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(function () { return (seen = 3); })();");
    expect(exports["seen"]).toBe(3);
  });

  test("is an async function expression when a statement calls it", () => {
    const { text, messages } = expand("afn(1)();\n");
    expect(messages).toEqual([]);
    expect(text).toContain("(async function () { return 1; })();");
  });

  test("is a class expression at the start of a statement", () => {
    const { text, messages } = expand("cls(1);\n");
    expect(messages).toEqual([]);
    expect(text).toContain("(class { value = 1; });");
  });

  test("is a function expression after export default", () => {
    const { text, messages, exports } = expand("export default fn1(5)();\n");
    expect(messages).toEqual([]);
    expect(text).toContain("export default (function () { return 5; })();");
    expect(exports["default"]).toBe(5);
  });

  test("is an object literal a syntax parameter stands for", () => {
    const { text, messages, exports } = expand(
      "export const make = withObject(() => it);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("() => ({ value: 6 })");
    expect((exports["make"] as () => unknown)()).toEqual({ value: 6 });
  });

  test("needs nothing where an expression already stands", () => {
    const { text, messages } = expand(
      "export const held = obj(1);\nexport const called = fn1(2)();\nexport const listed = [obj(3), arrow(4)];\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const held = { value: 1 };");
    expect(text).toContain(
      "export const called = function () { return 2; }();",
    );
    expect(text).toContain("export const listed = [{ value: 3 }, () => 4];");
  });
});

describe("an arrow a macro produces, as an operand", () => {
  test("of a logical operator, on its right", () => {
    const { text, messages, exports } = expand(
      "export const p = true && arrow(1);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const p = true && (() => 1);");
    expect((exports["p"] as () => unknown)()).toBe(1);
  });

  test("of a binary operator, on its left", () => {
    // Unparenthesized, the operator joined the arrow's body:
    // `() => 0 instanceof Function`, a function that returns false.
    const { text, messages, exports } = expand(
      "export const q = arrow(0) instanceof Function;\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const q = (() => 0) instanceof Function;");
    expect(exports["q"]).toBe(true);
  });

  test("tested by a conditional", () => {
    // TypeScript can only call the test always truthy once it reads the
    // arrow as the test, rather than the conditional as the arrow's body.
    const { text, messages, exports } = expand(
      'export const r = arrow(1) ? "yes" : "no";\n',
    );
    expect(messages).toEqual(["This kind of expression is always truthy."]);
    expect(text).toContain('(() => 1) ? "yes" : "no"');
    expect(exports["r"]).toBe("yes");
  });

  test("of typeof, of an optional chain and of a tag", () => {
    const { text, messages, exports } = expand(
      "export const t = typeof arrow(1);\nexport const n = arrow(1)?.length;\nexport const tagged = first()`x`;\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("typeof (() => 1)");
    expect(text).toContain("(() => 1)?.length");
    expect(text).toContain(
      "((strings: TemplateStringsArray) => strings[0]) `x`",
    );
    expect(exports).toMatchObject({ t: "function", n: 0, tagged: "x" });
  });

  test("but not where an assignment expression stands", () => {
    const { text, messages } = expand(
      "export let f: unknown;\nf = arrow(1);\nexport function* g() { yield arrow(2); }\nconst x = true as boolean;\nexport const h = x ? arrow(3) : arrow(4);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("f = () => 1;");
    expect(text).toContain("yield () => 2;");
    expect(text).toContain("x ? () => 3 : () => 4");
  });
});

describe("an optional chain a macro produces", () => {
  const none = `const none = undefined as { f(): number } | undefined;
const fails = (run: () => unknown) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};
`;

  test("keeps a call after it out of the chain", () => {
    // `none?.f()` short-circuits to undefined; `(none?.f)()` throws, which
    // TypeScript can only say once it reads the call as outside the chain.
    const { text, messages, exports } = expand(
      `${none}export const called = fails(() => optional(none)());\n`,
    );
    expect(messages).toEqual([
      "Cannot invoke an object which is possibly 'undefined'.",
    ]);
    expect(text).toContain("(none?.f)()");
    expect(exports["called"]).toBe(true);
  });

  test("keeps an access after it out of the chain", () => {
    const { text, exports } = expand(
      `${none}export const accessed = fails(() => optional(none).name);\n`,
    );
    expect(text).toContain("(none?.f).name");
    expect(exports["accessed"]).toBe(true);
  });

  test("keeps going where the chain continues it", () => {
    const { text, messages } = expand(
      `${none}export const chained = optional(none)?.name;\n`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("none?.f?.name");
  });
});

describe("what `new` constructs", () => {
  test("keeps the call a macro produced", () => {
    // `new factory()()` constructs `factory` and calls what it returns.
    const { text, messages, exports } = expand(
      `class Box { value = 1; }
const factory = () => Box;
export const box = new make(factory)();
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("new (factory())()");
    expect(exports["box"]).toMatchObject({ value: 1 });
  });

  test("keeps an optional chain a macro produced", () => {
    const { text } = expand(
      `const holder = { f: class { value = 2; } } as { f: new () => { value: number } } | undefined;
export const built = new optional(holder)();
`,
    );
    expect(text).toContain("new (holder?.f)()");
  });
});

describe("operator positions that already held", () => {
  test("keep their parentheses", () => {
    const { text, messages, exports } = expand(
      `const a = 0 as number | undefined, b = 2, c = 3;
export const coalesced = either(a, b) ?? c;
export const squared = neg(2) ** 2;
export const negated = -neg(1);
const A = class { kind = "a"; }, B = class { kind = "b"; };
export class K extends either(A, B) {}
const o = { a: 1 };
let found = false;
for (let present = has("a", o); !found; ) found = present;
export const sawIt = found;
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("(a || b) ?? c");
    expect(text).toContain("(-2) ** 2");
    expect(text).toContain("-(-1)");
    expect(text).toContain("extends (A || B)");
    expect(text).toContain('let present = ("a" in o)');
    expect(exports).toMatchObject({
      coalesced: 2,
      squared: 4,
      negated: 1,
      sawIt: true,
    });
    expect(new (exports["K"] as new () => object)()).toMatchObject({
      kind: "a",
    });
  });
});

describe("an object literal a template writes", () => {
  test("keeps a member whole across the commas of its angle brackets", () => {
    // Split at those commas, `made: make<string, number>(...)` printed
    // `(make<string), number>(...)`, and the `Map` of the return type was
    // taken for a binder and renamed.
    const { text, messages, exports } = expand(
      `function make<K, V>(value: V): Map<K, V> {
  return new Map<K, V>([["made" as K, value]]);
}
export const o = members(1);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain(
      "lookup: (key: string): Map<string, number> => new Map([[key, 1 + 1]])",
    );
    expect(text).toContain("made: make<string, number>(1 + 2)");
    expect(text).toContain("pair: <A, B>(a: A, b: B): [A, B] => [a, b]");
    expect(text).toContain("low: 1 < 2, high: 1 > 0");
    const o = exports["o"] as {
      lookup(key: string): Map<string, number>;
      made: Map<string, number>;
      low: boolean;
      high: boolean;
    };
    expect(o.lookup("k").get("k")).toBe(2);
    expect(o.made.get("made")).toBe(3);
    expect(o).toMatchObject({ low: true, high: true });
  });
});

describe("an expression standing whole", () => {
  test("needs no parentheses wherever an assignment expression stands", () => {
    const { text, messages, exports } = expand(
      `export const value = sum(1, 2);
export const held = { total: sum(3, 4), run: arrow(5) };
const xs = undefined as number[] | undefined, ys = [1, 2];
export const spread = [...either(xs, ys)];
export function given() { return sum(7, 8); }
export function thrown() { throw sum(9, 10); }
export let seen = 0;
seen = sum(11, 12);
sum(seen, 1);
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const value = 1 + 2;");
    expect(text).toContain("{ total: 3 + 4, run: () => 5 }");
    expect(text).toContain("[...xs || ys]");
    expect(text).toContain("return 7 + 8;");
    expect(text).toContain("throw 9 + 10;");
    expect(text).toContain("seen = 11 + 12;");
    expect(text).toContain("seen + 1;");
    expect(exports).toMatchObject({ value: 3, spread: [1, 2], seen: 23 });
  });

  test("needs no parentheses as a type argument", () => {
    const { text, messages } = expand(
      "export const values: listOf(string | null) = [null];\nexport const rows: listOf(number | null)[] = [[null]];\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("values: Array<string | null> =");
    expect(text).toContain("rows: Array<number | null>[] =");
  });

  test("keeps `in` out of a for header's first clause", () => {
    const { text, messages } = expand(
      `const o = { a: 1 };
for (has("a", o); ; ) break;
for (let present = has("a", o); ; ) break;
`,
    );
    expect(messages).toEqual([]);
    expect(text).toContain('for (("a" in o); ; )');
    expect(text).toContain('for (let present = ("a" in o); ; )');
  });
});

describe("the space after a closing bracket", () => {
  test("follows what the bracket closed, not how it is spelled", () => {
    const { text } = expand(
      `export const called = fn1(1)();
const flag = true as boolean;
if (flag) obj(2);
export const joined = obj(3) + "";
`,
    );
    // The braces of a function expression and of an object literal end an
    // operand; the parenthesis of an `if` header does not.
    expect(text).toContain("function () { return 1; }();");
    expect(text).toContain("if (flag) ({ value: 2 });");
    expect(text).toContain('{ value: 3 } + ""');
  });
});

describe("a fold's accumulator", () => {
  test("is spliced as written, so a list can be built from it", () => {
    const { text, messages, exports } = expand(
      "export const listed = list(1, 2, 3);\n",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("[0, 1, 2, 3]");
    expect(exports["listed"]).toEqual([0, 1, 2, 3]);
  });

  test("keeps the grouping its template writes around it", () => {
    const { messages, exports } = expand(
      "const a = 1, b = 2, c = true;\nexport const scaled = scale(a, b + 1, c ? 1 : 2);\n",
    );
    expect(messages).toEqual([]);
    expect(exports["scaled"]).toBe(((0 * 2 + 1) * 2 + 3) * 2 + 1);
  });
});
