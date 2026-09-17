/**
 * A floor, not an equality.
 *
 * The compatibility workflow runs Node 26 and the suite passes on it, so an
 * exact match, or a ceiling such as `>=24 <25`, would reject a runtime this
 * project supports.
 */
export const minimumNodeMajor = 24 as const;
export const supportedTypeScriptLine = "6.0" as const;

export interface CompatibilityDiagnostic {
  readonly code: "SWR7001" | "SWR7002";
  readonly message: string;
  readonly actualVersion: string;
  readonly expected: string;
}

function major(version: string): number | undefined {
  const match = /^v?(\d+)\./u.exec(version);
  return match === null ? undefined : Number(match[1]);
}

export function compatibilityDiagnostics(versions: {
  readonly node: string;
  readonly typescript: string;
}): readonly CompatibilityDiagnostic[] {
  const diagnostics: CompatibilityDiagnostic[] = [];
  const nodeMajor = major(versions.node);
  // Explicitly, because `undefined < 24` is false: a version this cannot parse
  // has to fail rather than slip through the comparison.
  if (nodeMajor === undefined || nodeMajor < minimumNodeMajor)
    diagnostics.push(
      Object.freeze({
        code: "SWR7001",
        message: `Unsupported Node.js ${versions.node}; expected >=${String(minimumNodeMajor)}`,
        actualVersion: versions.node,
        expected: `>=${String(minimumNodeMajor)}`,
      }),
    );
  if (!versions.typescript.startsWith(`${supportedTypeScriptLine}.`))
    diagnostics.push(
      Object.freeze({
        code: "SWR7002",
        message: `Unsupported TypeScript ${versions.typescript}; expected ${supportedTypeScriptLine}.x`,
        actualVersion: versions.typescript,
        expected: `${supportedTypeScriptLine}.x`,
      }),
    );
  return Object.freeze(diagnostics);
}

export function assertSupportedToolchain(versions: {
  readonly node: string;
  readonly typescript: string;
}): void {
  const diagnostics = compatibilityDiagnostics(versions);
  if (diagnostics.length > 0)
    throw new RangeError(
      diagnostics.map(({ code, message }) => `${code}: ${message}`).join("\n"),
    );
}
