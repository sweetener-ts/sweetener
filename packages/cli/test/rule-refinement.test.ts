import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * A macro rule's `refine` clauses narrow what it accepts beyond what its
 * pattern can say.
 *
 * Macro rules take the same clauses a syntax-class rule does, and have to
 * apply them: dropped, two rules told apart only by a refinement both match
 * and the first one written answers for both. A `match` macro whose binder arm
 * is refined to lowercase spellings would bind `Ready` as a binder rather than
 * compare against it, and every arm of the match would report itself taken.
 *
 * A clause also ends where the next clause begins, not only at a `;`. Otherwise
 * an unterminated one swallows the clause after it: `refine` followed by `bind`
 * parses as a single refinement whose predicate runs on past its own end, the
 * refinement is rejected and the binding contract dropped, with nothing said
 * about either.
 */

interface Case {
  readonly macros: string;
  readonly source: string;
}

function run({ macros, source }: Case) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-refinement-"));
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
  const generated = expanded.files.find(({ fileName }) =>
    fileName.endsWith("main.ts"),
  )?.generated.text;
  return {
    generated: generated ?? "",
    messages: expanded.diagnostics.map(
      ({ code, messageText }) => `TS${String(code)}: ${String(messageText)}`,
    ),
  };
}

const classify = `
export syntax classify:expr {
  rule { classify($name:ident) }
  refine $name spelling starts-with-lowercase
  => { "lowercase" }

  rule { classify($name:ident) } => { "uppercase" }
}
`;

describe("refining a macro rule", () => {
  test("chooses between rules a pattern cannot tell apart", () => {
    const { generated, messages } = run({
      macros: classify,
      source:
        'import { classify } from "./macros.sts" for syntax;\n' +
        "export const a = classify(ready);\n" +
        "export const b = classify(Ready);\n",
    });
    expect(messages).toEqual([]);
    expect(generated).toContain('export const a = "lowercase"');
    expect(generated).toContain('export const b = "uppercase"');
  });

  test("reports what the refinement wanted when no rule is left", () => {
    const { messages } = run({
      macros: `
export syntax only:expr {
  rule { only($name:ident) }
  refine $name spelling starts-with-lowercase
  => { "ok" }
}
`,
      source:
        'import { only } from "./macros.sts" for syntax;\n' +
        "export const a = only(Nope);\n",
    });
    expect(messages.join("\n")).toContain(
      "a name starting with a lowercase letter",
    );
  });

  test("names the spellings a set refinement accepts", () => {
    const { messages } = run({
      macros: `
export syntax pick:expr {
  rule { pick($t:tt) }
  refine $t spelling in (red, green)
  => { "known" }
}
`,
      source:
        'import { pick } from "./macros.sts" for syntax;\n' +
        "export const a = pick(blue);\n",
    });
    expect(messages.join("\n")).toContain("one of `green`, `red`");
  });

  test("an `expect` clause is preferred over the refinement's own words", () => {
    const { messages } = run({
      macros: `
export syntax only:expr {
  rule { only($name:ident) }
  refine $name spelling starts-with-lowercase
  expect "a lowercase binder";
  => { "ok" }
}
`,
      source:
        'import { only } from "./macros.sts" for syntax;\n' +
        "export const a = only(Nope);\n",
    });
    expect(messages.join("\n")).toContain("a lowercase binder");
  });

  test("a refinement naming no capture is an error, not a widening", () => {
    const { messages } = run({
      macros: `
export syntax only:expr {
  rule { only($name:ident) }
  refine $missing spelling starts-with-lowercase
  => { "ok" }
}
`,
      source:
        'import { only } from "./macros.sts" for syntax;\n' +
        "export const a = only(fine);\n",
    });
    expect(messages.join("\n")).toContain("$missing");
  });

  test("a capture that is not one token refuses a spelling refinement", () => {
    // `find`ing the first token out of a capture would answer for the whole of
    // it, and a capture with no token at that position would answer nothing at
    // all -- so the refinement would pass vacuously on everything it is
    // written to exclude.
    const { generated, messages } = run({
      macros: `
export syntax low:expr {
  rule { low($x:tt) }
  refine $x spelling starts-with-lowercase
  => { "accepted" }
  rule { low($x:tt) } => { "rejected" }
}
export syntax lowExpr:expr {
  rule { lowExpr($x:expr) }
  refine $x spelling starts-with-lowercase
  => { "accepted" }
  rule { lowExpr($x:expr) } => { "rejected" }
}
`,
      source:
        'import { low, lowExpr } from "./macros.sts" for syntax;\n' +
        "export const a = low(ready);\n" +
        "export const b = low(Ready);\n" +
        "export const parenthesized = low((Ready));\n" +
        "export const bracketed = low([Ready]);\n" +
        "export const member = lowExpr(foo.Bar);\n" +
        "export const arithmetic = lowExpr(1 + 2);\n" +
        "export const lone = lowExpr(ready);\n",
    });
    expect(messages).toEqual([]);
    expect(generated).toContain('export const a = "accepted"');
    expect(generated).toContain('export const b = "rejected"');
    expect(generated).toContain('export const parenthesized = "rejected"');
    expect(generated).toContain('export const bracketed = "rejected"');
    expect(generated).toContain('export const member = "rejected"');
    expect(generated).toContain('export const arithmetic = "rejected"');
    expect(generated).toContain('export const lone = "accepted"');
  });

  test("a `bind` clause after an unterminated `refine` still takes effect", () => {
    const { generated, messages } = run({
      macros: `
export syntax hold:stmt {
  rule { hold($value:expr, $name:binding); }
  refine $name spelling starts-with-lowercase
  bind $name in following as lexical value;
  => { const $name = $value; }
}
`,
      source:
        'import { hold } from "./macros.sts" for syntax;\n' +
        "export function f() { hold(1, kept); return kept; }\n",
    });
    // Without the binding contract the introduced `kept` is invisible to the
    // statement after it, and `return kept` is an unknown name.
    expect(messages).toEqual([]);
    expect(generated).toContain("const kept =");
  });

  test("the refinement in front of that `bind` clause still applies", () => {
    const { messages } = run({
      macros: `
export syntax hold:stmt {
  rule { hold($value:expr, $name:binding); }
  refine $name spelling starts-with-lowercase
  bind $name in following as lexical value;
  => { const $name = $value; }
}
`,
      source:
        'import { hold } from "./macros.sts" for syntax;\n' +
        "export function f() { hold(1, Kept); return 0; }\n",
    });
    expect(messages.join("\n")).toContain(
      "a name starting with a lowercase letter",
    );
  });
});
