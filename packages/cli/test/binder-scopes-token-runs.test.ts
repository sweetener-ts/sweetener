import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Where a binder hides a macro of its spelling, when the binder stands in a
 * run of tokens the walk binds rather than in nodes the reader built.
 *
 * The reader leaves a block unread when it holds a statement operator -- here
 * `got <- one;` -- and the walk then reads the block's statements from its
 * tokens. Each case is written in such a block: a parameter is bound in its
 * function, a `catch` binding in its block, a loop variable in its loop, a
 * block's `const`, class and functions in the block, `var` in the function
 * around it, a function expression's name inside that expression, a type
 * parameter in what declares it, a mapped type's key in that type, and what
 * `infer` names in its `extends` clause and true branch. A run of tokens used
 * to bind every name it held in the whole run, so a parameter hid the macro
 * from what came after its function.
 *
 * `binder-scopes.test.ts` asks the same of the file's own items and of an item
 * macro's replay. An item replacement is read by the item reader, so that
 * replay no longer reaches a run of tokens; this block does.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { ($value + $value) }
}
export syntax boxed:type {
  rule { boxed } => { readonly number[] }
}
export operator (<-):stmt {
  fixity infix;
  associativity none;
  precedence 20;
  rule { $name:binding <- $source:expr; }
  bind $name in following as lexical value;
  => { const $name = $source; }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

/** `statements` expanded in a block the reader leaves as tokens. */
function expandInTokenRun(statements: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-binder-token-run-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice, boxed, (<-) } from "./macros.sts" for syntax;\ntype Fn = (v: number) => number;\nexport function f(): number {\n  const one = 1;\n  got <- one;\n${statements}\n  return got;\n}\n`,
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
    messages: result.diagnostics.map(({ messageText }) =>
      ts.flattenDiagnosticMessageText(messageText, "\n"),
    ),
  };
}

interface Boundary {
  readonly name: string;
  readonly source: string;
  /** Text standing where the binder is in scope, left as it was written. */
  readonly inside: readonly string[];
  /** Text the macro expands to where the binder is out of scope. */
  readonly outside: readonly string[];
}

const boundaries: readonly Boundary[] = [
  {
    name: "a function's parameter",
    source:
      "function g(twice: Fn): number { return twice(1); }\nconst after = twice(2);",
    inside: ["return twice(1);"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "an arrow's parameter",
    source:
      "const g = (twice: Fn): number => twice(1);\nconst after = twice(2);",
    inside: ["=> twice(1)"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "an arrow's unparenthesized parameter",
    source:
      "const g: (h: Fn) => number = twice => twice(1);\nconst after = twice(2);",
    inside: ["=> twice(1)"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a catch binding",
    source:
      "try { void twice(1); } catch (twice) { void twice; } finally { void twice(3); }",
    inside: ["catch (twice) { void twice; }"],
    outside: ["void (1 + 1)", "void (3 + 3)"],
  },
  {
    name: "a for-of loop's variable",
    source:
      "for (const twice of [(v: number) => v]) { void twice(1); }\nconst after = twice(2);",
    inside: ["void twice(1);"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a for loop's variable",
    source:
      "for (let twice = 0; twice < 1; twice++) { void twice; }\nconst after = twice(2);",
    inside: ["twice < 1; twice++"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a block's const",
    source:
      "{ const twice = (v: number) => v; void twice(1); }\nconst after = twice(2);",
    inside: ["void twice(1);"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a block's class",
    source:
      "{ class twice { static n = 1; } void twice.n; }\nconst after = twice(2);",
    inside: ["void twice.n;"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a block's function",
    source:
      "{ function twice(v: number): number { return v; } void twice(1); }\nconst after = twice(2);",
    inside: ["void twice(1);"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a block's generator",
    source:
      "{ function* twice(v: number): Generator<number> { yield v; } void twice(1); }\nconst after = twice(2);",
    inside: ["void twice(1);"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a function declared under a declaration that has no semicolon",
    source:
      "const k = 1\nfunction twice(v: number): number { return v + k }\nconst after = twice(got)",
    inside: ["after = twice(got)"],
    outside: [],
  },
  {
    name: "a var in a nested function's block",
    source:
      "function g(): number { { var twice: Fn = (v) => v; } return twice(1); }\nconst after = twice(2);",
    inside: ["return twice(1);"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a function expression's name",
    source:
      "const g = function twice(v: number): number { return v > 0 ? twice(v - 1) : 0; };\nconst after = twice(2);",
    inside: ["? twice(v - 1)"],
    outside: ["after = (2 + 2)"],
  },
  {
    name: "a type alias's type parameter",
    source: "type P<boxed> = boxed[];\ntype After = boxed;",
    inside: ["P<boxed> = boxed[];"],
    outside: ["After = readonly number[]"],
  },
  {
    name: "a type alias's type parameter, with no semicolon",
    source: "type P<boxed> = boxed[]\ntype After = boxed",
    inside: ["P<boxed> = boxed[]"],
    outside: ["After = readonly number[]"],
  },
  {
    name: "a generic arrow's type parameter",
    source: "const g = <boxed,>(v: boxed): boxed => v;\ntype After = boxed;",
    inside: ["<boxed,>(v: boxed): boxed => v"],
    outside: ["After = readonly number[]"],
  },
  {
    name: "what `infer` declares",
    source: "type E<X> = X extends Array<infer boxed> ? boxed : boxed;",
    inside: ["Array<infer boxed> ? boxed :"],
    outside: [": readonly number[]"],
  },
  {
    name: "a mapped type's key",
    source: "type M<K extends string> = { [boxed in K]: boxed } | boxed;",
    inside: ["[boxed in K]: boxed }"],
    outside: ["| readonly number[]"],
  },
  {
    name: "a function type's type parameter",
    source: "type Call = <boxed>(x: boxed) => boxed;\ntype After = boxed;",
    inside: ["<boxed>(x: boxed) => boxed"],
    outside: ["After = readonly number[]"],
  },
  {
    name: "a constructor type's type parameter",
    source: "type Make = new <boxed>(x: boxed) => boxed;\ntype After = boxed;",
    inside: ["new <boxed>(x: boxed) => boxed"],
    outside: ["After = readonly number[]"],
  },
  {
    name: "a type parameter declared `in out`",
    source: "type Box<in out boxed> = { v: boxed };\ntype After = boxed;",
    inside: ["Box<in out boxed> = { v: boxed }"],
    outside: ["After = readonly number[]"],
  },
];

describe("a binder's scope in a run of tokens", () => {
  for (const { name, source, inside, outside } of boundaries) {
    test(`${name} hides the macro inside it and not outside`, () => {
      const expanded = expandInTokenRun(source);
      expect(expanded.messages).toEqual([]);
      // The statement operator expanded, so the block was the walk's to read.
      expect(expanded.text).toContain("const got = one;");
      for (const kept of inside) expect(expanded.text).toContain(kept);
      for (const expansion of outside)
        expect(expanded.text).toContain(expansion);
      if (outside.length === 0) expect(expanded.text).not.toContain(" + ");
    });
  }
});
