import * as ts from "typescript";

/**
 * A macro failure with the place it happened, the way the command line reports
 * it.
 *
 * Every adapter had its own version of this, and all but one of them printed
 * the message alone: a build failed with `Malformed compile-time syntax
 * import: expected named bindings, module string, ...` and nothing to say
 * which file, let alone which line. The host then wrapped that in its own
 * stack trace through its plugin machinery, so what reached the terminal named
 * a dozen frames inside the bundler and no position in the source.
 */
export function describeDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
): string {
  return diagnostics.map(describeDiagnostic).join("\n");
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const code =
    diagnostic.code === undefined ? "" : `TS${String(diagnostic.code)}: `;
  const head = `${code}${message}`;
  const at = position(diagnostic.file, diagnostic.start);
  const lines = [at === undefined ? head : `${at} ${head}`];
  // The other place a diagnostic points — the rule that wanted different
  // syntax, the binding already holding a name — is most of the answer.
  for (const related of diagnostic.relatedInformation ?? []) {
    const text = ts.flattenDiagnosticMessageText(related.messageText, "\n");
    const relatedAt = position(related.file, related.start);
    lines.push(
      relatedAt === undefined ? `  ${text}` : `  ${relatedAt} ${text}`,
    );
  }
  return lines.join("\n");
}

function position(
  file: ts.SourceFile | undefined,
  start: number | undefined,
): string | undefined {
  if (file === undefined || start === undefined) return undefined;
  const at = file.getLineAndCharacterOfPosition(start);
  return `${file.fileName}:${String(at.line + 1)}:${String(at.character + 1)}`;
}
