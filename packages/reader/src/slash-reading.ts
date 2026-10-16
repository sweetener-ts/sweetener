import {
  createSpan,
  type SlashReading,
  type SlashReadings,
  type Span,
} from "@sweetener/syntax";
import * as ts from "typescript";
import { scannerTokens } from "./scanner/scan.js";
import type { ScannerToken } from "./scanner/types.js";
import {
  scanWithSupportedTypeScript,
  type ScannerLanguageVariant,
} from "./typescript-version/adapter.js";

/**
 * The tokens the text of a regular expression literal reads as where its
 * first slash is a division, ending with the end of the text; undefined where
 * it does not read as tokens at all.
 *
 * A literal read where the grammar takes an operator is split into these:
 * `/ 2 /g` after a name spelled `of` is the name divided by two, and then by
 * `g`. Each token keeps the trivia written in front of it inside the text.
 */
export function divisionTokens(
  text: string,
): readonly ScannerToken[] | undefined {
  const scanned = scanWithSupportedTypeScript(
    text,
    "standard",
    undefined,
    new Map([[0, "division"]]),
  );
  return scanned.errors.length === 0 ? scannerTokens(scanned) : undefined;
}

/** How TypeScript's parser reads the slashes of a source; see below. */
export interface TypeScriptSlashes {
  /**
   * How TypeScript's parser reads the slashes the reader reads the other way,
   * in the statements it parsed without error.
   */
  readonly readings: SlashReadings;
  /**
   * Where TypeScript did not parse the source without error: each line it
   * reported an error on, and each statement or class member holding one. A
   * Sweetener source is not TypeScript where it writes a macro's own syntax,
   * and there the parser reads what it recovers to, so how it read a slash in
   * one of these is no answer. An error is reported where the parser gave up,
   * which is often the start of what it read next rather than inside what it
   * misread, so the line is counted as well as the statement.
   */
  readonly unparsed: readonly Span[];
}

/**
 * How TypeScript's own parser reads each slash of `source`, for a reader that
 * has no enforester to ask: the formatter.
 *
 * The parser rescans a slash as a regular expression where it expects an
 * operand and leaves it a division where it expects an operator, so the
 * literals and the division operators in the tree it builds are where it read
 * each. Only where it parsed the statement holding the slash is that the
 * grammar's answer; elsewhere the reader's own judgement stands. The answer
 * costs a parse of the whole source.
 */
export function typescriptSlashes(
  source: string,
  variant: ScannerLanguageVariant,
): TypeScriptSlashes {
  const fileName = variant === "jsx" ? "source.tsx" : "source.ts";
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    variant === "jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parsed = new Map<number, SlashReading>();
  const errors = syntacticErrorPositions(file);
  const unparsed: Span[] = errors.map((at) => {
    const { line } = file.getLineAndCharacterOfPosition(at);
    const lines = file.getLineStarts();
    return createSpan(lines[line]!, lines[line + 1] ?? source.length);
  });
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral)
      parsed.set(node.getStart(file), "regular-expression");
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.SlashToken ||
        node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken)
    )
      parsed.set(node.operatorToken.getStart(file), "division");
    ts.forEachChild(node, visit);
    if (
      (ts.isStatement(node) || ts.isClassElement(node)) &&
      errors.some((at) => at >= node.getStart(file) && at < node.end)
    )
      unparsed.push(createSpan(node.getStart(file), node.end));
  };
  visit(file);
  const certain = (offset: number) =>
    !unparsed.some(({ start, end }) => offset >= start && offset < end);
  // Read again until the read agrees with the parser where it parsed. Each
  // time round settles at least one more slash, and a reading taken never
  // changes, so this ends; it is usually once.
  let readings = new Map<number, SlashReading>();
  for (;;) {
    let changed = false;
    for (const token of scanWithSupportedTypeScript(
      source,
      variant,
      undefined,
      readings,
    ).tokens) {
      const reading = parsed.get(token.start);
      if (reading === undefined || !certain(token.start)) continue;
      const read =
        token.projectKind === "regular-expression-literal"
          ? "regular-expression"
          : token.raw === "/" || token.raw === "/="
            ? "division"
            : undefined;
      if (read === undefined || read === reading || readings.has(token.start))
        continue;
      readings = new Map([...readings, [token.start, reading]]);
      changed = true;
    }
    if (!changed) return Object.freeze({ readings, unparsed });
  }
}

/** Where TypeScript's parser reported an error in `file`. */
function syntacticErrorPositions(file: ts.SourceFile): readonly number[] {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === file.fileName ? file : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === file.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [file.fileName],
    options: { noLib: true, noResolve: true, types: [] },
    host,
  });
  return program
    .getSyntacticDiagnostics(file)
    .flatMap(({ start }) => (start === undefined ? [] : [start]));
}
