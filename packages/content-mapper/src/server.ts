#!/usr/bin/env node
import { protocolOutput } from "./protocol-output.js";
import { describeError, serve } from "./json-rpc.js";
import { SweetenerContentMapper } from "./mapper.js";

// The process ends by itself once stdin has and stdout has drained. Exiting
// here could drop replies still on their way out, where a pipe is written
// asynchronously.
serve(
  new SweetenerContentMapper().handlers(),
  process.stdin,
  protocolOutput,
).catch((error: unknown) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exitCode = 1;
});
