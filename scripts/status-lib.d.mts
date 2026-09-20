export interface CheckReport {
  readonly name: string;
  readonly commit?: string | undefined;
}

export function staleReports(
  reports: readonly CheckReport[],
  head: string | undefined,
  exists?: (commit: string) => boolean,
): readonly string[];
