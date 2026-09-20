/** The shape `--reporter=json` writes, as much of it as the report uses. */
export interface VitestRawReport {
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly testResults: readonly {
    readonly assertionResults: readonly {
      readonly status: string;
      readonly fullName: string;
      readonly failureMessages: readonly string[];
    }[];
  }[];
}

export function clearRawOutput(path: string): Promise<void>;

export function readRawOutput(path: string): Promise<VitestRawReport>;
