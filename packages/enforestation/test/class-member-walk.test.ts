import { readSyntax } from "@sweetener/reader";
import type { ScopeSetId, SourceId } from "@sweetener/shared";
import type { Syntax } from "@sweetener/syntax";
import { printLossless } from "@sweetener/reader";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import { createClassMemberWalk } from "../src/index.js";

/** The nodes of the body of the one class `source` declares. */
function classBody(source: string): readonly Syntax[] {
  const read = readSyntax(source, {
    sourceId: 141 as SourceId,
    scopes: 0 as ScopeSetId,
  });
  expect(read.diagnostics).toEqual([]);
  const body = read.root.children.find(
    (node) => node.tag === "group" && node.delimiter === "brace",
  );
  if (body?.tag !== "group") throw new Error("expected a class body");
  return body.children.filter(
    (node) => node.tag !== "token" || node.kind !== "end-of-file",
  );
}

/** The members a walk splits a class body into, each printed and trimmed. */
function members(source: string): string[] {
  const walk = createClassMemberWalk();
  const split: Syntax[][] = [[]];
  for (const node of classBody(source)) {
    if (walk.endsBefore(node)) {
      walk.restart();
      split.push([]);
    }
    walk.take(node);
    split.at(-1)!.push(node);
  }
  return split.map((member) =>
    member
      .map((node) => printLossless(node))
      .join("")
      .trim(),
  );
}

/**
 * A walk over a class body says where each member ends one node at a time,
 * as the class element reader does, so a caller that walks a body never
 * reads a member again for each node in it.
 */
describe("walking a class body's members", () => {
  test("ends members where TypeScript ends them", () => {
    expect(
      members(
        "class K {\n  x = a as string;\n  [k] = 1;\n  static\n  y = 2\n  m(): void {}\n  n = 3\n}",
      ),
    ).toEqual([
      "x = a as string;",
      "[k] = 1;",
      "static\n  y = 2",
      "m(): void {}",
      "n = 3",
    ]);
  });

  test("ends a method whose type parameter has a default at its body", () => {
    expect(members("class K {\n  m<T = string>() {} n = 1\n}")).toEqual([
      "m<T = string>() {}",
      "n = 1",
    ]);
  });

  test("says whether a member's name is written next", () => {
    const walk = createClassMemberWalk();
    const [first, second] = classBody("class K { static async m() {} }");
    expect(walk.nameFollows()).toBe(true);
    walk.take(first!);
    expect(walk.nameFollows()).toBe(true);
    walk.take(second!);
    expect(walk.nameFollows()).toBe(true);
    walk.take(classBody("class K { static async m() {} }")[2]!);
    expect(walk.nameFollows()).toBe(false);
  });

  test("takes each node of a long initializer in constant time", () => {
    const terms = Array.from({ length: 40_000 }, (_, at) => `a${String(at)}`);
    const body = classBody(`class K {\n  x = ${terms.join(" +\n    ")}\n}`);
    const started = performance.now();
    const walk = createClassMemberWalk();
    let ended = 0;
    for (const node of body) {
      if (walk.endsBefore(node)) {
        walk.restart();
        ended += 1;
      }
      walk.take(node);
    }
    expect(ended).toBe(0);
    // Read again for each node, the member made this a matter of minutes.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

/** The members TypeScript reads the one class `source` declares as. */
function typescriptMembers(source: string): string[] {
  const file = ts.createSourceFile(
    "fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  ) as ts.SourceFile & { readonly parseDiagnostics: readonly ts.Diagnostic[] };
  expect(file.parseDiagnostics, source).toEqual([]);
  const declaration = file.statements[0];
  if (declaration === undefined || !ts.isClassDeclaration(declaration))
    throw new Error("expected a class");
  return declaration.members.map((member) => member.getText(file));
}

/**
 * A type asserted with `as` or `satisfies` ends a field's initializer where
 * TypeScript ends the type: a bracket on the next line is no array type, since
 * TypeScript writes `PrimaryType [no LineTerminator here] [ ]`, and an
 * assertion takes no member access after it, so the bracket begins the next
 * member. Where the expression carries on past the type on its line, a
 * bracket under it indexes what it ends with, as it does anywhere else.
 */
describe("a field asserted to a type", () => {
  test.each([
    "class K {\n  x = a as T\n  [k] = 1\n}",
    "class K {\n  x = a satisfies T\n  [k] = 1\n}",
    "class K {\n  x = a as const\n  [k] = 1\n}",
    "class K {\n  x = a as T[]\n  [k] = 1\n}",
    "class K {\n  x = a as Map<K, V>\n  [k] = 1\n}",
    "class K {\n  x = a as T.U\n  [k] = 1\n}",
    "class K {\n  x = a as () => T\n  [k] = 1\n}",
    "class K {\n  x = a as T as U\n  [k] = 1\n}",
    "class K {\n  x = a as T |\n    [number]\n  y = 1\n}",
    "class K {\n  x = a as T + b\n  [k]\n  y = 1\n}",
    "class K {\n  x = c as boolean ? a : b\n  [k]\n  y = 1\n}",
    "class K {\n  x = a as T extends U ? V : W\n  [k] = 1\n}",
    "class K {\n  x = (a as T)\n  [k]\n  y = 1\n}",
    "class K {\n  x = as\n  [k]\n  y = 1\n}",
    "class K {\n  x = a as T\n  * b\n  y = 1\n}",
  ])("ends the field where TypeScript does: %s", (source) => {
    expect(members(source)).toEqual(typescriptMembers(source));
  });
});
