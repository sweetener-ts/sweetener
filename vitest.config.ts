import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "playground/src/**/*.test.ts"],
    // Every temporary directory a test makes goes under one directory that the
    // run removes; see the script for why leaving them behind is not harmless.
    globalSetup: ["./scripts/test-temp-directory.mjs"],
    reporters: ["default"],
    // Acceptance tests construct, check, and execute whole TypeScript programs.
    // Vitest's five-second default is close enough to their real cost that
    // parallel workers push some of them over it, which reads as an unrelated
    // failure rather than as contention.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
