import type {
  OriginQueryIndex,
  OriginalOriginQueryResult,
  PrintedExpandedFile,
} from "@sweetener/printer";
import type * as ts from "typescript";
import type { SourceId } from "@sweetener/shared";
import type { OriginStore } from "@sweetener/syntax";
import type { RawSourceMap } from "@sweetener/typescript-host";

export interface SourcePositionQuery {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
}

/**
 * A macro a file can name, with the span of its definition and of each
 * compile-time import of that binding in this file.
 */
export interface InspectedMacro {
  readonly binding: number;
  readonly name: string;
  readonly category: string;
  readonly definitionSourceId: SourceId;
  readonly definitionStart: number;
  readonly definitionEnd: number;
  readonly imports: readonly { readonly start: number; readonly end: number }[];
}

export interface SourceExpansionInspection {
  readonly sourceId: SourceId;
  readonly sourceText: string;
  readonly generated: PrintedExpandedFile;
  readonly sourceMap?: RawSourceMap | undefined;
  readonly index: OriginQueryIndex;
  /**
   * What went wrong expanding this file, if anything.
   *
   * Without these an inspection could not tell a caller that what it holds is
   * the unexpanded source, so `expand` printed it and reported success.
   */
  readonly diagnostics: readonly ts.Diagnostic[];
  /**
   * What expansion holds about a name this file left standing.
   *
   * Everywhere a project is checked these go to TypeScript, which resolves
   * names and decides whether each one is true. An inspection is read by the
   * paths that never check anything -- `expand`, `explain`, a build tool's
   * transform -- so there they are all anyone will ever hear about the name,
   * and they are warnings: the one claim they carry that expansion cannot
   * make is that nothing else defines it.
   */
  readonly warnings?: readonly ts.Diagnostic[] | undefined;
  /**
   * Origins behind the expansion. A language service maps an editor's position
   * through these, so an inspection that withholds them cannot drive one.
   */
  readonly origins: OriginStore;
  readonly trace: unknown;
  readonly generatedNames?: Readonly<Record<string, string>> | undefined;
  /**
   * Macros this file defines or imports. Absent on inspections built by tests
   * that never ask where a macro name came from.
   */
  readonly macros?: readonly InspectedMacro[] | undefined;
}

export interface ExpansionInspectionProvider {
  inspectSource(fileName: string): SourceExpansionInspection | undefined;
}

export interface InvocationExplanation {
  readonly invocationId: number;
  readonly parent: number | undefined;
  readonly macroBinding: unknown;
  readonly category: unknown;
  readonly phase: unknown;
  readonly attemptedRules: unknown;
  readonly selectedRule: unknown;
  readonly captures: unknown;
  readonly bindingsIntroduced: unknown;
  readonly bindingResolutions: unknown;
  readonly hygieneOperations: unknown;
  readonly generatedNames: Readonly<Record<string, string>>;
  readonly cache: unknown;
  readonly coreInterception: unknown;
}

export interface PositionExplanation {
  readonly sourceId: SourceId;
  readonly offset: number;
  readonly regions: readonly OriginalOriginQueryResult[];
  readonly invocations: readonly InvocationExplanation[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSourcePosition(value: string): SourcePositionQuery {
  const match = /^(.*):(\d+):(\d+)$/u.exec(value);
  if (match === null || match[1]!.length === 0)
    throw new TypeError("Position must use file:line:column");
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !Number.isSafeInteger(column) ||
    column < 1
  )
    throw new RangeError(
      "Position line and column are one-based positive integers",
    );
  return Object.freeze({ fileName: match[1]!, line, column });
}

export function sourceOffset(
  source: string,
  line: number,
  column: number,
): number {
  if (
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !Number.isSafeInteger(column) ||
    column < 1
  )
    throw new RangeError("Source position is outside the file");
  let currentLine = 1;
  let lineStart = 0;
  while (currentLine < line) {
    const newline = source.indexOf("\n", lineStart);
    if (newline < 0)
      throw new RangeError("Source position is outside the file");
    lineStart = newline + 1;
    currentLine += 1;
  }
  const newline = source.indexOf("\n", lineStart);
  let lineEnd = newline < 0 ? source.length : newline;
  if (lineEnd > lineStart && source[lineEnd - 1] === "\r") lineEnd -= 1;
  const offset = lineStart + column - 1;
  if (offset > lineEnd)
    throw new RangeError("Source position is outside the file");
  return offset;
}

export function expansionView(file: PrintedExpandedFile): string {
  return file.text;
}

export function explainOriginalPosition(options: {
  readonly sourceId: SourceId;
  readonly offset: number;
  readonly index: OriginQueryIndex;
  readonly trace: unknown;
  readonly generatedNames?: Readonly<Record<string, string>> | undefined;
}): PositionExplanation {
  const regions = options.index.originalToGenerated(
    options.sourceId,
    options.offset,
  );
  const wantedOrder = regions.flatMap(({ expansionStack }) =>
    expansionStack.map(({ invocationId }) => Number(invocationId)),
  );
  const wanted = new Set(wantedOrder);
  if (wanted.size === 0)
    return Object.freeze({
      sourceId: options.sourceId,
      offset: options.offset,
      regions,
      invocations: Object.freeze([]),
    });
  const events = Array.isArray(options.trace) ? options.trace : [];
  const invocations = events.flatMap((event) => {
    if (!record(event) || typeof event["invocationId"] !== "number") return [];
    const invocationId = event["invocationId"];
    if (wanted.size > 0 && !wanted.has(invocationId)) return [];
    return [
      Object.freeze({
        invocationId,
        parent:
          typeof event["parent"] === "number" ? event["parent"] : undefined,
        category: event["category"],
        phase: event["phase"],
        macroBinding: event["binding"],
        attemptedRules: event["attemptedRules"] ?? [],
        selectedRule: event["selectedRule"],
        captures: event["captures"] ?? [],
        bindingsIntroduced: event["bindingsIntroduced"] ?? [],
        bindingResolutions: event["bindingResolutions"] ?? [],
        hygieneOperations: event["operations"] ?? [],
        generatedNames: Object.freeze({ ...(options.generatedNames ?? {}) }),
        cache: event["cache"],
        coreInterception: event["coreInterception"],
      }),
    ];
  });
  invocations.sort(
    (left, right) =>
      wantedOrder.indexOf(left.invocationId) -
      wantedOrder.indexOf(right.invocationId),
  );
  return Object.freeze({
    sourceId: options.sourceId,
    offset: options.offset,
    regions,
    invocations: Object.freeze(invocations),
  });
}
