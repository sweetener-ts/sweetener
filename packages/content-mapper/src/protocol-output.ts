import { Writable } from "node:stream";

// stdout carries the protocol and nothing else: one stray line of logging
// would be read as the start of a message and desynchronize every reply after
// it. Whatever the compiler or a dependency prints goes to stderr, where
// TypeScript leaves it for whoever is debugging. This is its own module, and
// the server's first import, for what they print as they load.
const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(
  process.stderr,
) as typeof process.stdout.write;

/** The real stdout, which is what the protocol writes to. */
export const protocolOutput = new Writable({
  write(chunk: Buffer, encoding, done) {
    writeProtocol(chunk, encoding, done);
  },
});

// TypeScript closing the pipe as it shuts down fails a write on the stream
// itself too, and with no one listening that would end the process in a stack
// trace, for what is a routine end. `serve` hears it from the writable above.
process.stdout.on("error", (error) => protocolOutput.destroy(error));
// Nothing can be said of a stderr that is gone, and what was said is not owed.
process.stderr.on("error", () => {});
