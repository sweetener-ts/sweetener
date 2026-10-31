import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  createDefaultProjectExpansionProvider,
  loadSweetProject,
} from "../src/index.js";

/**
 * An operator macro is dispatched where an expression is read, and an
 * expression is written in places nothing else reads one: a parameter's
 * default, a destructuring pattern's, a computed key, a decorator's
 * arguments, what a module exports by default. Each of those is read as an
 * expression, so the operator in it is dispatched; walked as the syntax
 * around it, the operator was left standing and reported as unexpanded.
 *
 * An operator is spelled with the tokens TypeScript has, and where those
 * tokens begin one of TypeScript's own operators -- `!` of a non-null
 * assertion, `++`, a `<` of type arguments -- the macro written there wins.
 */

const macros = `
export operator (<+>):expr {
  fixity infix; associativity left; precedence 130;
  rule { $a:expr <+> $b:expr } => { add($a, $b) }
}
export operator (+++):expr {
  fixity infix; associativity left; precedence 130;
  rule { $a:expr +++ $b:expr } => { add($a, $b) }
}
export operator (!!):expr {
  fixity postfix; precedence 160;
  rule { $a:expr !! } => { force($a) }
}
export operator (%%):expr {
  fixity postfix; precedence 200;
  rule { $a:expr %% } => { force($a) }
}
export operator (<-):stmt {
  fixity infix; associativity none; precedence 10;
  rule { $name:binding <- $source:expr; } => { const $name = $source; }
  bind $name in following;
}
export syntax exported:item {
  rule { exported!; } => {
    export default a <+> b
    export const z = a +++ b;
    one <- 1;
  }
}
`;

const declared =
  "declare function add(a: number, b: number): number;\n" +
  "declare function force(a: number): number;\n" +
  "declare function pair<A, B>(a: A, b: B): number;\n" +
  "declare function id<T>(v: T): T;\n" +
  "declare function dec(n: number): any;\n" +
  "declare const a: number, b: number;\n" +
  "declare const o: { k?: number; j?: number; arr: number[] };\n";

function expand(main: string, macroModule = macros) {
  const directory = mkdtempSync(join(tmpdir(), "sweet-operator-positions-"));
  writeFileSync(join(directory, "macros.sts"), macroModule);
  writeFileSync(
    join(directory, "main.sts"),
    `import { (<+>), (+++), (!!), (%%), (<-), exported } from "./macros.sts" for syntax;\n${declared}${main}\n`,
  );
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        experimentalDecorators: true,
      },
      sweet: { macroExtensions: [".sts"] },
      files: ["macros.sts", "main.sts"],
    }),
  );
  const output = createDefaultProjectExpansionProvider().expandProject(
    loadSweetProject(configPath),
  );
  const text =
    output.files
      .find(({ fileName }) => fileName.endsWith("main.ts"))
      ?.generated.text.replace(declared, "")
      .trim() ?? "";
  const messages = output.diagnostics.map(({ messageText }) =>
    ts.flattenDiagnosticMessageText(messageText, "\n"),
  );
  return { text, messages };
}

describe("an operator written where an expression is", () => {
  test.each([
    [
      "a function's parameter default",
      "export function g(v = a <+> b) { return v; }",
      "export function g(v = add(a, b)) { return v; }",
    ],
    [
      "an annotated parameter's default",
      "export function g(v: number = a <+> b) { return v; }",
      "export function g(v: number = add(a, b)) { return v; }",
    ],
    [
      "a method's parameter default",
      "export class K { m(v = a <+> b) { return v; } }",
      "export class K { m(v = add(a, b)) { return v; } }",
    ],
    [
      "a parameter property's default",
      "export class K { constructor(public v = a <+> b) {} }",
      "export class K { constructor(public v = add(a, b)) {} }",
    ],
    [
      "a default after one holding type arguments",
      "export function g(v = pair<number, number>(a, b), w = a <+> b) { return v + w; }",
      "export function g(v = pair<number, number>(a, b), w = add(a, b)) { return v + w; }",
    ],
    [
      "a default after an annotation holding type arguments",
      "export function g(m: Map<string, number>, v = a <+> b) { return v; }",
      "export function g(m: Map<string, number>, v = add(a, b)) { return v; }",
    ],
    [
      "an object pattern's default",
      "export const { k = a <+> b } = o;",
      "export const { k = add(a, b) } = o;",
    ],
    [
      "an array pattern's default",
      "export const [z = a <+> b] = o.arr;",
      "export const [z = add(a, b)] = o.arr;",
    ],
    [
      "a pattern's default holding type arguments",
      "export const { k = pair<number, number>(a, b) <+> b, j } = o;",
      "export const { k = add(pair<number, number>(a, b), b), j } = o;",
    ],
    [
      "a parameter pattern's default",
      "export function g({ k = a <+> b }: { k?: number }) { return k; }",
      "export function g({ k = add(a, b) }: { k?: number }) { return k; }",
    ],
    [
      "a computed key",
      "export const r = { [a <+> b]: 1 };",
      "export const r = { [add(a, b)]: 1 };",
    ],
    [
      "a decorator's arguments",
      "export class K { @dec(a <+> b) m() {} }",
      "export class K { @dec(add(a, b)) m() {} }",
    ],
    [
      "what a module exports by default",
      "export default a <+> b;",
      "export default add(a, b);",
    ],
  ])("is dispatched in %s", (_label, source, expected) => {
    const { text, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(text).toBe(expected);
  });

  test("ends what a module exports by default where its statement ends", () => {
    // A replacement holding a statement operator is walked as tokens: read
    // on to the next `;`, the default took in the item under it, and the
    // operator in it was left standing with nothing said.
    const { text, messages } = expand("exported!;");
    expect(text).toContain("export default add(a, b)\n");
    expect(text).toContain("export const z = add(a, b);");
    expect(messages.filter((message) => !message.includes("<-"))).toEqual([]);
  });

  test("leaves a function exported by default a declaration", () => {
    const { text, messages } = expand(
      "export default function g(v = a <+> b) { return v; }",
    );
    expect(messages).toEqual([]);
    expect(text).toBe("export default function g(v = add(a, b)) { return v; }");
  });
});

describe("an operator spelled with the tokens of TypeScript's own", () => {
  test.each([
    ["two non-null assertions", "export const r = a!!;", "force(a)"],
    ["an increment and a plus", "export const r = a +++ b;", "add(a, b)"],
    [
      "type arguments, after an instantiation",
      "export const r = id<number> <+> b;",
      "add(id<number>, b)",
    ],
    [
      "type arguments, after an asserted type",
      "export const r = a as number <+> b;",
      "add(a as number, b)",
    ],
  ])("is the operator over %s", (_label, source, expected) => {
    const { text, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(text).toContain(expected);
  });
});

describe("an operator on statements spelled inside an expression", () => {
  test.each([
    ["an initializer", "export const r = a<-b;"],
    ["a condition", "export function g() { if (a<-1) return 1; return 0; }"],
  ])("is the tokens it is spelled with, in %s", (_label, source) => {
    const { text, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(text).toBe(source);
  });
});

describe("an operator on statements in a block walked as tokens", () => {
  // A block holding a statement operator is walked as tokens, and the
  // operator was offered at every position of every statement: the one
  // after the `=` of a comparison took `a<-b;` as its statement.
  test("is offered only a statement an operand begins", () => {
    const { text, messages } = expand(
      "export function g() { const r = a<-b; one <- 1; return r || one; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("const r = a<-b;");
    expect(text).toContain("const one = 1;");
  });

  test.each([
    [
      "an assignment",
      "export function g() { let x = false; x = a<-b; return x; }",
    ],
    [
      "a case's label",
      "export function g(v: number) { switch (v) { case a<-1: break; } }",
    ],
    ["a statement no binding begins", "export function g() { 5 <- a; }"],
  ])(
    "leaves %s it is spelled in as written, where its rule stops before it",
    (_label, source) => {
      // The rule reads its statement from the left operand to the operator,
      // and these never reach it: TypeScript reads a comparison.
      const { text, messages } = expand(source);
      expect(messages).toEqual([]);
      expect(text).toBe(source);
    },
  );

  test("reports the refusal of a statement read to the operator", () => {
    const { messages } = expand("export function g() { x <- ; }");
    expect(messages).toEqual([
      "No rule for macro <- accepted this input: 1 rule attempt(s).",
    ]);
  });

  test.each([
    [
      "an `if`",
      "export function g(c: boolean) { if (c) x <- 1; }",
      "if (c) const x = 1;",
    ],
    [
      "an `else`",
      "export function g(c: boolean) { if (c) {} else x <- 1; }",
      "else const x = 1;",
    ],
  ])("is offered the body %s heads", (_label, source, expected) => {
    // A body is a statement of its own, headed where the statement around
    // it ends its header; TypeScript reports the declaration written there.
    const { text, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(text).toContain(expected);
  });

  test.each([
    ["a name", "  // one\n  one <- 1;", "  // one\n  const one = 1;"],
    [
      "a pattern",
      "  // pair\n  [p, q] <- [1, 2];",
      "  // pair\n  const [p, q] = [1, 2];",
    ],
  ])(
    "keeps the comment above a statement whose left operand is %s once, above it",
    (_label, statement, expected) => {
      // The statement's leading trivia is handed to what it expands to, and
      // the captured operand kept the comment too, or kept it alone, after
      // the `const`.
      const { text, messages } = expand(
        `export function g() {\n  f();\n${statement}\n}`,
      );
      expect(messages).toEqual([]);
      expect(text).toContain(`f();\n${expected}`);
    },
  );

  test("keeps its statement on the line it was written on", () => {
    // Spaced as the operator was, the statement automatic semicolon
    // insertion ended above it ran into it: `const k = 1 const one = 1;`.
    const { text, messages } = expand(
      "export function g() { const k = 1\n  one <- 1; return one + k; }",
    );
    expect(messages).toEqual([]);
    expect(text).toContain("const k = 1\n  const one = 1;");
  });
});

describe("an operator on statements at a module's top", () => {
  // Each statement at a module's top was read before the walk, so `one <-
  // 1;` was the comparison `one < -1` and the operator was never offered it.
  test("is offered its statement, which binds the items after it", () => {
    const { text, messages } = expand("one <- 1;\nexport const two = one + 1;");
    expect(messages).toEqual([]);
    expect(text).toBe("const one = 1;\nexport const two = one + 1;");
  });

  test("is offered a statement on the line under a declaration with no `;`", () => {
    const { text, messages } = expand("export const k = 1\none <- k;");
    expect(messages).toEqual([]);
    expect(text).toBe("export const k = 1\nconst one = k;");
  });

  test("is not offered a declaration it is spelled in", () => {
    const { text, messages } = expand("export const r = a<-b;");
    expect(messages).toEqual([]);
    expect(text).toBe("export const r = a<-b;");
  });

  test("leaves an assignment it is spelled in as written", () => {
    const { text, messages } = expand("let x = false;\nx = a<-b;");
    expect(messages).toEqual([]);
    expect(text).toBe("let x = false;\nx = a<-b;");
  });
});

/**
 * A postfix operator declared to bind as a left-hand-side expression does,
 * or more tightly, makes one, and what is read off a name may be read off
 * it. One that binds as `++` does makes none, as `a++.x` is none, and the
 * reader says what to write instead.
 */
describe("what is read off a postfix operator", () => {
  test.each([
    ["a member", "export const r = a%%.toFixed();", "force(a).toFixed()"],
    ["a call", "export const r = [a%%.toFixed(2)];", "[force(a).toFixed(2)]"],
  ])("is %s, after one that binds tightly", (_label, source, expected) => {
    const { text, messages } = expand(source);
    expect(messages).toEqual([]);
    expect(text).toContain(expected);
  });

  test("is read off the parentheses around one that binds loosely", () => {
    const { text, messages } = expand("export const r = (a!!).toFixed();");
    expect(messages).toEqual([]);
    expect(text).toContain("(force(a)).toFixed()");
  });

  test("is reported after one that binds loosely", () => {
    const { messages } = expand("export const r = a!!.toFixed();");
    expect(messages.join("\n")).toContain(
      "parentheses around postfix '!!' and its operand, or a precedence for it of at least 200",
    );
  });
});

test("an operator declared as tight as a name is refused where it is defined", () => {
  // No operand binds more tightly than a name or a call, and the rule's
  // operand must bind more tightly than the operator.
  const { messages } = expand(
    "export const r = a!!;",
    macros.replace(
      "fixity postfix; precedence 160;",
      "fixity postfix; precedence 1000;",
    ),
  );
  expect(messages).toContain(
    "Invalid operator !!: precedence must be below 1000, where a name or a call binds.",
  );
});
