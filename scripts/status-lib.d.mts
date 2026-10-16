export interface CheckReport {
  readonly name: string;
  readonly commit?: string | undefined;
}

export interface CheckCounts {
  readonly passed?: number | undefined;
  readonly failed?: number | undefined;
  readonly failedFiles?: number | undefined;
  readonly exitCode?: number | undefined;
}

export function checkResult(report: CheckCounts): string;

export function staleReports(
  reports: readonly CheckReport[],
  head: string | undefined,
  exists?: (commit: string) => boolean,
): readonly string[];
