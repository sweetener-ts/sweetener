import type { Readable, Writable } from "node:stream";

/** JSON-RPC 2.0 error codes the protocol uses. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** A failure that is the request's fault, reported with its own code. */
export class ResponseError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ResponseError";
    this.code = code;
  }
}

export type RequestHandler = (params: unknown) => unknown;

type MessageId = number | string;

const headerSeparator = Buffer.from("\r\n\r\n", "ascii");

/**
 * Reads LSP-framed messages from a byte stream.
 *
 * Each message is a header block of `Name: value` lines, a blank line, and
 * exactly `Content-Length` bytes of UTF-8 JSON. A chunk from the stream may
 * end anywhere, mid-header or mid-body, so bytes wait here until a whole
 * message has arrived.
 */
export class MessageReader {
  #buffered: Buffer = Buffer.alloc(0);

  /**
   * Each complete message body the bytes so far contain, in order, as it is
   * reached: a header that cannot be read throws only once the messages in
   * front of it have been handed over, which were sent correctly and are owed
   * their replies.
   */
  *messages(chunk: Buffer): Generator<string, void, void> {
    this.#buffered =
      this.#buffered.length === 0
        ? chunk
        : Buffer.concat([this.#buffered, chunk]);
    for (;;) {
      const headerEnd = this.#buffered.indexOf(headerSeparator);
      if (headerEnd === -1) return;
      const length = contentLength(
        this.#buffered.subarray(0, headerEnd).toString("ascii"),
      );
      const bodyStart = headerEnd + headerSeparator.length;
      if (this.#buffered.length < bodyStart + length) return;
      const body = this.#buffered
        .subarray(bodyStart, bodyStart + length)
        .toString("utf8");
      this.#buffered = this.#buffered.subarray(bodyStart + length);
      yield body;
    }
  }

  /** Whether bytes of an unfinished message are still waiting. */
  get pending(): boolean {
    return this.#buffered.length > 0;
  }
}

function contentLength(header: string): number {
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1)
      throw new Error(`Malformed JSON-RPC header line ${JSON.stringify(line)}`);
    if (line.slice(0, separator).trim().toLowerCase() !== "content-length")
      continue;
    const value = line.slice(separator + 1).trim();
    if (!/^\d+$/u.test(value))
      throw new Error(`Malformed Content-Length ${JSON.stringify(value)}`);
    return Number(value);
  }
  throw new Error("JSON-RPC message has no Content-Length header");
}

export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Answers one decoded message, or returns nothing for a notification.
 *
 * Every handler here is synchronous: expanding a file reads from disk and runs
 * the compiler without awaiting anything. Answering each request before
 * reading the next keeps the replies in the order TypeScript asked, and leaves
 * nothing for a `$/cancelRequest` to cancel, so notifications are dropped.
 */
export function dispatch(
  handlers: ReadonlyMap<string, RequestHandler>,
  body: string,
): unknown {
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch (error) {
    return failure(null, ErrorCode.ParseError, describeError(error));
  }
  if (!isObject(message) || message["jsonrpc"] !== "2.0")
    return failure(
      null,
      ErrorCode.InvalidRequest,
      "Not a JSON-RPC 2.0 message",
    );
  const id = message["id"];
  if (id === undefined) return undefined;
  if (typeof id !== "number" && typeof id !== "string")
    return failure(null, ErrorCode.InvalidRequest, "Request id is malformed");
  const method = message["method"];
  if (typeof method !== "string")
    return failure(id, ErrorCode.InvalidRequest, "Request has no method");
  const handler = handlers.get(method);
  if (handler === undefined)
    return failure(id, ErrorCode.MethodNotFound, `Unknown method ${method}`);
  try {
    return { jsonrpc: "2.0", id, result: handler(message["params"]) ?? null };
  } catch (error) {
    return error instanceof ResponseError
      ? failure(id, error.code, error.message)
      : failure(id, ErrorCode.InternalError, describeError(error));
  }
}

function failure(id: MessageId | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** What was thrown, with where it was thrown from if it says. */
export function describeError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

/**
 * Serve requests from `input` until it ends.
 *
 * TypeScript owns the process: closing the pipe is how it says it is done, so
 * the returned promise settles then. A stream that ends inside a message, or
 * a header that cannot be read, rejects it: past that point no byte can be
 * trusted to start a message.
 */
export function serve(
  handlers: ReadonlyMap<string, RequestHandler>,
  input: Readable,
  output: Writable,
): Promise<void> {
  const reader = new MessageReader();
  return new Promise((resolvePromise, reject) => {
    input.on("data", (chunk: Buffer) => {
      try {
        for (const body of reader.messages(chunk)) {
          const response = dispatch(handlers, body);
          if (response !== undefined) output.write(frame(response));
        }
      } catch (error) {
        input.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    input.on("error", reject);
    input.on("end", () => {
      if (reader.pending)
        reject(new Error("JSON-RPC input ended inside a message"));
      else resolvePromise();
    });
  });
}
