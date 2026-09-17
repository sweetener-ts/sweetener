import {
  CaptureShapeRecord,
  createLeafShape,
  createSequenceShape,
  type CaptureShapeBinding,
} from "@sweetener/pattern";
import { readSyntax } from "@sweetener/reader";
import type {
  CaptureId,
  CardinalityGroupId,
  OriginId,
  ScopeSetId,
  SourceId,
  SyntaxClassId,
} from "@sweetener/shared";
import type { GroupSyntax, Span, Syntax } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import { parseTemplate } from "../src/index.js";

const sourceId = 73 as SourceId;
const scopes = 0 as ScopeSetId;
const id = <T extends number>(value: number) => value as T;

function templateSource(source: string): {
  readonly group: GroupSyntax;
  readonly spans: ReadonlyMap<OriginId, Span>;
} {
  const read = readSyntax(source, { sourceId, scopes });
  expect(read.diagnostics).toEqual([]);
  const group = read.root.children.find(
    (syntax): syntax is GroupSyntax => syntax.tag === "group",
  );
  if (group === undefined) throw new Error("expected template group");
  const spans = new Map<OriginId, Span>();
  const stack: Syntax[] = [...read.root.children];
  while (stack.length > 0) {
    const syntax = stack.pop()!;
    spans.set(syntax.origin, syntax.span);
    if (syntax.tag === "group" || syntax.tag === "protected") {
      stack.push(...syntax.children);
    }
  }
  return { group, spans };
}

function binding(
  name: string,
  capture: number,
  shape: CaptureShapeBinding["shape"],
): CaptureShapeBinding {
  return Object.freeze({
    name,
    capture: id<CaptureId>(capture),
    origin: id<OriginId>(capture),
    shape,
  });
}

function parse(
  source: string,
  captures: readonly CaptureShapeBinding[],
  fieldsForClass?: Parameters<typeof parseTemplate>[1]["fieldsForClass"],
  identifierClassIds?: Parameters<
    typeof parseTemplate
  >[1]["identifierClassIds"],
) {
  const { group, spans } = templateSource(source);
  return parseTemplate(group, {
    sourceId,
    captures,
    fieldsForClass,
    identifierClassIds,
    spanForOrigin: (origin) => spans.get(origin) ?? { start: 0, end: 0 },
  });
}

describe("template parser", () => {
  test("parses literals, groups, captures, and resolved field paths", () => {
    const nameClass = id<SyntaxClassId>(2);
    const itemClass = id<SyntaxClassId>(1);
    const nameCapture = id<CaptureId>(12);
    const nameShape = createLeafShape(nameClass);
    const itemShape = createLeafShape(
      itemClass,
      new CaptureShapeRecord([[nameCapture, nameShape]]),
    );
    const result = parse(
      "{ make($item.name) }",
      [binding("item", 10, itemShape)],
      (classId) =>
        classId === itemClass
          ? [{ name: "name", capture: nameCapture }]
          : undefined,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.template).toMatchObject({
      kind: "sequence",
      elements: [
        { kind: "literal", syntax: { raw: "make" } },
        {
          kind: "group",
          delimiter: "parenthesis",
          body: {
            elements: [
              {
                kind: "capture",
                path: {
                  rootName: "item",
                  root: id<CaptureId>(10),
                  fields: [{ name: "name", capture: nameCapture }],
                },
              },
            ],
          },
        },
      ],
    });
    expect(Object.isFrozen(result.template)).toBe(true);
    expect(Object.isFrozen(result.template.elements)).toBe(true);
  });

  test("parses separated repetition and records its driver group", () => {
    const groupId = id<CardinalityGroupId>(31);
    const repeated = createSequenceShape({
      element: createLeafShape(id<SyntaxClassId>(1)),
      cardinalityGroup: groupId,
      minimum: 1,
    });
    const result = parse("{ emit($($items),+) }", [
      binding("items", 1, repeated),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.template).toMatchObject({
      elements: [
        { kind: "literal" },
        {
          kind: "group",
          body: {
            elements: [
              {
                kind: "repeat",
                depth: 1,
                cardinalityGroup: groupId,
                separator: { kind: "literal", syntax: { raw: "," } },
                body: { elements: [{ kind: "capture" }] },
              },
            ],
          },
        },
      ],
    });
  });

  test("reports unknown captures, fields, and insufficient depth", () => {
    const classId = id<SyntaxClassId>(1);
    const repeated = createSequenceShape({
      element: createLeafShape(classId),
      cardinalityGroup: id<CardinalityGroupId>(1),
      minimum: 0,
    });
    const result = parse(
      "{ $missing $items.nope $items }",
      [binding("items", 1, repeated)],
      () => [],
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2011",
      "SWR2012",
      "SWR2013",
      "SWR2013",
    ]);
  });

  test("preserves property access after captures of external classes", () => {
    const expressionClass = id<SyntaxClassId>(8);
    const result = parse(
      "{ $value.flatMap($other) }",
      [
        binding("value", 1, createLeafShape(expressionClass)),
        binding("other", 2, createLeafShape(expressionClass)),
      ],
      () => undefined,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.template).toMatchObject({
      elements: [
        { kind: "capture", path: { rootName: "value", fields: [] } },
        { kind: "literal", syntax: { raw: "." } },
        { kind: "literal", syntax: { raw: "flatMap" } },
        { kind: "group" },
      ],
    });
  });

  test("rejects repetitions without a driver or with incompatible drivers", () => {
    const leaf = createLeafShape(id<SyntaxClassId>(1));
    const left = createSequenceShape({
      element: leaf,
      cardinalityGroup: id<CardinalityGroupId>(1),
      minimum: 0,
    });
    const right = createSequenceShape({
      element: leaf,
      cardinalityGroup: id<CardinalityGroupId>(2),
      minimum: 0,
    });
    const result = parse("{ $(literal)* $($left $right)+ }", [
      binding("left", 1, left),
      binding("right", 2, right),
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2014",
      "SWR2015",
    ]);
  });

  test("reports malformed repetition and returns a partial immutable tree", () => {
    const result = parse("{ $(literal) }", []);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2016",
    ]);
    expect(Object.isFrozen(result.template)).toBe(true);
  });

  test("supports nested repetition dimensions", () => {
    const inner = createSequenceShape({
      element: createLeafShape(id<SyntaxClassId>(1)),
      cardinalityGroup: id<CardinalityGroupId>(2),
      minimum: 0,
    });
    const outer = createSequenceShape({
      element: inner,
      cardinalityGroup: id<CardinalityGroupId>(1),
      minimum: 0,
    });
    const result = parse("{ $($( $items )*)* }", [binding("items", 1, outer)]);
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements[0]).toMatchObject({
      kind: "repeat",
      depth: 1,
      cardinalityGroup: id<CardinalityGroupId>(1),
      body: {
        elements: [
          {
            kind: "repeat",
            depth: 2,
            cardinalityGroup: id<CardinalityGroupId>(2),
          },
        ],
      },
    });
  });

  const optionalShape = () =>
    createSequenceShape({
      element: createLeafShape(id<SyntaxClassId>(1)),
      cardinalityGroup: id<CardinalityGroupId>(1),
      minimum: 0,
      maximum: 1,
    });

  test("parses declarative presence conditionals", () => {
    const result = parse("{ #if(present $maybe) { yes } #else { no } }", [
      binding("maybe", 1, optionalShape()),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements).toMatchObject([
      {
        kind: "conditional",
        predicate: { kind: "present", path: { rootName: "maybe" } },
        consequent: { elements: [{ syntax: { raw: "yes" } }] },
        alternate: { elements: [{ syntax: { raw: "no" } }] },
      },
    ]);
  });

  test("refuses a presence conditional with more than the capture in it", () => {
    const result = parse("{ #if(present $maybe and then some) { yes } }", [
      binding("maybe", 1, optionalShape()),
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2016",
    ]);
  });

  test("carries #parameterize through with captures read in both groups", () => {
    const result = parse("{ #parameterize(% = $value) { f($body) } }", [
      binding("value", 1, createLeafShape(id<SyntaxClassId>(1))),
      binding("body", 2, createLeafShape(id<SyntaxClassId>(1))),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements.map((element) => element.kind)).toEqual([
      "literal",
      "group",
      "group",
    ]);
  });

  test.each([
    "{ #parameterize(%) { body } }",
    "{ #parameterize(% =) { body } }",
    "{ #parameterize(= topic) { body } }",
    "{ #parameterize(% = topic) }",
    "{ #parameterize(a b = topic) { body } }",
  ])("reports a malformed #parameterize: %s", (source) => {
    const result = parse(source, []);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2016",
    ]);
  });

  test("carries #let and #parameterize(required ...) through", () => {
    const result = parse(
      "{ #let(topic = $value) { #parameterize(required % = topic) { $body } } }",
      [
        binding("value", 1, createLeafShape(id<SyntaxClassId>(1))),
        binding("body", 2, createLeafShape(id<SyntaxClassId>(1))),
      ],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements.map((element) => element.kind)).toEqual([
      "literal",
      "group",
      "group",
    ]);
  });

  test.each([
    "{ #let(topic) { body } }",
    "{ #let(topic =) { body } }",
    "{ #let(a b = value) { body } }",
    "{ #let(topic = value) }",
    "{ #let(topic = value) {} }",
  ])("reports a malformed #let: %s", (source) => {
    const result = parse(source, []);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2016",
    ]);
  });

  test("reports malformed declarative conditionals", () => {
    const result = parse("{ #if(unknown $missing) { value } }", []);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2011",
      "SWR2016",
    ]);
  });

  test("parses and validates the finite hygiene operation set", () => {
    const identClass = id<SyntaxClassId>(1);
    const exprClass = id<SyntaxClassId>(2);
    const cardinality = id<CardinalityGroupId>(1);
    const repeated = createSequenceShape({
      element: createLeafShape(identClass),
      cardinalityGroup: cardinality,
      minimum: 0,
    });
    const result = parse(
      '{ #fresh("tmp") #callsite($name) #definition($name) #capture($name) #text($expr) #join($name, prefix: "set", casing: "upper-first") #count($items) $($items #index()),* }',
      [
        binding("name", 1, createLeafShape(identClass)),
        binding("expr", 2, createLeafShape(exprClass)),
        binding("items", 3, repeated),
      ],
      undefined,
      [identClass],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements).toMatchObject([
      { kind: "operation", operation: { kind: "fresh", hint: "tmp" } },
      { kind: "operation", operation: { kind: "callsite" } },
      { kind: "operation", operation: { kind: "definition" } },
      { kind: "operation", operation: { kind: "capture" } },
      { kind: "operation", operation: { kind: "text" } },
      {
        kind: "operation",
        operation: {
          kind: "join",
          spec: {
            prefix: "set",
            suffix: "",
            casing: "upper-first",
          },
        },
      },
      { kind: "operation", operation: { kind: "count" } },
      {
        kind: "repeat",
        body: {
          elements: [
            { kind: "capture" },
            { kind: "operation", operation: { kind: "index" } },
          ],
        },
      },
    ]);
  });

  test("uses a repeated capture to drive deterministic generated metavariables", () => {
    const cardinality = id<CardinalityGroupId>(9);
    const items = createSequenceShape({
      element: createLeafShape(id<SyntaxClassId>(1)),
      cardinalityGroup: cardinality,
      minimum: 0,
    });
    const result = parse('{ $(#metavar("argument", $items)),* }', [
      binding("items", 1, items),
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements).toMatchObject([
      {
        kind: "repeat",
        body: {
          elements: [
            {
              kind: "operation",
              operation: { kind: "metavar", hint: "argument" },
            },
          ],
        },
      },
    ]);
  });

  test("rejects invalid operation arguments at definition time", () => {
    const identClass = id<SyntaxClassId>(1);
    const exprClass = id<SyntaxClassId>(2);
    const result = parse(
      '{ #fresh("") #callsite($expr) #join() #index() }',
      [binding("expr", 1, createLeafShape(exprClass))],
      undefined,
      [identClass],
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2017",
      "SWR2017",
      "SWR2017",
      "SWR2017",
    ]);
  });

  test("parses bounded folds with fixed locals", () => {
    const cardinality = id<CardinalityGroupId>(1);
    const repeated = createSequenceShape({
      element: createLeafShape(id<SyntaxClassId>(1)),
      cardinalityGroup: cardinality,
      minimum: 0,
    });
    const result = parse(
      "{ #fold($items, init: { seed }) { ($acc, $item, $index) => { $acc , $item : $index } } }",
      [binding("items", 1, repeated)],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.template.elements).toMatchObject([
      {
        kind: "fold",
        driver: { rootName: "items" },
        initial: { elements: [{ syntax: { raw: "seed" } }] },
        body: {
          elements: [
            { kind: "local", local: "accumulator" },
            { kind: "literal", syntax: { raw: "," } },
            { kind: "local", local: "element" },
            { kind: "literal", syntax: { raw: ":" } },
            { kind: "local", local: "index" },
          ],
        },
      },
    ]);
  });

  test("rejects malformed or nonrepeated fold drivers", () => {
    const leaf = createLeafShape(id<SyntaxClassId>(1));
    const result = parse(
      "{ #fold($item, init: { seed }) { ($wrong) => { value } } }",
      [binding("item", 1, leaf)],
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "SWR2017",
    ]);
  });
});
