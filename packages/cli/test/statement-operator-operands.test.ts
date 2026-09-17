import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Where the left operand of a statement-level infix operator begins.
 *
 * A run holding one is walked as tokens, and the operator is dispatched from
 * the head of its statement rather than from the operator itself, which the
 * walk finds by reading forward to it. Reading forward stops at the `;` that
 * separates two statements, but the walk also *starts* at that `;` once the
 * statement before it has been emitted -- and from there it read the operator
 * across the separator, offering it an operand that began with the `;` of the
 * statement before. No rule can match that, so a statement that expanded
 * correctly still reported a refusal naming a rule the author never wrote.
 */

const macros = `
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

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-operand-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { (<-) } from "./macros.sts" for syntax;\n${source}\n`,
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
    messages: result.diagnostics.map(({ messageText }) => String(messageText)),
  };
}

describe("the left operand of a statement operator", () => {
  const preceding: readonly (readonly [string, string])[] = [
    ["a concise-bodied arrow", "const handler = () => 1;"],
    ["a block-bodied arrow", "const handler = () => {};"],
    ["an ordinary declaration", "const handler = 1;"],
    ["an expression statement", "void 0;"],
  ];

  for (const [name, statement] of preceding) {
    test(`does not reach back across the semicolon of ${name}`, () => {
      const { text, messages } = expand(
        `export function z(): number { ${statement} total <- 5; return total; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toBe(
        `export function z(): number { ${statement} const total = 5; return total; }`,
      );
    });
  }

  test("still dispatches the operator when it opens the block", () => {
    const { text, messages } = expand(
      "export function z(): number { total <- 5; return total; }",
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export function z(): number { const total = 5; return total; }",
    );
  });
});
