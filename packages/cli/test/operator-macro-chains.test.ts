import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A chain of operator macros as long or as deep as an author writes it.
 *
 * Each operator's expansion holds what the one before it built, as it was
 * built, so a chain costs what it adds; one whose template goes on with the
 * chain of core operators it holds is opened into it, so it nests no deeper
 * than one step does; and the walk descends into what does nest without
 * recursing, so the nesting limit, and not the call stack, is what stops it.
 */

const macros = `
export operator (<+>):expr {
  fixity infix; associativity left; precedence 130;
  rule { $a:expr <+> $b:expr } => { $a + $b }
}
export operator (<*>):expr {
  fixity infix; associativity left; precedence 140;
  rule { $a:expr <*> $b:expr } => { $a * $b }
}
export operator (<**>):expr {
  fixity infix; associativity right; precedence 150;
  rule { $a:expr <**> $b:expr } => { $a ** $b }
}
export operator (<&>):expr {
  fixity infix; associativity left; precedence 130;
  rule { $a:expr <&> $b:expr } => { ($a + $b) }
}
export operator (<|>):expr {
  fixity infix; associativity right; precedence 130;
  rule { $a:expr <|> $b:expr } => { ($a + $b) }
}
export operator (<@>):expr {
  fixity infix; associativity left; precedence 130;
  rule { $a:expr <@> $b:expr } => { ($a <@> $b) }
}
export rec syntax grow:expr { rule { grow($v:expr) } => { (grow(($v))) } }
`;

const declared =
  "declare let v0: number, v1: number, v2: number, v3: number, v4: number;\n";

function expand(main: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-operator-chains-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { (<+>), (<*>), (<**>), (<&>), (<|>), (<@>), grow } from "./macros.sts" for syntax;\n${declared}${main}\n`,
  );
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(
    configPath,
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
  const output = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(configPath),
  );
  const text =
    output.files
      .find(({ fileName }) => fileName.endsWith("main.ts"))
      ?.generated.text.replace(declared, "")
      .trim() ?? "";
  const messages = output.diagnostics.map(({ messageText }) =>
    ts.flattenDiagnosticMessageText(messageText, "\n"),
  );
  return { text, messages };
}

/** `count` operands, `v0` to `v4` in turn, joined by what `operator` says. */
const chain = (count: number, operator: (at: number) => string) =>
  Array.from({ length: count }, (_, at) =>
    at === 0 ? "v0" : `${operator(at)} v${String(at % 5)}`,
  ).join(" ");

/**
 * How TypeScript groups `text`, with every parenthesis that groups nothing
 * the tree does not already say left out: each binary expression written as
 * its operator over its two operands.
 */
function grouping(text: string): string {
  const describe = (node: ts.Node): string => {
    if (ts.isParenthesizedExpression(node)) return describe(node.expression);
    if (ts.isBinaryExpression(node))
      return `(${describe(node.left)} ${node.operatorToken.getText()} ${describe(node.right)})`;
    if (ts.isIdentifier(node)) return node.text;
    return `${ts.SyntaxKind[node.kind]}[${node
      .getChildren()
      .map(describe)
      .join(" ")}]`;
  };
  return describe(
    ts.createSourceFile("grouping.ts", text, ts.ScriptTarget.Latest, true),
  );
}

const limitReached = (spelling: string) =>
  `Expanding ${spelling} reached the nesting-depth limit. No further macros in it were expanded.`;

/**
 * Expanded without TypeScript's checker, which reads a chain this long in
 * time that grows with its square on its own.
 */
describe("a chain of a user infix operator", () => {
  test.each([300, 1_000, 10_000])(
    "of %d left-associative terms is one chain",
    (count) => {
      const { text, messages } = expand(
        `export const s = ${chain(count, () => "<+>")};`,
      );
      expect(messages).toEqual([]);
      expect(text).toBe(`export const s = (${chain(count, () => "+")});`);
    },
  );

  test.each([300, 1_000, 10_000])(
    "of %d right-associative terms is one chain",
    (count) => {
      const { text, messages } = expand(
        `export const s = ${chain(count, () => "<**>")};`,
      );
      expect(messages).toEqual([]);
      expect(text).toBe(`export const s = (${chain(count, () => "**")});`);
    },
  );

  test("of ten thousand terms at three levels is a chain of chains", () => {
    const operators = ["<+>", "<*>", "<**>", "<*>"];
    const { text, messages } = expand(
      `export const s = ${chain(10_000, (at) => operators[at % 4]!)};`,
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      `export const s = (${chain(10_000, (at) => operators[at % 4]!.slice(1, -1))});`,
    );
  });

  test("groups as its operators' levels say", () => {
    const { text, messages } = expand(
      [
        `export const s = v0 <+> v1 <*> v2 <**> v3 <+> v4 <**> v1 <*> v2;`,
        `export const t = (v0 <+> v1) <**> v2 <**> v3;`,
      ].join("\n"),
    );
    expect(messages).toEqual([]);
    expect(grouping(text)).toBe(
      grouping(
        [
          `export const s = v0 + v1 * v2 ** v3 + v4 ** v1 * v2;`,
          `export const t = (v0 + v1) ** v2 ** v3;`,
        ].join("\n"),
      ),
    );
  });
});

describe("an operand before an operator the scanner splits", () => {
  test("goes on past a `<` that does not begin the operator", () => {
    // The capture before `<+>` stopped at any `<`, and so at the type
    // arguments of a call, where the rule then looked for `+`.
    const { text, messages } = expand(
      "declare function id<T>(value: T): T;\n" +
        "export const s = id<number>(v0) <+> v1;",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("export const s = (id<number>(v0) + v1);");
  });
});

describe("a chain whose expansion nests", () => {
  test.each([
    ["left", "<&>"],
    ["right", "<|>"],
  ])("as deep as the nesting limit expands (%s)", (_, operator) => {
    // 1,025 terms are 1,024 expansions, each one level inside the next.
    const { text, messages } = expand(
      `export const s = ${chain(1_025, () => operator)};`,
    );
    expect(messages).toEqual([]);
    expect(text.match(/\(+/u)?.[0].length).toBe(operator === "<&>" ? 1_024 : 1);
    expect(text.split("(").length - 1).toBe(1_024);
  });

  test.each([
    ["left", "<&>", 1_026],
    ["right", "<|>", 1_026],
    ["left", "<&>", 10_000],
    ["right", "<|>", 10_000],
  ])(
    "deeper than the nesting limit is reported once (%s, %d terms)",
    (_, operator, count) => {
      const { text, messages } = expand(
        `export const s = ${chain(count, () => operator)};`,
      );
      expect(messages).toEqual([limitReached(operator)]);
      // It stands as what it built before it reached the limit.
      expect(text.split("(").length - 1).toBe(1_024);
    },
  );
});

describe("nesting that does not end", () => {
  test("in a macro's own replacement is reported at the limit", () => {
    const { messages } = expand(`export const s = grow(v0);`);
    expect(messages).toEqual([limitReached("grow")]);
  });

  test("in an operator's replacement is reported at the limit", () => {
    const { messages } = expand(`export const s = v0 <@> v1;`);
    expect(messages).toEqual([limitReached("<@>")]);
  });

  test("written as deep as the limit allows expands", () => {
    const { text, messages } = expand(
      `export const s = ${"(".repeat(1_024)}v0${" + v1)".repeat(1_024)};`,
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      `export const s = ${"(".repeat(1_024)}v0${" + v1)".repeat(1_024)};`,
    );
  });
});
