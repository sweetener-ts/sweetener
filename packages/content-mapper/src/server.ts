#!/usr/bin/env node
import { Writable } from "node:stream";
import { describeError, serve } from "./json-rpc.js";
import { SweetenerContentMapper } from "./mapper.js";

// stdout carries the protocol and nothing else: one stray line of logging
// would be read as the start of a message and desynchronize every reply after
// it. Whatever the compiler or a dependency prints goes to stderr, where
// TypeScript leaves it for whoever is debugging.
const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(
  process.stderr,
) as typeof process.stdout.write;
const protocol = new Writable({
  write(chunk: Buffer, encoding, done) {
    writeProtocol(chunk, encoding, done);
  },
});

// The process ends by itself once stdin has and stdout has drained. Exiting
// here could drop replies still on their way out, where a pipe is written
// asynchronously.
serve(new SweetenerContentMapper().handlers(), process.stdin, protocol).catch(
  (error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  },
);
