import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * Where a function declaration ends, as a macro sees it.
 *
 * A statement macro that captures `$s:stmt` emits exactly the extent the
 * reader gave that statement, so the extent shows in the output: a signature
 * that took the call under it into itself wraps the call too, and one cut
 * short in the middle of its return type wraps half a declaration and leaves
 * the rest outside. A declaration whose extent is wrong also loses its body,
 * and a statement macro written in that body is never expanded.
 */

const macros = `
export syntax block:stmt {
  rule { block $s:stmt } => { { $s } }
}

export syntax unless:stmt {
  rule { unless($condition:expr) $body:stmt }
  => { if (!($condition)) $body }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-signature-extent-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { block, unless } from "./macros.sts" for syntax;\n` +
      `declare function run(): void;\n${source}\n`,
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

describe("the extent of a function declaration under a macro", () => {
  test("wraps a signature without the call written under it", () => {
    const { text } = expand(
      "export function outer() {\n" +
        "  block function f(): string\n" +
        "  run();\n" +
        "}\n",
    );
    expect(text).toContain("{ function f(): string } run();");
  });

  test.each([
    ["a negative literal", "-1", "return -1;"],
    ["a generic function type", "<T>(x: T) => T", "return (x) => x;"],
    ["a generic constructor type", "new <T>() => T", "return null as any;"],
    [
      "a generic function type as a type argument",
      "Promise<<T>() => T>",
      "return null as any;",
    ],
  ])(
    "wraps a whole function whose return type is %s",
    (_label, type, statement) => {
      const { text, messages } = expand(
        "export function outer() {\n" +
          `  block function f(): ${type} { ${statement} }\n` +
          "}\n",
      );
      expect(messages).toEqual([]);
      expect(text).toContain(`{ function f(): ${type} {`);
    },
  );

  test.each([
    ["a negative literal", "-1", "-1"],
    ["a generic function type", "<T>(x: T) => T", "(x) => x"],
    ["a generic constructor type", "new <T>() => T", "null as any"],
  ])(
    "expands a statement macro in a function whose return type is %s",
    (_label, type, value) => {
      const { text, messages } = expand(
        `export function f(): ${type} {\n` +
          "  unless(false) { run(); }\n" +
          `  return ${value};\n` +
          "}\n",
      );
      expect(messages).toEqual([]);
      expect(text).toContain("if (!(false)) { run(); }");
    },
  );
});

/**
 * Where a variable declaration ends, as a macro sees it.
 *
 * A declarator's annotation is read by the same type tracker as a signature's
 * return type. Read by a model of its own, it cut a generic function type at
 * the `>` of its type parameters, so a statement macro wrapped half a
 * declaration; and the item reader refused an annotation it could not read --
 * a negative literal, a type spelled like a keyword -- and the module's items
 * were walked as raw tokens, where a statement macro written under the
 * declaration was never expanded.
 */
describe("the extent of a variable declaration under a macro", () => {
  test.each([
    ["a generic function type", "<T>\n(v: T) => T", "(v) => v"],
    ["a generic constructor type", "new <T>\n() => T", "null as any"],
  ])(
    "wraps a whole declaration whose annotation is %s broken after its type parameters",
    (_label, type, value) => {
      const { text, messages } = expand(
        "export function outer() {\n" +
          `  block const x: ${type} = ${value};\n` +
          "}\n",
      );
      expect(messages).toEqual([]);
      expect(text).toContain(`{ const x: ${type.replace("\n", " ")} = `);
    },
  );

  test.each([
    ["a negative literal", "-1", "-1"],
    ["a negative bigint", "-1n", "-1n"],
  ])(
    "expands a statement macro under a module declaration annotated with %s",
    (_label, type, value) => {
      const { text, messages } = expand(
        `export const x: ${type} = ${value};\n` + "unless(false) { run(); }\n",
      );
      expect(messages).toEqual([]);
      expect(text).toContain("if (!(false)) { run(); }");
    },
  );
});
