import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * How a pattern is spaced should not change what it means, except where the
 * spacing is the whole of the notation.
 *
 * A `|` between alternatives is written with a space on either side of it,
 * which is what tells it from a `|` the pattern matches literally -- `$name |=
 * $value` matches an assignment operator. Both spaces count: asking only about
 * the one after it reads the rule backwards for one of the two one-sided
 * spellings, making `$x:tt| $y:tt` a choice and `$x:tt |$y:tt` a literal,
 * neither of which anyone writes on purpose.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-pattern-spelling-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), source);
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { noEmit: true, strict: false, target: "ES2022" },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const expanded = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(join(directory, "tsconfig.json")),
  );
  return {
    generated:
      expanded.files.find(({ fileName }) => fileName.endsWith("main.ts"))
        ?.generated.text ?? "",
    messages: expanded.diagnostics.map(
      ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
    ),
  };
}

describe("the choice bar", () => {
  // Alternatives bind the same captures, so a choice between two literal
  // spellings is the shape that isolates the notation itself.
  const choosing = (pattern: string, call: string) =>
    run(
      `export syntax pick:expr { rule { pick(${pattern}) } => { "chose" } }`,
      `import { pick } from "./macros.sts" for syntax;\nexport const a = ${call};\n`,
    );

  test("is a choice when written with space on either side", () => {
    const { generated, messages } = choosing("one | two", "pick(two)");
    expect(messages).toEqual([]);
    expect(generated).toContain('"chose"');
  });

  test("is literal when written with no space after it", () => {
    // A literal `|` matches a `|` in the input, which `pick(two)` has not.
    expect(choosing("one |two", "pick(two)").messages.join("\n")).toContain(
      "No rule for macro pick",
    );
  });

  test("is literal when written with no space before it", () => {
    expect(choosing("one| two", "pick(two)").messages.join("\n")).toContain(
      "No rule for macro pick",
    );
  });

  test("a literal one matches the `|` it spells", () => {
    const { generated, messages } = choosing("$a:tt |$b:tt", "pick(1 |2)");
    expect(messages).toEqual([]);
    expect(generated).toContain('"chose"');
  });
});

describe("an optional capture", () => {
  const optional = (pattern: string) =>
    run(
      `export syntax g:expr { rule { g(${pattern}) } => { #if(present $value) { "given" } #else { "absent" } } }`,
      'import { g } from "./macros.sts" for syntax;\n' +
        "export const a = g(9);\nexport const b = g();\n",
    );

  test("takes its quantifier on the group, as repetition does", () => {
    const { generated, messages } = optional("$($value:tt)?");
    expect(messages).toEqual([]);
    expect(generated).toContain('"given"');
    expect(generated).toContain('"absent"');
  });
});
