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
   *
   * A statement that uses a macro is counted too, wherever TypeScript parsed
   * it: the macro reads its own syntax by its own rules, which TypeScript may
   * parse cleanly as something else -- `unless(c) /a  +b/i.test(s)` divides
   * to TypeScript, and the macro reads a regular expression.
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
  macroUses: readonly number[] = [],
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
  // Walked with a stack of its own rather than by recursion: TypeScript nests
  // a chain of binary operators one node per operator, and a chain fifty
  // thousand long exhausted the call stack.
  const uses = [...macroUses].sort((left, right) => left - right);
  /**
   * The innermost statement of a statement list around each use of a macro.
   * TypeScript reads a line that carries an expression on -- a slash written
   * under `unless(c)` -- into the statement above it, so that statement holds
   * whatever syntax the macro could read in a way TypeScript does not.
   */
  const around: (ts.Node | undefined)[] = uses.map(() => undefined);
  const pending: ts.Node[] = [file];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      (ts.isStatement(node) || ts.isClassElement(node)) &&
      holdsStatements(node.parent)
    )
      for (
        let use = firstAtOrAfter(uses, node.getStart(file));
        use < uses.length && uses[use]! < node.end;
        use += 1
      )
        around[use] = node;
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral)
      parsed.set(node.getStart(file), "regular-expression");
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.SlashToken ||
        node.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken)
    )
      parsed.set(node.operatorToken.getStart(file), "division");
    if (
      (ts.isStatement(node) || ts.isClassElement(node)) &&
      errors.some((at) => at >= node.getStart(file) && at < node.end)
    )
      unparsed.push(createSpan(node.getStart(file), node.end));
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  for (const statement of around)
    unparsed.push(
      statement === undefined
        ? createSpan(0, source.length)
        : createSpan(statement.getStart(file), statement.end),
    );
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

/** Whether `node` holds a list of statements or of class members. */
function holdsStatements(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isSourceFile(node) ||
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseClause(node) ||
      ts.isDefaultClause(node) ||
      ts.isClassLike(node))
  );
}

/** The index of the first of the sorted `offsets` at or after `start`. */
function firstAtOrAfter(offsets: readonly number[], start: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle]! < start) low = middle + 1;
    else high = middle;
  }
  return low;
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
