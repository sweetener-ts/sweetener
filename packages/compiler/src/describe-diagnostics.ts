import * as ts from "typescript";

/**
 * A macro failure with the place it happened, the way the command line reports
 * it.
 *
 * Every adapter reports through this one. The message alone is not enough: a
 * build that fails with `Malformed compile-time syntax import: expected named
 * bindings, module string, ...` and nothing to say which file, let alone which
 * line, gets wrapped by the host in its own stack trace through its plugin
 * machinery, so what reaches the terminal names a dozen frames inside the
 * bundler and no position in the source.
 */
export function describeDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
): string {
  return diagnostics.map(describeDiagnostic).join("\n");
}

function describeDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  // A warning printed beside an error, on the same stream, has to say which it
  // is; a host that reports one and then carries on otherwise reads as a host
  // that ignored an error. Errors keep the spelling they have always had.
  const severity =
    diagnostic.category === ts.DiagnosticCategory.Warning ? "warning " : "";
  const code =
    diagnostic.code === undefined ? "" : `TS${String(diagnostic.code)}: `;
  const head = `${severity}${code}${message}`;
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
