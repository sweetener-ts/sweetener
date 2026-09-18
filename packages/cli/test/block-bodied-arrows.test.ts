import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * An arrow whose parameter list begins with nothing an expression can begin
 * with, and whose body is a block: `() => {}`, `(): void => {}`, `<T,>() => {}`.
 *
 * The infix `=>` reads such an arrow by protecting what stands to its left,
 * but an empty parenthesis group and a `<` are not operands, so nothing could
 * begin the expression and the statement holding the arrow did not parse. A
 * statement list with one in it then fell back to a raw token walk, where an
 * expression macro written beside the arrow resolves in no category at all and
 * is emitted verbatim -- silently, with only TypeScript's later "cannot find
 * name" to show for it.
 */

const macros = `
export syntax twice:expr {
  rule { twice($value:expr) } => { ($value + $value) }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-arrow-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { twice } from "./macros.sts" for syntax;\n${source}\n`,
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

describe("a statement list holding a block-bodied arrow", () => {
  const shapes: readonly (readonly [string, string])[] = [
    ["const with empty parameters", "const handler = () => {};"],
    ["let with empty parameters", "let handler = () => {};"],
    ["var with empty parameters", "var handler = () => {};"],
    ["assignment", "let handler: unknown; handler = () => {};"],
    ["return", "return () => {};"],
    ["with a return type", "const handler = (): void => {};"],
    ["with type parameters", "const handler = <T,>(): void => {};"],
    [
      "with type parameters and a parameter",
      "const handler = <T,>(first: T) => { return first; };",
    ],
    ["with statements in the body", "const handler = () => { return 1; };"],
    ["async with empty parameters", "const handler = async () => {};"],
    [
      "with one parameter",
      "const handler = (first: number) => { return first; };",
    ],
    ["with a concise body", "const handler = () => 1;"],
    // A return type stands between the parameters and the `=>`, so the `=>`
    // is not beside the operand the infix reading would protect.
    [
      "with a return type and a parameter",
      "const handler = (first: number): number => { return first; };",
    ],
    [
      "async with a return type",
      "const handler = async (): Promise<void> => {};",
    ],
    // `async v => …` puts two operands in front of the `=>`, of which only the
    // name would be taken, so that reading dropped the `async`.
    [
      "async with an unparenthesized parameter",
      "const handler: (v: number) => Promise<number> = async v => { return v; };",
    ],
    [
      "async with an unparenthesized parameter and a concise body",
      "const handler: (v: number) => Promise<number> = async v => v;",
    ],
    ["inside a call", "[1].forEach(() => {});"],
    ["immediately invoked", "(() => {})();"],
  ];

  for (const [name, statement] of shapes) {
    test(`expands a macro beside an arrow ${name}`, () => {
      const { text, messages } = expand(
        `export function z(): unknown { twice(1); ${statement} return 0; }`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain("(1 + 1);");
      expect(text).not.toContain("twice(");
    });
  }

  test("expands a macro written inside a block-bodied arrow", () => {
    const { text, messages } = expand(
      `export const handler = (): number => { return twice(3); };`,
    );
    expect(messages).toEqual([]);
    expect(text).toBe(
      "export const handler = (): number => { return (3 + 3); };",
    );
  });
});
