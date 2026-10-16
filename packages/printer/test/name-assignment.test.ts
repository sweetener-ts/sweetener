import type {
  BindingId,
  OriginId,
  ScopeSetId,
  SyntaxId,
} from "@sweetener/shared";
import { createRootSyntax, createToken } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import { assignPrintedNames, printWithAssignedNames } from "../src/index.js";

const binding = (value: number) => value as BindingId;
const syntax = (value: number) => value as SyntaxId;

describe("deterministic printed-name assignment", () => {
  test("uses expanded traversal order to suffix visible collisions", () => {
    const plan = assignPrintedNames({
      declarations: [
        {
          binding: binding(20),
          preferredName: "value",
          conflicts: [binding(10)],
        },
        {
          binding: binding(10),
          preferredName: "value",
          conflicts: [binding(20)],
        },
      ],
      occurrences: [
        { syntax: syntax(9), binding: binding(10), kind: "identifier" },
        { syntax: syntax(2), binding: binding(20), kind: "identifier" },
      ],
    });
    expect(plan.nameFor(binding(10))).toBe("value");
    expect(plan.nameFor(binding(20))).toBe("value_1");
    expect(plan.rewrites.map((rewrite) => rewrite.replacement)).toEqual([
      "value",
      "value_1",
    ]);
  });

  test("does not rename equal spellings that cannot be simultaneously visible", () => {
    const plan = assignPrintedNames({
      declarations: [
        { binding: binding(1), preferredName: "item", conflicts: [] },
        { binding: binding(2), preferredName: "item", conflicts: [] },
      ],
      occurrences: [
        { syntax: syntax(1), binding: binding(1), kind: "identifier" },
        { syntax: syntax(2), binding: binding(2), kind: "identifier" },
      ],
    });
    expect([...plan.names.values()]).toEqual(["item", "item"]);
  });

  test("expands shorthand properties without renaming their keys", () => {
    const plan = assignPrintedNames({
      declarations: [
        { binding: binding(1), preferredName: "x", conflicts: [binding(2)] },
        { binding: binding(2), preferredName: "x", conflicts: [binding(1)] },
      ],
      occurrences: [
        { syntax: syntax(1), binding: binding(1), kind: "identifier" },
        {
          syntax: syntax(2),
          binding: binding(2),
          kind: "shorthand-value",
          propertySpelling: "x",
        },
      ],
    });
    expect(plan.rewrites[1]).toMatchObject({
      printedName: "x_1",
      replacement: "x: x_1",
      expandsShorthand: true,
    });
  });

  test("sanitizes generated hints and avoids unavailable names repeatably", () => {
    const input = {
      declarations: [
        { binding: binding(1), preferredName: "class", conflicts: [] },
        { binding: binding(2), preferredName: "two words", conflicts: [] },
      ],
      occurrences: [
        { syntax: syntax(1), binding: binding(1), kind: "identifier" as const },
        { syntax: syntax(2), binding: binding(2), kind: "identifier" as const },
      ],
      unavailableNames: ["_class"],
    };
    const first = assignPrintedNames(input);
    const second = assignPrintedNames(input);
    expect([...first.names]).toEqual([
      [binding(1), "_class_1"],
      [binding(2), "two_words"],
    ]);
    expect([...second.names]).toEqual([...first.names]);
  });

  test("rejects incomplete identity and shorthand metadata", () => {
    expect(() =>
      assignPrintedNames({
        declarations: [],
        occurrences: [
          { syntax: syntax(1), binding: binding(1), kind: "identifier" },
        ],
      }),
    ).toThrow(/unknown binding/);
    expect(() =>
      assignPrintedNames({
        declarations: [
          { binding: binding(1), preferredName: "x", conflicts: [] },
        ],
        occurrences: [
          { syntax: syntax(1), binding: binding(1), kind: "shorthand-value" },
        ],
      }),
    ).toThrow(/property spelling/);
    expect(() =>
      assignPrintedNames({
        declarations: [
          { binding: binding(1), preferredName: "x", conflicts: [] },
        ],
        occurrences: [],
      }),
    ).toThrow(/no traversal occurrence/);
  });

  test("names declarations that all conflict as listing every conflict does", () => {
    let state = 0x6a5_17e5;
    const random = (bound: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % bound;
    };
    // Spellings whose suffixed names are other spellings, as `v_1` is `v`'s
    // first, and one that is a reserved word.
    const spellings = ["v", "v_1", "v_2", "v_1_1", "w", "class", "_class"];
    for (let trial = 0; trial < 40; trial += 1) {
      const count = 1 + random(60);
      const ids = Array.from({ length: count }, (_, index) =>
        binding(index + 1),
      );
      const preferred = ids.map(() => spellings[random(spellings.length)]!);
      const occurrences = ids
        .map((id, index) => ({ id, order: random(1_000), index }))
        .sort(
          (left, right) => left.order - right.order || left.index - right.index,
        )
        .map(({ id }, index) => ({
          syntax: syntax(index + 1),
          binding: id,
          kind: "identifier" as const,
        }));
      const unavailableNames = spellings
        .flatMap((spelling) => [spelling, `${spelling}_1`, `${spelling}_3`])
        .filter(() => random(4) === 0);
      const listed = assignPrintedNames({
        declarations: ids.map((id, index) => ({
          binding: id,
          preferredName: preferred[index]!,
          conflicts: ids.filter((other) => other !== id),
        })),
        occurrences,
        unavailableNames,
      });
      const all = assignPrintedNames({
        declarations: ids.map((id, index) => ({
          binding: id,
          preferredName: preferred[index]!,
        })),
        everyDeclarationConflicts: true,
        occurrences,
        unavailableNames,
      });
      expect([...all.names]).toEqual([...listed.names]);
      expect(all.rewrites).toEqual(listed.rewrites);
    }
  });

  test("names thousands of conflicting declarations of one spelling", () => {
    const count = 20_000;
    const plan = assignPrintedNames({
      declarations: Array.from({ length: count }, (_, index) => ({
        binding: binding(index + 1),
        preferredName: "v",
      })),
      everyDeclarationConflicts: true,
      occurrences: Array.from({ length: count }, (_, index) => ({
        syntax: syntax(index + 1),
        binding: binding(index + 1),
        kind: "identifier" as const,
      })),
    });
    expect(plan.nameFor(binding(1))).toBe("v");
    expect(plan.nameFor(binding(count))).toBe(`v_${String(count - 1)}`);
    expect(new Set(plan.names.values()).size).toBe(count);
  });

  test("refuses listed conflicts when every declaration conflicts", () => {
    expect(() =>
      assignPrintedNames({
        declarations: [
          { binding: binding(1), preferredName: "x", conflicts: [binding(2)] },
          { binding: binding(2), preferredName: "x" },
        ],
        everyDeclarationConflicts: true,
        occurrences: [
          { syntax: syntax(1), binding: binding(1), kind: "identifier" },
          { syntax: syntax(2), binding: binding(2), kind: "identifier" },
        ],
      }),
    ).toThrow(/lists its conflicts/);
  });

  test("prints planned names and shorthand expansions without formatting", () => {
    const token = createToken({
      id: syntax(1),
      span: { start: 0, end: 1 },
      origin: 1 as OriginId,
      scopes: 0 as ScopeSetId,
      kind: "identifier",
      raw: "x",
      value: "x",
      leadingTrivia: [
        {
          kind: "whitespace",
          raw: " ",
          span: { start: 0, end: 1 },
          hasLineBreak: false,
        },
      ],
    });
    const root = createRootSyntax({
      id: syntax(2),
      span: { start: 0, end: 1 },
      origin: 1 as OriginId,
      scopes: 0 as ScopeSetId,
      children: [token],
    });
    const plan = assignPrintedNames({
      declarations: [
        { binding: binding(1), preferredName: "x", conflicts: [] },
      ],
      occurrences: [
        {
          syntax: token.id,
          binding: binding(1),
          kind: "shorthand-value",
          propertySpelling: "property",
        },
      ],
      unavailableNames: ["x"],
    });
    expect(printWithAssignedNames(root, plan)).toBe(" property: x_1");
  });
});
