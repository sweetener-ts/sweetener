import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A syntax-class field may be named by a contextual keyword.
 *
 * TypeScript's scanner labels words such as `unique`, `type` and `from` as
 * keywords, though they are ordinary identifiers wherever a name is expected.
 * The `fields` block accepted only tokens scanned as identifiers, so a field
 * named `unique` was reported as a malformed declaration and every later use
 * of it as a field that did not exist.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-keyword-field-"));
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

const macros = `
export syntax class Flag {
  fields { unique: ident?; type: ident?; }
  rule { $unique:ident }
  refine $unique spelling equals "unique";
  rule { $type:ident }
}

export syntax flags:expr {
  rule { flags($($flag:Flag),*) } => {
    [$(#if(present $flag.unique) { "unique" } #else { #text($flag.type) }),*]
  }
}
`;

describe("syntax-class fields named by contextual keywords", () => {
  test("declare, capture and read back through a template", () => {
    const { generated, messages } = run(
      macros,
      `import { flags } from "./macros.sts" for syntax;\nexport const kinds = flags(unique, primary);\n`,
    );
    expect(messages).toEqual([]);
    expect(generated.replace(/\s+/gu, "")).toContain(
      `kinds=["unique","primary"]`,
    );
  });

  test("a reserved word still does not name a field", () => {
    const { messages } = run(
      `export syntax class Bad {\n  fields { default: ident; }\n  rule { $default:ident }\n}\n`,
      `export const unused = 1;\n`,
    );
    expect(
      messages.some((message) => message.includes("field declaration")),
    ).toBe(true);
  });
});
