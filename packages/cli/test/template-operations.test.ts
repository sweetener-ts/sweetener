import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * `#` is TypeScript's private-identifier syntax as well as the template
 * language's operation syntax, and the two collide on the names the operations
 * use.
 *
 * A class written in a template that declares `#count(value: number)` or calls
 * `this.#count(1)` was read as the `#count` operation, which reported that its
 * argument was invalid and left the whole class unexpanded. In the other
 * direction, a `#name(` naming no operation at all was printed into the
 * expansion as written, so a misspelling was reported as "private identifiers
 * are not allowed outside class bodies" against generated code the author never
 * wrote.
 */

function run(macros: string, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-template-ops-"));
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

describe("template operations and private identifiers", () => {
  test("a private method spelled like an operation is left alone", () => {
    const { generated, messages } = run(
      `
export syntax counter:item {
  rule { counter() } => {
    class Counter {
      #count(value: number) { return value + 1; }
      run() { return this.#count(1); }
    }
  }
}
`,
      'import { counter } from "./macros.sts" for syntax;\ncounter()\n',
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("#count(value: number)");
    expect(generated).toContain("this.#count(1)");
  });

  test("an unknown operation is reported where it is written", () => {
    const { messages } = run(
      "export syntax m:expr { rule { m($x:tt) } => { #bogus($x) } }",
      'import { m } from "./macros.sts" for syntax;\nexport const a = m(1);\n',
    );
    expect(messages.join("\n")).toContain("Template has no operation #bogus");
    // Not the confusing TypeScript error the literal output used to produce.
    expect(messages.join("\n")).not.toContain("Private identifiers");
  });

  test("the operations themselves still run", () => {
    const { generated, messages } = run(
      "export syntax n:expr { rule { n($($x:tt),*) } => { [$(#text($x)),*, #count($x)] } }",
      'import { n } from "./macros.sts" for syntax;\nexport const a = n(one, two, three);\n',
    );
    expect(messages).toEqual([]);
    expect(generated).toContain('"one"');
    expect(generated).toContain("3");
  });

  test("a #join affix that cannot form an identifier is reported", () => {
    // Left to expansion the join threw, and a thrown error is not a
    // diagnostic: it abandoned the whole project expansion and reported no
    // expanded file at all.
    const { messages } = run(
      `
export syntax named:item {
  rule { named($name:ident) } => { export const #join($name, prefix: "1-x ") = 1; }
}
`,
      'import { named } from "./macros.sts" for syntax;\nnamed(thing)\n',
    );
    expect(messages.join("\n")).toContain(
      "Invalid argument for template operation #join",
    );
    expect(messages.join("\n")).not.toContain("Project expansion failed");
  });

  test("#join affixes that do form an identifier still join", () => {
    const { generated, messages } = run(
      `
export syntax named:item {
  rule { named($name:ident) } => {
    export const #join($name, prefix: "get", suffix: "Value", casing: "upper-first") = 1;
  }
}
`,
      'import { named } from "./macros.sts" for syntax;\nnamed(thing)\n',
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("getThingValue");
  });

  test("a #fresh hint that is not an identifier is reported", () => {
    // The hint becomes the introduced name. Only its emptiness was checked, so
    // a hint of two words printed a name that was two, reported by TypeScript
    // as a syntax error in generated code.
    const { messages } = run(
      'export syntax f:item { rule { f() } => { const #fresh("has space") = 1; } }',
      'import { f } from "./macros.sts" for syntax;\nf()\n',
    );
    expect(messages.join("\n")).toContain(
      "Invalid argument for template operation #fresh",
    );
  });

  test("#count drives the repetitions outside the one it collapses", () => {
    // A count collapses only its innermost dimension. Given no shape at all,
    // it drove nothing, and a repetition whose content was a count was refused
    // as having no driving capture.
    const { generated, messages } = run(
      "export syntax sizes:expr { rule { sizes($([$($x:tt),*]),*) } => { [$(#count($x)),*] } }",
      'import { sizes } from "./macros.sts" for syntax;\n' +
        "export const a = sizes([1,2,3], [4,5]);\n",
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("[3, 2]");
  });

  test("#count still cannot drive the repetition it collapses", () => {
    const { messages } = run(
      "export syntax p:expr { rule { p($($x:tt),*) } => { [$(#count($x)),*] } }",
      'import { p } from "./macros.sts" for syntax;\nexport const a = p(1,2,3);\n',
    );
    expect(messages.join("\n")).toContain("has no driving capture");
  });

  test("#core still reaches the expander", () => {
    const { generated, messages } = run(
      `
export syntax hold:item {
  rule { hold($name:ident) } => { #core(const $name = 1) }
}
`,
      'import { hold } from "./macros.sts" for syntax;\nhold(value)\nexport const seen = value;\n',
    );
    expect(messages).toEqual([]);
    expect(generated).toContain("const value = 1");
  });
});
