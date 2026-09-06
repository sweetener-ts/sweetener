import { OriginStore } from "@sweetener/syntax";
import { describe, expect, test } from "vitest";
import type { OriginId, SourceId } from "@sweetener/shared";
import { parseCliInvocation, runCli } from "../src/index.js";

describe("sweet-ts command line", () => {
  test("parses project and debug options", () => {
    expect(
      parseCliInvocation(["check", "-p", "project.json", "--debug"]),
    ).toEqual({
      command: "check",
      configPath: "project.json",
      debug: true,
    });
    expect(parseCliInvocation(["expand", "file.sts"])).toEqual({
      command: "expand",
      fileName: "file.sts",
    });
    expect(parseCliInvocation(["explain", "file.sts:2:3"])).toEqual({
      command: "explain",
      position: "file.sts:2:3",
    });
    expect(() => parseCliInvocation(["expand"])).toThrow(/requires one/u);
    expect(() => parseCliInvocation(["build", "-p"])).toThrow(
      /requires a path/u,
    );
  });

  test("reports usage failures without invoking expansion", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = runCli({
      argv: ["unknown"],
      expansionProvider: { expandProject: () => [] },
      io: {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain(
      "Expected init, check, build, watch, expand, explain, or emit",
    );
  });

  test("prints exact expansions and JSON explanations", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const region = {
      generatedStart: 0,
      generatedEnd: 5,
      origin: 1 as OriginId,
      kind: "source" as const,
      primary: {
        id: 1 as OriginId,
        kind: "source" as const,
        sourceId: 20 as SourceId,
        span: { start: 0, end: 5 },
      },
      sources: [],
      expansionStack: [],
      queriedSourceId: 20 as SourceId,
      queriedOriginalOffset: 1,
      projectedGeneratedOffset: 1,
    };
    const inspectionProvider = {
      inspectSource: () => ({
        origins: new OriginStore(),
        diagnostics: [],
        sourceId: 20 as SourceId,
        sourceText: "value",
        generated: {
          text: "value",
          originMap: { schemaVersion: 1 as const, entries: [] },
          tokenSpans: [],
          trace: [],
          serializedTrace: "[]\n",
        },
        index: {
          originalToGenerated: () => [region],
          generatedToOriginal: () => [],
          classifyGenerated: () => "gap" as const,
          expansionStackAtGenerated: () => [],
          innermostInvocationAtGenerated: () => undefined,
          regions: () => [],
        },
        trace: [],
      }),
    };
    const common = {
      expansionProvider: { expandProject: () => [] },
      inspectionProvider,
      io: {
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
      },
    };
    expect(runCli({ ...common, argv: ["expand", "file.sts"] }).exitCode).toBe(
      0,
    );
    expect(stdout.pop()).toBe("value");
    // `--json` is the raw origin records, for a tool.
    expect(
      runCli({ ...common, argv: ["explain", "--json", "file.sts:1:2"] })
        .exitCode,
    ).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({ offset: 1 });
    // Without it, `explain` answers in the terms the question was asked in:
    // a file and a line, not an interned id and a byte offset.
    expect(
      runCli({ ...common, argv: ["explain", "file.sts:1:2"] }).exitCode,
    ).toBe(0);
    const described = stdout.pop()!;
    expect(described).toContain("file.sts:1:2");
    expect(described).toContain("Copied through expansion untouched.");
    expect(described).not.toContain("queriedSourceId");
    expect(stderr).toEqual([]);
  });

  test("executes expand and explain inspection commands", () => {
    const stdout: string[] = [];
    const inspectionProvider = {
      inspectSource: () => ({
        origins: new OriginStore(),
        diagnostics: [],
        sourceId: 1 as never,
        sourceText: "form",
        generated: {
          text: "expanded",
          originMap: { schemaVersion: 1 as const, entries: [] },
          tokenSpans: [],
          trace: [],
          serializedTrace: "[]\n",
        },
        index: {
          generatedToOriginal: () => [],
          originalToGenerated: () => [],
          classifyGenerated: () => "gap" as const,
          expansionStackAtGenerated: () => [],
          innermostInvocationAtGenerated: () => undefined,
          regions: () => [],
        },
        trace: [],
      }),
    };
    const base = {
      expansionProvider: { expandProject: () => [] },
      inspectionProvider,
      io: { stdout: (text: string) => stdout.push(text), stderr: () => {} },
    };
    expect(runCli({ ...base, argv: ["expand", "file.sts"] }).exitCode).toBe(0);
    expect(stdout.at(-1)).toBe("expanded");
    expect(
      runCli({ ...base, argv: ["explain", "--json", "file.sts:1:1"] }).exitCode,
    ).toBe(0);
    expect(stdout.at(-1)).toContain('"invocations"');
  });
});

/**
 * `init` writes `sweetener.json`, so every command has to be able to read it.
 *
 * `expand` and `explain` rejected `-p` outright and only ever discovered a
 * `tsconfig.json`, which left two of the six commands unable to read the
 * config the scaffolder had just written.
 */
test("expand and explain accept a project path", () => {
  expect(
    parseCliInvocation(["expand", "-p", "sweetener.json", "a.sts"]),
  ).toEqual({
    command: "expand",
    fileName: "a.sts",
    configPath: "sweetener.json",
  });
  expect(
    parseCliInvocation(["explain", "--project", "sweetener.json", "a.sts:1:1"]),
  ).toEqual({
    command: "explain",
    position: "a.sts:1:1",
    configPath: "sweetener.json",
  });
});

test("asks for help rather than reporting an unknown command", () => {
  for (const argv of [[], ["--help"], ["-h"], ["help"]])
    expect(parseCliInvocation(argv)).toEqual({ command: "help" });
});
