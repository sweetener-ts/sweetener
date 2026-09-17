import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runConfiguredProjectCommand } from "../src/index.js";

/**
 * A statement macro written as the body of a control statement that has no
 * braces around it.
 *
 * `while (c) log(x);` puts the invocation where exactly one statement is read,
 * and the enclosing statement is what reads it. Left where it was written, it
 * is read a second time as the statement after the loop, so the expansion is
 * emitted twice: the loop runs its body once more, a macro expanding to a loop
 * leaves two loops with one label between them, and one expanding to nothing
 * leaves a stray `;` behind. Every assertion here counts the expansion as well
 * as reading it, because the duplicate is silent -- the emitted file is
 * ordinary TypeScript and the checker accepts it.
 */

const macros = `
export syntax logit:stmt {
  rule { logit($value:expr); } => { console.log($value); }
}
export syntax repeatit:stmt {
  rule { repeatit($value:expr); } => { for (let at = 0; at < 2; at += 1) console.log($value); }
}
export syntax dropit:stmt {
  rule { dropit($value:expr); } => { }
}
`;

interface Expansion {
  /** Whitespace collapsed, so an assertion need not track exact spacing. */
  readonly text: string;
  readonly messages: readonly string[];
}

function expand(source: string): Expansion {
  const directory = mkdtempSync(join(tmpdir(), "sweet-substatement-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(
    join(directory, "main.sts"),
    `import { logit, repeatit, dropit } from "./macros.sts" for syntax;\n${source}\n`,
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

/** How many times `needle` stands in `text`. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("a statement macro as an unbraced substatement", () => {
  const hosts: readonly (readonly [string, string, string])[] = [
    [
      "while body",
      "export function f(): void { let n = 0; while (n < 3) logit(n += 1); }",
      "export function f(): void { let n = 0; while (n < 3) console.log(n += 1); }",
    ],
    [
      "classic for body",
      "export function f(): void { for (let i = 0; i < 3; i += 1) logit(i); }",
      "export function f(): void { for (let i = 0; i < 3; i += 1) console.log(i); }",
    ],
    [
      "for-of body",
      "export function f(): void { for (const x of [1, 2]) logit(x); }",
      "export function f(): void { for (const x of [1, 2]) console.log(x); }",
    ],
    [
      "for-in body",
      "export function f(): void { for (const k in { a: 1 }) logit(k); }",
      "export function f(): void { for (const k in { a: 1 }) console.log(k); }",
    ],
    [
      "if consequent",
      "export function f(): void { let n = 0; if (n < 3) logit(n); }",
      "export function f(): void { let n = 0; if (n < 3) console.log(n); }",
    ],
    [
      "if alternate",
      "export function f(): void { let n = 0; if (n < 3) n += 1; else logit(n); }",
      "export function f(): void { let n = 0; if (n < 3) n += 1; else console.log(n); }",
    ],
    [
      "do body",
      "export function f(): void { let n = 0; do logit(n += 1); while (n < 3); }",
      "export function f(): void { let n = 0; do console.log(n += 1); while (n < 3); }",
    ],
    [
      "labeled statement",
      "export function f(): void { const n = 0; here: logit(n); }",
      "export function f(): void { const n = 0; here: console.log(n); }",
    ],
    [
      "nested unbraced bodies",
      "export function f(): void { let n = 0; if (n < 3) while (n < 3) logit(n += 1); }",
      "export function f(): void { let n = 0; if (n < 3) while (n < 3) console.log(n += 1); }",
    ],
  ];

  for (const [name, source, expected] of hosts) {
    test(`is expanded once in a ${name}`, () => {
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      expect(text).toBe(expected);
      expect(count(text, "console.log")).toBe(1);
      expect(text).not.toContain("logit");
    });
  }

  test("keeps a braced body expanded once, as it always was", () => {
    const { text, messages } = expand(
      "export function f(): void { let n = 0; while (n < 3) { logit(n += 1); } }",
    );
    expect(messages).toEqual([]);
    expect(count(text, "console.log")).toBe(1);
    expect(text).toBe(
      "export function f(): void { let n = 0; while (n < 3) { console.log(n += 1); } }",
    );
  });

  test("leaves one loop when the macro expands to a loop", () => {
    const { text, messages } = expand(
      "export function f(): void { outer: while (true) repeatit(1); }",
    );
    expect(messages).toEqual([]);
    expect(count(text, "for (")).toBe(1);
    expect(text).toBe(
      "export function f(): void { outer: while (true) for (let at = 0; (at < 2); (at += 1)) console.log(1); }",
    );
  });

  test("leaves one empty body when the macro expands to nothing", () => {
    const { text, messages } = expand(
      "export function f(): void { while (false) dropit(1); }",
    );
    expect(messages).toEqual([]);
    expect(count(text, ";")).toBe(1);
    expect(text).toBe("export function f(): void { while (false) ; }");
  });
});
