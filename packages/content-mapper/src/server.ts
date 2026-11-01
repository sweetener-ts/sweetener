#!/usr/bin/env node
import { serve } from "./json-rpc.js";
import { SweetenerContentMapper } from "./mapper.js";

// stdout carries the protocol and nothing else: one stray line of logging
// would be read as the start of a message and desynchronize every reply after
// it. Whatever the compiler or a dependency prints goes to stderr, where
// TypeScript leaves it for whoever is debugging.
for (const method of ["log", "info", "debug"] as const)
  console[method] = (...values: unknown[]) => console.error(...values);

serve(new SweetenerContentMapper().handlers(), process.stdin, process.stdout)
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
