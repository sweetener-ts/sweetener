import {
  CaptureRecord,
  createCaptureLeaf,
  createCapturePath,
  createCaptureSequence,
  createLeafShape,
  createSequenceShape,
  type CaptureShapeBinding,
} from "@sweetener/pattern";
import { readSyntax } from "@sweetener/reader";
import {
  CancellationError,
  CancellationSource,
  ResourceLimitError,
  type CaptureId,
  type CardinalityGroupId,
  type OriginId,
  type ScopeSetId,
  type SourceId,
  type SyntaxClassId,
} from "@sweetener/shared";
import type { GroupSyntax, Span, Syntax } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  createConditionalTemplate,
  createLiteralTemplate,
  createSequenceTemplate,
  evaluateTemplate,
  parseTemplate,
  TemplateCardinalityError,
} from "../src/index.js";

const sourceId = 81 as SourceId;
const scopes = 0 as ScopeSetId;
const captureId = (value: number) => value as CaptureId;
const groupId = (value: number) => value as CardinalityGroupId;
const classId = 1 as SyntaxClassId;

function readGroup(source: string) {
  const read = readSyntax(source, { sourceId, scopes });
  const group = read.root.children.find(
    (syntax): syntax is GroupSyntax => syntax.tag === "group",
  );
  if (group === undefined) throw new Error("expected group");
  return { read, group };
}

function token(raw: string, id: CaptureId) {
  const read = readSyntax(raw, { sourceId, scopes });
  const syntax = read.root.children[0]!;
  return createCaptureLeaf({
    id,
    classId,
    syntax: [syntax],
    origin: syntax.origin,
  });
}

function binding(
  name: string,
  id: CaptureId,
  depth: number,
  groups: readonly CardinalityGroupId[],
): CaptureShapeBinding {
  let shape: CaptureShapeBinding["shape"] = createLeafShape(classId);
  for (let index = depth - 1; index >= 0; index -= 1) {
    shape = createSequenceShape({
      element: shape,
      cardinalityGroup: groups[index]!,
      minimum: 0,
    });
  }
  return Object.freeze({ name, capture: id, origin: 1 as OriginId, shape });
}

function compile(source: string, captures: readonly CaptureShapeBinding[]) {
  const { read, group } = readGroup(source);
  const spans = new Map<OriginId, Span>();
  const stack: Syntax[] = [...read.root.children];
  while (stack.length > 0) {
    const syntax = stack.pop()!;
    spans.set(syntax.origin, syntax.span);
    if (syntax.tag === "group" || syntax.tag === "protected") {
      stack.push(...syntax.children);
    }
  }
  const result = parseTemplate(group, {
    sourceId,
    captures,
    spanForOrigin: (origin) => spans.get(origin) ?? { start: 0, end: 0 },
  });
  expect(result.diagnostics).toEqual([]);
  return result.template;
}

function raws(output: ReturnType<typeof evaluateTemplate>["output"]): string[] {
  const values: string[] = [];
  const stack = [...output].reverse();
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === "group" || item.kind === "fold")
      stack.push(...[...item.body].reverse());
    else if (item.kind === "syntax")
      values.push(
        ...item.syntax.map((syntax) =>
          syntax.tag === "token" ? syntax.raw : syntax.tag,
        ),
      );
    else if (item.operation === "text" || item.operation === "join")
      values.push(item.text);
    else if (item.operation === "index" || item.operation === "count")
      values.push(String(item.value));
    else if (item.operation === "fresh") values.push(item.hint);
    else if (item.operation === "metavar")
      values.push(`$${item.hint}_${item.indices.join("_")}`);
    else if ("syntax" in item)
      values.push(
        ...item.syntax.map((syntax) =>
          syntax.tag === "token" ? syntax.raw : syntax.tag,
        ),
      );
  }
  return values;
}

describe("template evaluator", () => {
  test("selects repeated captures and emits separators", () => {
    const items = captureId(1);
    const cardinality = groupId(1);
    const template = compile("{ $($items),+ }", [
      binding("items", items, 1, [cardinality]),
    ]);
    const captures = new CaptureRecord([
      [
        items,
        createCaptureSequence({
          depth: 1,
          cardinalityGroup: cardinality,
          elements: [token("a", items), token("b", items), token("c", items)],
        }),
      ],
    ]);
    const result = evaluateTemplate(template, { captures });
    expect(raws(result.output)).toEqual(["a", ",", "b", ",", "c"]);
    expect(result.templateSteps).toBeGreaterThan(0);
  });

  test("evaluates nested repetition dimensions independently", () => {
    const items = captureId(1);
    const outer = groupId(1);
    const inner = groupId(2);
    const template = compile("{ $($( $items ),*)* }", [
      binding("items", items, 2, [outer, inner]),
    ]);
    const row = (values: readonly string[]) =>
      createCaptureSequence({
        depth: 1,
        cardinalityGroup: inner,
        elements: values.map((value) => token(value, items)),
      });
    const captures = new CaptureRecord([
      [
        items,
        createCaptureSequence({
          depth: 2,
          cardinalityGroup: outer,
          elements: [row(["a", "b"]), row(["c"])],
        }),
      ],
    ]);
    expect(raws(evaluateTemplate(template, { captures }).output)).toEqual([
      "a",
      ",",
      "b",
      "c",
    ]);
  });

  test("rejects runtime cardinality disagreement", () => {
    const left = captureId(1);
    const right = captureId(2);
    const cardinality = groupId(1);
    const template = compile("{ $($left $right)* }", [
      binding("left", left, 1, [cardinality]),
      binding("right", right, 1, [cardinality]),
    ]);
    const sequence = (id: CaptureId, values: readonly string[]) =>
      createCaptureSequence({
        depth: 1,
        cardinalityGroup: cardinality,
        elements: values.map((value) => token(value, id)),
      });
    const captures = new CaptureRecord([
      [left, sequence(left, ["a", "b"])],
      [right, sequence(right, ["x"])],
    ]);
    expect(() => evaluateTemplate(template, { captures })).toThrowError(
      new TemplateCardinalityError(1, [2, 1]),
    );
  });

  test("branches on optional presence and selected alternatives", () => {
    const optional = captureId(1);
    const path = createCapturePath("optional", optional);
    const { group } = readGroup("{ yes no } ");
    const yes = createSequenceTemplate(group.origin, [
      createLiteralTemplate(group.children[0]!),
    ]);
    const no = createSequenceTemplate(group.origin, [
      createLiteralTemplate(group.children[1]!),
    ]);
    const present = createSequenceTemplate(group.origin, [
      createConditionalTemplate({
        origin: group.origin,
        predicate: Object.freeze({ kind: "present", path }),
        consequent: yes,
        alternate: no,
      }),
    ]);
    const absentCaptures = new CaptureRecord([
      [
        optional,
        createCaptureSequence({
          depth: 1,
          cardinalityGroup: groupId(1),
          elements: [],
        }),
      ],
    ]);
    expect(
      raws(evaluateTemplate(present, { captures: absentCaptures }).output),
    ).toEqual(["no"]);
  });

  test("enforces template-step budgets and cancellation", () => {
    const { group } = readGroup("{ value } ");
    const template = createSequenceTemplate(group.origin, [
      createLiteralTemplate(group.children[0]!),
    ]);
    expect(() =>
      evaluateTemplate(template, {
        captures: CaptureRecord.empty,
        budget: { maxTemplateSteps: 1 },
      }),
    ).toThrowError(new ResourceLimitError("template-steps", 1, 2));
    const cancellation = new CancellationSource();
    cancellation.cancel();
    expect(() =>
      evaluateTemplate(template, {
        captures: CaptureRecord.empty,
        cancellation: cancellation.token,
      }),
    ).toThrow(CancellationError);
  });

  test("evaluates finite hygiene operations and records searchable traces", () => {
    const name = captureId(1);
    const expr = captureId(2);
    const items = captureId(3);
    const cardinality = groupId(1);
    const template = compile(
      '{ #fresh("tmp") #callsite($name) #definition($name) #capture($name) #text($expr) #join($name, prefix: "set", casing: "upper-first") #count($items) $($items #index()),* }',
      [
        binding("name", name, 0, []),
        binding("expr", expr, 0, []),
        binding("items", items, 1, [cardinality]),
      ],
    );
    const captures = new CaptureRecord([
      [name, token("caller", name)],
      [expr, token("(a + b)", expr)],
      [
        items,
        createCaptureSequence({
          depth: 1,
          cardinalityGroup: cardinality,
          elements: [token("x", items), token("y", items)],
        }),
      ],
    ]);
    const result = evaluateTemplate(template, { captures });
    expect(result.output).toMatchObject([
      { kind: "operation", operation: "fresh", hint: "tmp", ordinal: 0 },
      { kind: "operation", operation: "callsite" },
      { kind: "operation", operation: "definition" },
      { kind: "operation", operation: "capture" },
      { kind: "operation", operation: "text", text: "(a + b)" },
      { kind: "operation", operation: "join", text: "setCaller" },
      { kind: "operation", operation: "count", value: 2 },
      { kind: "syntax", syntax: [{ raw: "x" }] },
      { kind: "operation", operation: "index", value: 0 },
      { kind: "syntax", syntax: [{ raw: "," }] },
      { kind: "syntax", syntax: [{ raw: "y" }] },
      { kind: "operation", operation: "index", value: 1 },
    ]);
    expect(result.trace.map((event) => event.operation)).toEqual([
      "fresh",
      "callsite",
      "definition",
      "capture",
      "text",
      "join",
      "count",
      "index",
      "index",
    ]);
    expect(result.trace.at(-1)?.repetitionIndices).toEqual([1]);
    expect(Object.isFrozen(result.trace)).toBe(true);
  });

  test("evaluates stable metavariable names from repetition indices", () => {
    const items = captureId(8);
    const cardinality = groupId(8);
    const template = compile('{ $(#metavar("argument", $items)),* }', [
      binding("items", items, 1, [cardinality]),
    ]);
    const captures = new CaptureRecord([
      [
        items,
        createCaptureSequence({
          depth: 1,
          cardinalityGroup: cardinality,
          elements: [token("left", items), token("right", items)],
        }),
      ],
    ]);
    const result = evaluateTemplate(template, { captures });
    expect(raws(result.output)).toEqual(["$argument_0", ",", "$argument_1"]);
    expect(result.trace.map(({ operation }) => operation)).toEqual([
      "metavar",
      "metavar",
    ]);
  });

  test("text conversion excludes peripheral call-site trivia", () => {
    const expr = captureId(1);
    const template = compile("{ #text($expr) }", [
      binding("expr", expr, 0, []),
    ]);
    const syntax = token("Some", expr);
    const withTrivia = Object.freeze({
      ...syntax,
      leadingTrivia: Object.freeze([
        Object.freeze({ kind: "whitespace" as const, raw: "  " }),
      ]),
      trailingTrivia: Object.freeze([
        Object.freeze({ kind: "whitespace" as const, raw: "\n" }),
      ]),
    });
    const result = evaluateTemplate(template, {
      captures: new CaptureRecord([[expr, withTrivia]]),
    });
    expect(result.output).toMatchObject([
      { kind: "operation", operation: "text", text: "Some" },
    ]);
  });

  test("evaluates bounded folds with accumulator, element, and index locals", () => {
    const items = captureId(1);
    const cardinality = groupId(1);
    const template = compile(
      "{ #fold($items, init: { seed }) { ($acc, $item, $index) => { $acc , $item : $index } } }",
      [binding("items", items, 1, [cardinality])],
    );
    const captures = new CaptureRecord([
      [
        items,
        createCaptureSequence({
          depth: 1,
          cardinalityGroup: cardinality,
          elements: [token("a", items), token("b", items)],
        }),
      ],
    ]);
    const result = evaluateTemplate(template, { captures });
    expect(raws(result.output)).toEqual([
      "seed",
      ",",
      "a",
      ":",
      "0",
      ",",
      "b",
      ":",
      "1",
    ]);
    // The result and each accumulator a step spliced stay marked, for
    // expansion to decide what they are where the fold stands.
    const [folded] = result.output;
    expect(result.output).toHaveLength(1);
    expect(folded).toMatchObject({ kind: "fold", part: "result" });
    expect(folded?.kind === "fold" ? folded.body[0] : undefined).toMatchObject({
      kind: "fold",
      part: "accumulator",
    });
    expect(result.trace.map((event) => event.operation)).toEqual([
      "index",
      "index",
    ]);
  });
});
