import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * Where a custom operator is dispatched, and what counts as writing one.
 *
 * An operator whose spelling the scanner splits across tokens -- `<-` is `<`
 * then `-` -- was matched by joining the tokens' text however they were
 * spaced, so `a < - b`, a comparison against a negation, was read as the
 * operator: ordinary TypeScript silently given another meaning in any file
 * that merely had the operator in scope.
 *
 * In the other direction, a group standing in an expression holds expressions,
 * and only brackets were walked that way -- so `(a <- b)` and every call
 * argument spelled with a custom operator kept the reading the ordinary parse
 * gave them, silently and with no diagnostic.
 */

const macros = `
export operator (<-):expr {
  fixity infix;
  associativity left;
  precedence 40;

  rule { $left:expr <- $right:expr } => { assign($left, $right) }
}
`;

const preamble = `import { (<-) } from "./macros.sts" for syntax;
declare function assign(left: number, right: number): number;
declare function call(value: number): number;
declare const a: number;
declare const b: number;
`;

function expand(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "sweet-operator-dispatch-"));
  writeFileSync(join(directory, "macros.sts"), macros);
  writeFileSync(join(directory, "main.sts"), `${preamble}${source}\n`);
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
  if (generated === undefined) throw new Error("main.ts was not generated");
  return generated.replace(/\s+/g, " ");
}

describe("what counts as writing a multi-token operator", () => {
  test("tokens written together are the operator", () => {
    // The rule's template writes `assign($left, $right)`, and that spacing is
    // now the expansion's, so both spellings print alike; what is under test
    // is that each of them dispatched the operator at all.
    expect(expand("export const x = a <- b;")).toContain("assign( a, b)");
    expect(expand("export const x = a <-b;")).toContain("assign( a, b)");
  });

  test("tokens written apart are the comparison they read as", () => {
    // `assign` is declared in the preamble, so the operator having run shows
    // as a call of it rather than as the name appearing at all.
    expect(expand("export const x = a < - b;")).toContain(
      "export const x = a < - b;",
    );
    expect(expand("export const x = a < - b;")).not.toContain("assign(a");
    expect(expand("export const x = a <  - b;")).not.toContain("assign(a");
  });
});

describe("where an operator is dispatched", () => {
  test("at the top of an expression", () => {
    expect(expand("export const x = a <- b;")).toContain("assign");
  });

  test("inside a parenthesised expression", () => {
    expect(expand("export const x = (a <- b);")).toContain("(assign(a, b))");
  });

  test("inside a call's arguments", () => {
    expect(expand("export const x = call(a <- b);")).toContain(
      "call(assign(a, b))",
    );
  });

  test("inside an array literal", () => {
    expect(expand("export const x = [a <- b];")).toContain("[assign(a, b)]");
  });

  test("an ordinary call is left as written", () => {
    expect(expand("export const x = call(a);")).toContain("call(a)");
  });

  test("inside an arrow's body", () => {
    // An arrow was taken by measuring how far it reaches, which left its body
    // as the tokens it was written with rather than as the expression it is.
    // `[1, 2].map((n) => n |> double)` is the obvious thing to write, and the
    // operator was never offered it.
    expect(expand("export const x = [a].map((n) => n <- b);")).toContain(
      "(n) =>assign( n, b)",
    );
  });

  test("inside a typed arrow's body", () => {
    expect(
      expand("export const x = [a].map((n: number): number => n <- b);"),
    ).toContain("=>assign( n, b)");
  });

  test("through a chain of them in one body", () => {
    expect(expand("export const x = [a].map((n) => n <- b <- a);")).toContain(
      "assign(assign( n, b), a)",
    );
  });

  test("inside an arrow nested in another arrow's body", () => {
    expect(
      expand("export const x = [a].map((n) => [n].map((m) => m <- b));"),
    ).toContain("(m) =>assign( m, b)");
  });

  test("an arrow whose body holds no operator is printed as written", () => {
    // The body is parsed now, so it reaches the printer as one node. Wrapping
    // that in parentheses would spell the same function worse.
    const generated = expand("export const f = (value: number) => value + 1;");
    expect(generated).toContain("(value: number) => value + 1");
  });

  test("an arrow's parameter list is left as written", () => {
    const generated = expand(
      "export const f = (left: number, right: number) => assign(left, right);",
    );
    expect(generated).toContain("(left: number, right: number) =>");
  });
});
