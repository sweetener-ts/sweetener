import type {
  CaptureId,
  OriginId,
  RuleId,
  ScopeSetId,
  SourceId,
  SyntaxClassId,
  SyntaxId,
} from "@sweetener/shared";
import {
  createSyntaxCursor,
  createSpan,
  createToken,
  type Syntax,
} from "@sweetener/syntax";
import { describe, expect, it } from "vitest";
import {
  compileSyntaxClasses,
  compileMatcherProgram,
  createCapturePattern,
  createClassCallPattern,
  createLiteralPattern,
  createSequencePattern,
  createSyntaxClassConsumer,
  createTokenLiteralKey,
  executeMatcher,
  inferCaptureShapes,
  type PatternNode,
  type SyntaxClassInput,
} from "../src/index.js";

const sourceId = 1 as SourceId;
const origin = 2 as OriginId;
const scopes = 0 as ScopeSetId;
const tokenClass = 1 as SyntaxClassId;
const ttClass = 2 as SyntaxClassId;
const identClass = 3 as SyntaxClassId;
const pairClass = 10 as SyntaxClassId;
const wrapperClass = 11 as SyntaxClassId;
const unknownClass = 99 as SyntaxClassId;
const leftField = 20 as CaptureId;
const rightField = 21 as CaptureId;
const pairField = 22 as CaptureId;
const builtins = { token: tokenClass, tt: ttClass, ident: identClass };
let nextSyntaxId = 1;
let nextRuleId = 1;

function token(
  raw: string,
  kind: "identifier" | "punctuation" = "punctuation",
) {
  return createToken({
    id: nextSyntaxId++ as SyntaxId,
    span: createSpan(nextSyntaxId * 2, nextSyntaxId * 2 + raw.length),
    origin,
    scopes,
    kind,
    raw,
    value: kind === "identifier" ? raw : undefined,
  });
}

function literal(raw: string) {
  return createLiteralPattern(
    origin,
    createTokenLiteralKey("punctuation", raw),
  );
}

function capture(id: CaptureId, name: string, classId: SyntaxClassId) {
  return createCapturePattern({ origin, capture: id, name, classId });
}

function rule(pattern: PatternNode) {
  return { rule: nextRuleId++ as RuleId, pattern, origin };
}

function compile(inputs: readonly SyntaxClassInput[]) {
  return compileSyntaxClasses(inputs, {
    sourceId,
    spanForOrigin: () => ({ start: 0, end: 1 }),
    builtins,
  });
}

function consume(
  inputs: readonly SyntaxClassInput[],
  classId: SyntaxClassId,
  syntax: readonly Syntax[],
) {
  const compiled = compile(inputs);
  expect(compiled.diagnostics).toEqual([]);
  const consumer = createSyntaxClassConsumer(compiled.registry, { builtins });
  const pattern = createClassCallPattern(origin, classId);
  const inference = inferCaptureShapes(pattern, {
    sourceId,
    spanForOrigin: () => ({ start: 0, end: 1 }),
  });
  return executeMatcher(
    compileMatcherProgram(pattern, {
      rule: 100 as RuleId,
      inference,
    }),
    syntax,
    { consumeClass: consumer },
  );
}

describe("syntax classes", () => {
  it("provides token, token-tree, and identifier built-ins", () => {
    expect(consume([], tokenClass, [token("+")]).matched).toBe(true);
    expect(consume([], tokenClass, [token("name", "identifier")]).matched).toBe(
      true,
    );
    expect(consume([], identClass, [token("name", "identifier")]).matched).toBe(
      true,
    );
    expect(consume([], identClass, [token("+")]).matched).toBe(false);
    expect(consume([], ttClass, [token("+")]).matched).toBe(true);
  });

  it("reports the farthest failure inside a class, in its innermost description", () => {
    // `Pair` is `ident , ident`, described; `Wrapper` is `[ Pair ]`-shaped as
    // `< Pair >`, described too. `< a , + >` fails at `+`, two tokens into the
    // pair, and that is where the failure is reported -- in `Pair`'s words,
    // the class that was reading when it happened.
    const pair: SyntaxClassInput = {
      classId: pairClass,
      name: "Pair",
      origin,
      fields: [],
      rules: [
        {
          ...rule(
            createSequencePattern(origin, [
              capture(30 as CaptureId, "left", identClass),
              literal(","),
              capture(31 as CaptureId, "right", identClass),
            ]),
          ),
          failureDescription: "two names separated by a comma",
        },
      ],
    };
    const wrapper: SyntaxClassInput = {
      classId: wrapperClass,
      name: "Wrapper",
      origin,
      fields: [],
      rules: [
        {
          ...rule(
            createSequencePattern(origin, [
              literal("<"),
              createClassCallPattern(origin, pairClass),
              literal(">"),
            ]),
          ),
          failureDescription: "a pair in angle brackets",
        },
      ],
    };
    // Spans follow creation order, so the tokens are made in reading order.
    const input = [
      token("<"),
      token("a", "identifier"),
      token(","),
      token("+"),
      token(">"),
    ];
    const plus = input[3]!;
    const result = consume([pair, wrapper], wrapperClass, input);
    expect(result.matched).toBe(false);
    if (result.matched) throw new Error("expected a failure");
    expect(result.failure?.offset).toBe(plus.span.start);
    expect(result.failure?.at).toBe(plus.origin);
    expect(result.failure?.expectations).toEqual([
      { kind: "description", description: "two names separated by a comma" },
    ]);
  });

  it("matches ordered user rules and exports named field records", () => {
    const pair: SyntaxClassInput = {
      classId: pairClass,
      name: "Pair",
      origin,
      fields: [
        {
          capture: leftField,
          name: "left",
          classId: identClass,
          repeated: false,
          origin,
        },
        {
          capture: rightField,
          name: "right",
          classId: identClass,
          repeated: false,
          origin,
        },
      ],
      rules: [
        rule(
          createSequencePattern(origin, [
            capture(30 as CaptureId, "left", identClass),
            literal(","),
            capture(31 as CaptureId, "right", identClass),
          ]),
        ),
      ],
    };
    const compiled = compile([pair]);
    expect(compiled.diagnostics).toEqual([]);
    const consumer = createSyntaxClassConsumer(compiled.registry, { builtins });
    const result = consumer(
      pairClass,
      createSyntaxCursor([
        token("a", "identifier"),
        token(","),
        token("b", "identifier"),
      ]),
    );
    expect(result?.cursor.atEnd).toBe(true);
    expect(result?.fields?.get(leftField)).toMatchObject({
      kind: "leaf",
      id: leftField,
      syntax: [{ raw: "a" }],
    });
    expect(result?.fields?.get(rightField)).toMatchObject({
      kind: "leaf",
      id: rightField,
      syntax: [{ raw: "b" }],
    });
  });

  it("supports nested class calls and returned field records", () => {
    const pair: SyntaxClassInput = {
      classId: pairClass,
      name: "Pair",
      origin,
      fields: [
        {
          capture: leftField,
          name: "left",
          classId: identClass,
          repeated: false,
          origin,
        },
      ],
      rules: [rule(capture(30 as CaptureId, "left", identClass))],
    };
    const wrapper: SyntaxClassInput = {
      classId: wrapperClass,
      name: "Wrapper",
      origin,
      fields: [
        {
          capture: pairField,
          name: "pair",
          classId: pairClass,
          repeated: false,
          origin,
        },
      ],
      rules: [rule(capture(40 as CaptureId, "pair", pairClass))],
    };
    const compiled = compile([pair, wrapper]);
    expect(compiled.diagnostics).toEqual([]);
    const consumer = createSyntaxClassConsumer(compiled.registry, { builtins });
    const result = consumer(
      wrapperClass,
      createSyntaxCursor([token("a", "identifier")]),
    );
    const wrapped = result?.fields?.get(pairField);
    expect(wrapped).toMatchObject({ kind: "leaf", id: pairField });
    if (wrapped?.kind !== "leaf") throw new Error("expected wrapped leaf");
    expect(wrapped.fields.get(leftField)).toMatchObject({
      kind: "leaf",
      id: leftField,
    });
  });

  it("rejects missing fields, unresolved classes, and unguarded recursion", () => {
    const missingField: SyntaxClassInput = {
      classId: pairClass,
      name: "MissingField",
      origin,
      fields: [
        {
          capture: leftField,
          name: "left",
          classId: identClass,
          repeated: false,
          origin,
        },
      ],
      rules: [rule(literal("x"))],
    };
    expect(
      compile([missingField]).diagnostics.map((item) => item.code),
    ).toEqual(["SWR2007"]);

    const unresolved: SyntaxClassInput = {
      classId: pairClass,
      name: "Unresolved",
      origin,
      fields: [],
      rules: [rule(createClassCallPattern(origin, unknownClass))],
    };
    const unresolvedResult = compile([unresolved]);
    expect(unresolvedResult.diagnostics.map((item) => item.code)).toContain(
      "SWR2008",
    );
    expect(unresolvedResult.registry.get(pairClass)).toBeUndefined();

    const recursive: SyntaxClassInput = {
      classId: pairClass,
      name: "Recursive",
      origin,
      fields: [],
      rules: [rule(createClassCallPattern(origin, pairClass))],
    };
    const recursiveResult = compile([recursive]);
    expect(recursiveResult.diagnostics.map((item) => item.code)).toContain(
      "SWR2009",
    );
    expect(recursiveResult.registry.get(pairClass)).toBeUndefined();
  });

  it("allows recursion guarded by prior syntax consumption", () => {
    const recursive: SyntaxClassInput = {
      classId: pairClass,
      name: "Guarded",
      origin,
      fields: [],
      rules: [
        rule(literal("end")),
        rule(
          createSequencePattern(origin, [
            literal("next"),
            createClassCallPattern(origin, pairClass),
          ]),
        ),
      ],
    };
    const result = compile([recursive]);
    expect(result.diagnostics).toEqual([]);
    expect(result.registry.get(pairClass)?.rules).toHaveLength(2);
    const consumer = createSyntaxClassConsumer(result.registry, { builtins });
    const matched = consumer(
      pairClass,
      createSyntaxCursor([token("next"), token("next"), token("end")]),
    );
    expect(matched?.cursor.atEnd).toBe(true);
  });

  it("applies fixed refinements before accepting a class rule", () => {
    const lowercase: SyntaxClassInput = {
      classId: pairClass,
      name: "LowercaseName",
      origin,
      fields: [
        {
          capture: leftField,
          name: "name",
          classId: identClass,
          repeated: false,
          origin,
        },
      ],
      rules: [
        {
          ...rule(capture(30 as CaptureId, "name", identClass)),
          refinements: [
            {
              targetName: "name",
              predicate: { kind: "starts-with-lowercase" },
              origin,
            },
          ],
        },
      ],
    };
    const compiled = compile([lowercase]);
    expect(compiled.diagnostics).toEqual([]);
    const consumer = createSyntaxClassConsumer(compiled.registry, { builtins });
    expect(
      consumer(pairClass, createSyntaxCursor([token("lower", "identifier")])),
    ).toBeDefined();
    expect(
      consumer(pairClass, createSyntaxCursor([token("Upper", "identifier")])),
    ).toBeUndefined();

    const malformed: SyntaxClassInput = {
      ...lowercase,
      rules: [
        {
          ...rule(capture(31 as CaptureId, "name", identClass)),
          refinements: [
            {
              targetName: "missing",
              predicate: { kind: "starts-with-lowercase" },
              origin,
            },
          ],
        },
      ],
    };
    expect(compile([malformed]).diagnostics.map((item) => item.code)).toContain(
      "SWR2010",
    );
  });
});
