import type { CaptureId, InvocationId, SourceId } from "@sweetener/shared";
import { OriginStore } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import {
  createOriginQueryIndex,
  type PrintedExpandedFile,
} from "../src/index.js";

describe("origin query index", () => {
  test("queries generated/original boundaries, repeats, gaps, and invocation stacks", () => {
    const origins = new OriginStore();
    const source = origins.source(1001 as SourceId, { start: 10, end: 14 });
    const copied = origins.copied(1 as CaptureId, source);
    const invocation = origins.source(1002 as SourceId, { start: 30, end: 34 });
    const definition = origins.source(1003 as SourceId, { start: 50, end: 54 });
    const introduced = origins.introduced(definition, invocation);
    const file: PrintedExpandedFile = {
      text: "copy gap copy intro)",
      originMap: {
        schemaVersion: 1,
        entries: [
          {
            generatedStart: 0,
            generatedEnd: 4,
            origin: copied,
            kind: "copied",
          },
          {
            generatedStart: 9,
            generatedEnd: 13,
            origin: copied,
            kind: "copied",
          },
          {
            generatedStart: 14,
            generatedEnd: 19,
            origin: introduced,
            kind: "introduced",
          },
          {
            generatedStart: 19,
            generatedEnd: 20,
            origin: introduced,
            kind: "grouping",
          },
        ],
      },
      trace: [],
      tokenSpans: [],
      serializedTrace: "[]\n",
    };
    const index = createOriginQueryIndex({
      file,
      origins,
      expansionStack: (origin) =>
        origin === introduced
          ? [
              {
                invocationId: 2 as InvocationId,
                macroName: "outer",
                origin: { sourceId: 1002 as SourceId, start: 30, end: 34 },
              },
              {
                invocationId: 1 as InvocationId,
                macroName: "form",
                origin: { sourceId: 1002 as SourceId, start: 30, end: 34 },
              },
            ]
          : [],
    });
    expect(index.generatedToOriginal(0)[0]).toMatchObject({
      kind: "copied",
      primary: { sourceId: 1001, span: { start: 10, end: 14 } },
      projectedOriginalOffset: 10,
    });
    expect(index.generatedToOriginal(3)[0]?.projectedOriginalOffset).toBe(13);
    expect(index.generatedToOriginal(4)).toEqual([]);
    expect(index.generatedToOriginal(8)).toEqual([]);
    expect(index.originalToGenerated(1001 as SourceId, 10)).toHaveLength(2);
    expect(
      index
        .originalToGenerated(1001 as SourceId, 12)
        .map(({ projectedGeneratedOffset }) => projectedGeneratedOffset),
    ).toEqual([2, 11]);
    expect(index.originalToGenerated(1001 as SourceId, 14)).toEqual([]);
    expect(index.generatedToOriginal(14)[0]).toMatchObject({
      kind: "introduced",
      primary: { sourceId: 1002 },
      projectedOriginalOffset: 30,
      expansionStack: [{ macroName: "outer" }, { macroName: "form" }],
    });
    expect(index.classifyGenerated(0)).toBe("copied");
    expect(index.classifyGenerated(8)).toBe("gap");
    expect(index.expansionStackAtGenerated(14)).toHaveLength(2);
    expect(index.innermostInvocationAtGenerated(14)?.macroName).toBe("form");
    expect(index.innermostInvocationAtGenerated(8)).toBeUndefined();
    expect(index.regions("copied")).toHaveLength(2);
    expect(index.generatedToOriginal(19)[0]?.kind).toBe("grouping");
    expect(index.classifyGenerated(20)).toBe("gap");
  });

  test("returns every source of composed regions", () => {
    const origins = new OriginStore();
    const left = origins.source(1005 as SourceId, { start: 2, end: 3 });
    const right = origins.source(1006 as SourceId, { start: 7, end: 8 });
    const composed = origins.composed([left, right]);
    const index = createOriginQueryIndex({
      file: {
        text: "xy",
        originMap: {
          schemaVersion: 1,
          entries: [
            {
              generatedStart: 0,
              generatedEnd: 2,
              origin: composed,
              kind: "composed",
            },
          ],
        },
        trace: [],
        tokenSpans: [],
        serializedTrace: "[]\n",
      },
      origins,
    });
    expect(index.generatedToOriginal(0)[0]?.sources).toMatchObject([
      { sourceId: 1005 },
      { sourceId: 1006 },
    ]);
    expect(index.originalToGenerated(1006 as SourceId, 7)[0]).toMatchObject({
      kind: "composed",
      projectedGeneratedOffset: 0,
    });
  });

  test("indexes sparse, overlapping, repeated, and zero-width source intervals", () => {
    const origins = new OriginStore();
    const wide = origins.source(1007 as SourceId, { start: 0, end: 100 });
    const narrow = origins.source(1007 as SourceId, { start: 40, end: 60 });
    const point = origins.source(1007 as SourceId, { start: 50, end: 50 });
    const file: PrintedExpandedFile = {
      text: "abcde",
      originMap: {
        schemaVersion: 1,
        entries: [
          { generatedStart: 0, generatedEnd: 1, origin: wide, kind: "source" },
          {
            generatedStart: 1,
            generatedEnd: 2,
            origin: narrow,
            kind: "source",
          },
          { generatedStart: 2, generatedEnd: 3, origin: point, kind: "source" },
          {
            generatedStart: 3,
            generatedEnd: 4,
            origin: narrow,
            kind: "source",
          },
        ],
      },
      trace: [],
      tokenSpans: [],
      serializedTrace: "[]\n",
    };
    const index = createOriginQueryIndex({ file, origins });
    expect(
      index
        .originalToGenerated(1007 as SourceId, 50)
        .map(({ generatedStart }) => generatedStart),
    ).toEqual([0, 1, 2, 3]);
    expect(
      index
        .originalToGenerated(1007 as SourceId, 99)
        .map(({ generatedStart }) => generatedStart),
    ).toEqual([0]);
    expect(index.originalToGenerated(1007 as SourceId, 100)).toEqual([]);
  });

  test("does not report a token's own layout as a second occurrence", () => {
    const origins = new OriginStore();
    const value = origins.source(1008 as SourceId, { start: 10, end: 15 });
    const copied = origins.copied(1 as CaptureId, value);
    const held = origins.source(1008 as SourceId, { start: 4, end: 9 });
    const invocation = origins.source(1008 as SourceId, { start: 0, end: 4 });
    const definition = origins.source(1009 as SourceId, { start: 3, end: 4 });
    const introduced = origins.introduced(definition, invocation);
    // What the printer writes for `[$value, $value]`: the comma it introduced,
    // the space the template wrote before the second placeholder, and the two
    // copies of the captured token. The space is the copy's own trivia, so it
    // carries the copy's origin.
    const index = createOriginQueryIndex({
      file: {
        text: "value[value, value]",
        originMap: {
          schemaVersion: 1,
          entries: [
            {
              generatedStart: 0,
              generatedEnd: 5,
              origin: held,
              kind: "source",
            },
            {
              generatedStart: 5,
              generatedEnd: 6,
              origin: introduced,
              kind: "introduced",
            },
            {
              generatedStart: 6,
              generatedEnd: 11,
              origin: copied,
              kind: "copied",
            },
            {
              generatedStart: 11,
              generatedEnd: 12,
              origin: introduced,
              kind: "introduced",
            },
            {
              generatedStart: 12,
              generatedEnd: 13,
              origin: copied,
              kind: "synthesized",
            },
            {
              generatedStart: 13,
              generatedEnd: 18,
              origin: copied,
              kind: "copied",
            },
            {
              generatedStart: 18,
              generatedEnd: 19,
              origin: introduced,
              kind: "introduced",
            },
          ],
        },
        trace: [],
        tokenSpans: [],
        serializedTrace: "[]\n",
      },
      origins,
    });
    // Two copies of the name reached the output, and the space beside the
    // second is not a third. A caller that asked TypeScript what binding lived
    // at each answer would otherwise have had to ask about a space.
    expect(
      index
        .originalToGenerated(1008 as SourceId, 11)
        .map(({ generatedStart, kind }) => `${String(generatedStart)}:${kind}`),
    ).toEqual(["6:copied", "13:copied"]);
    // Layout for a source origin that no text here belongs to still stands:
    // it is all that offset has.
    expect(
      index
        .originalToGenerated(1009 as SourceId, 3)
        .map(({ generatedStart }) => generatedStart),
    ).toEqual([5, 11, 18]);
  });

  test("rejects unordered, out-of-bounds, and unknown origin regions", () => {
    const origins = new OriginStore();
    const known = origins.source(1004 as SourceId, { start: 0, end: 1 });
    const base = {
      text: "x",
      tokenSpans: [],
      trace: [],
      serializedTrace: "[]\n",
    };
    expect(() =>
      createOriginQueryIndex({
        file: {
          ...base,
          originMap: {
            schemaVersion: 1,
            entries: [
              {
                generatedStart: 1,
                generatedEnd: 2,
                origin: known,
                kind: "source",
              },
            ],
          },
        },
        origins,
      }),
    ).toThrow(/ordered and in bounds/u);
  });
});
