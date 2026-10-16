import type { CaptureId, InvocationId, SourceId } from "@sweetener/shared";
import { OriginStore } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import * as ts from "typescript";
import { remapGeneratedSpan, remapTypeScriptDiagnostic } from "../src/index.js";

describe("TypeScript diagnostic remapping", () => {
  test("maps introduced syntax to its invocation and relates its definition", () => {
    const origins = new OriginStore();
    const definition = origins.source(980 as SourceId, { start: 10, end: 20 });
    const invocation = origins.source(981 as SourceId, { start: 30, end: 40 });
    const introduced = origins.introduced(definition, invocation);
    const result = remapTypeScriptDiagnostic({
      diagnostic: {
        category: ts.DiagnosticCategory.Error,
        code: 2322,
        file: undefined,
        start: 2,
        length: 4,
        messageText: "Type mismatch",
      },
      generated: {
        text: "x wrong y",
        originMap: {
          schemaVersion: 1,
          entries: [
            {
              generatedStart: 0,
              generatedEnd: 9,
              origin: introduced,
              kind: "introduced",
            },
          ],
        },
        tokenSpans: [],
        trace: [],
        serializedTrace: "[]\n",
      },
      origins,
      expansionFrames: () => [
        {
          invocationId: 1 as InvocationId,
          macroName: "typed",
          origin: { sourceId: 981 as SourceId, start: 30, end: 40 },
        },
      ],
    });
    expect(result).toMatchObject({
      typescriptCode: 2322,
      messageText: "Type mismatch",
      primaryOrigin: { sourceId: 981, start: 30, end: 40 },
      expansionStack: [{ macroName: "typed" }],
    });
    expect(result.relatedOrigins).toContainEqual({
      message: "Macro template definition",
      origin: {
        sourceId: 980,
        start: 10,
        end: 20,
        originId: introduced,
      },
    });
  });

  test("preserves diagnostics without generated locations", () => {
    const result = remapTypeScriptDiagnostic({
      diagnostic: {
        category: ts.DiagnosticCategory.Warning,
        code: 9999,
        file: undefined,
        start: undefined,
        length: undefined,
        messageText: {
          messageText: "outer",
          category: 0,
          code: 9999,
          next: [],
        },
      },
      generated: undefined,
      origins: new OriginStore(),
    });
    expect(result).toMatchObject({
      typescriptCode: 9999,
      messageText: "outer",
      primaryOrigin: undefined,
      relatedOrigins: [],
    });
  });

  test("selects invocation sources for copied and synthesized regions", () => {
    const origins = new OriginStore();
    const source = origins.source(982 as SourceId, { start: 5, end: 9 });
    const copied = origins.copied(1 as CaptureId, source);
    const synthesized = origins.synthesized(source, "grouping-parentheses");
    for (const origin of [copied, synthesized]) {
      const result = remapTypeScriptDiagnostic({
        diagnostic: {
          category: ts.DiagnosticCategory.Error,
          code: 1000,
          file: undefined,
          start: 0,
          length: 1,
          messageText: "problem",
        },
        generated: {
          text: "x",
          originMap: {
            schemaVersion: 1,
            entries: [
              {
                generatedStart: 0,
                generatedEnd: 1,
                origin,
                kind: origins.get(origin)!.kind,
              },
            ],
          },
          tokenSpans: [],
          trace: [],
          serializedTrace: "[]\n",
        },
        origins,
      });
      expect(result.primaryOrigin).toMatchObject({ sourceId: 982, start: 5 });
    }
  });

  /**
   * A region that prints the text it came from maps position for position,
   * the projection the origin index answers offset queries with. A region a
   * macro's template wrote has no position of its own and stands for its
   * source as a whole: a name it introduced is reported over the whole
   * invocation, however long the name is.
   */
  test("reports written text where it was written and introduced text over its source", () => {
    const origins = new OriginStore();
    const written = origins.source(986 as SourceId, { start: 10, end: 16 });
    const definition = origins.source(987 as SourceId, { start: 3, end: 4 });
    const invocation = origins.source(986 as SourceId, { start: 20, end: 24 });
    const introduced = origins.introduced(definition, invocation);
    const generated = {
      text: "abcdef π",
      originMap: {
        schemaVersion: 1 as const,
        entries: [
          {
            generatedStart: 0,
            generatedEnd: 6,
            origin: written,
            kind: "source" as const,
          },
          {
            generatedStart: 7,
            generatedEnd: 8,
            origin: introduced,
            kind: "introduced" as const,
          },
        ],
      },
      tokenSpans: [],
      trace: [],
      serializedTrace: "[]\n",
    };
    expect(
      remapGeneratedSpan({ generated, origins, start: 2, length: 3 })
        .primaryOrigin,
    ).toMatchObject({ sourceId: 986, start: 12, end: 15 });
    expect(
      remapGeneratedSpan({ generated, origins, start: 7, length: 1 }),
    ).toMatchObject({
      primaryOrigin: { sourceId: 986, start: 20, end: 24 },
      relatedOrigins: [
        {
          message: "Macro template definition",
          origin: { sourceId: 987, start: 3, end: 4 },
        },
      ],
    });
  });

  /**
   * What the author wrote is about nothing but itself: an error over several
   * written tokens is reported over all of them, across the layout between
   * them, and related to nothing.
   */
  test("reports written text over all of it and relates it to nothing", () => {
    const origins = new OriginStore();
    const one = origins.source(988 as SourceId, { start: 2, end: 3 });
    const comma = origins.source(988 as SourceId, { start: 3, end: 4 });
    const two = origins.source(988 as SourceId, { start: 5, end: 6 });
    const generated = {
      text: "(1, 2)",
      originMap: {
        schemaVersion: 1 as const,
        entries: [
          { generatedStart: 1, generatedEnd: 2, origin: one, kind: "source" },
          { generatedStart: 2, generatedEnd: 3, origin: comma, kind: "source" },
          {
            generatedStart: 3,
            generatedEnd: 4,
            origin: two,
            kind: "synthesized",
          },
          { generatedStart: 4, generatedEnd: 5, origin: two, kind: "source" },
        ] as const,
      },
      tokenSpans: [],
      trace: [],
      serializedTrace: "[]\n",
    };
    expect(
      remapGeneratedSpan({ generated, origins, start: 1, length: 4 }),
    ).toEqual({
      primaryOrigin: { sourceId: 988, start: 2, end: 6, originId: one },
      relatedOrigins: [],
    });
  });

  test("maps composed regions to one primary source and stable related sources", () => {
    const origins = new OriginStore();
    const left = origins.source(983 as SourceId, { start: 1, end: 3 });
    const right = origins.source(984 as SourceId, { start: 8, end: 13 });
    const composed = origins.composed([left, right]);
    const result = remapTypeScriptDiagnostic({
      diagnostic: {
        category: ts.DiagnosticCategory.Error,
        code: 2345,
        file: undefined,
        start: 0,
        length: 4,
        messageText: "composed problem",
      },
      generated: {
        text: "join",
        originMap: {
          schemaVersion: 1,
          entries: [
            {
              generatedStart: 0,
              generatedEnd: 4,
              origin: composed,
              kind: "composed",
            },
          ],
        },
        tokenSpans: [],
        trace: [],
        serializedTrace: "[]\n",
      },
      origins,
    });
    expect(result.primaryOrigin).toMatchObject({
      sourceId: 983,
      start: 1,
      end: 3,
    });
    expect(result.relatedOrigins).toEqual([
      {
        message: "Additional composed source",
        origin: {
          sourceId: 984,
          start: 8,
          end: 13,
          originId: composed,
        },
      },
    ]);
  });

  test("anchors zero-width diagnostics to the token beginning at the position", () => {
    const origins = new OriginStore();
    const left = origins.source(985 as SourceId, { start: 0, end: 1 });
    const right = origins.source(985 as SourceId, { start: 2, end: 3 });
    const result = remapTypeScriptDiagnostic({
      diagnostic: {
        category: ts.DiagnosticCategory.Error,
        code: 1005,
        file: undefined,
        start: 1,
        length: 0,
        messageText: "expected token",
        relatedInformation: [
          {
            category: ts.DiagnosticCategory.Message,
            code: 1006,
            file: undefined,
            start: undefined,
            length: undefined,
            messageText: "TypeScript context",
          },
        ],
      },
      generated: {
        text: "ab",
        originMap: {
          schemaVersion: 1,
          entries: [
            {
              generatedStart: 0,
              generatedEnd: 1,
              origin: left,
              kind: "source",
            },
            {
              generatedStart: 1,
              generatedEnd: 2,
              origin: right,
              kind: "source",
            },
          ],
        },
        trace: [],
        tokenSpans: [],
        serializedTrace: "[]\n",
      },
      origins,
    });
    expect(result.primaryOrigin).toMatchObject({ start: 2, end: 2 });
    expect(result.typescriptRelatedInformation).toHaveLength(1);
  });
});
