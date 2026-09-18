import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A macro's expansion has to read as one node of the category the macro
 * declares.
 *
 * When it does not, that is a diagnostic, not a thrown error. Thrown, it is
 * caught by the project command as an internal fault that abandons the
 * expansion of every file, produces no output at all, and reports a message
 * naming neither the macro nor where it was written.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-uncategorized-"));
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
    files: expanded.files.map(({ fileName }) => fileName),
    messages: expanded.diagnostics.map(
      ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
    ),
  };
}

describe("an expansion that is not one node of its category", () => {
  test("names the macro and is reported at the invocation", () => {
    const { files, messages } = run(
      "export syntax two:expr { rule { two() } => { const a = 1; const b = 2; } }",
      'import { two } from "./macros.sts" for syntax;\nexport const x = two();\n',
    );
    expect(messages.join("\n")).toContain(
      "Macro two expanded to syntax that is not one expr",
    );
    // The rest of the project still expands.
    expect(files.length).toBeGreaterThan(0);
  });

  test("JSX in a file whose extension cannot hold it is reported", () => {
    const { files, messages } = run(
      "export syntax box:expr { rule { box($x:expr) } => { <div>{$x}</div> } }",
      'import { box } from "./macros.sts" for syntax;\nexport const a = box(1);\n',
    );
    // In a file JSX cannot stand in, `<div>` is a prefix type assertion and
    // `{$x}` the operand it applies to -- TypeScript's own reading of the same
    // text -- and it is the `</div>` left over that nothing can read.
    // TypeScript reports it as an unterminated regular expression, and so does
    // this. What matters here is that it is reported at all, rather than
    // thrown as an internal fault that abandons the whole project.
    expect(messages.join("\n")).toContain("Unterminated regular expression");
    expect(messages.join("\n")).not.toContain("Project expansion failed");
    expect(files.length).toBeGreaterThan(0);
  });

  test("a well-formed expansion is untouched", () => {
    const { messages } = run(
      "export syntax twice:expr { rule { twice($x:tt) } => { [$x, $x] } }",
      'import { twice } from "./macros.sts" for syntax;\nexport const a = twice(1);\n',
    );
    expect(messages).toEqual([]);
  });
});
