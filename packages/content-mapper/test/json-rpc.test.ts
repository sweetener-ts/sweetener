import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  dispatch,
  ErrorCode,
  frame,
  MessageReader,
  ResponseError,
  serve,
  type RequestHandler,
} from "../src/json-rpc.js";

describe("message framing", () => {
  test("a message split anywhere, even inside a character, arrives whole", () => {
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "transform",
      params: { content: "é → 🍬" },
    };
    const bytes = frame(message);
    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const reader = new MessageReader();
      const bodies = [
        ...reader.push(bytes.subarray(0, cut)),
        ...reader.push(bytes.subarray(cut)),
      ];
      expect(bodies.map((body) => JSON.parse(body))).toEqual([message]);
      expect(reader.pending).toBe(false);
    }
  });

  test("several messages in one chunk come out in order", () => {
    const reader = new MessageReader();
    const bodies = reader.push(
      Buffer.concat([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 })]),
    );
    expect(bodies.map((body) => JSON.parse(body).id)).toEqual([1, 2, 3]);
  });

  test("Content-Length counts bytes, not characters", () => {
    const bytes = frame({ text: "🍬" });
    const header = bytes.toString("ascii", 0, bytes.indexOf("\r\n"));
    expect(header).toBe(
      `Content-Length: ${Buffer.byteLength(JSON.stringify({ text: "🍬" }))}`,
    );
  });

  test("a header without Content-Length is refused", () => {
    expect(() =>
      new MessageReader().push(Buffer.from("Content-Type: x\r\n\r\n{}")),
    ).toThrow(/no Content-Length/u);
  });
});

describe("dispatch", () => {
  const handlers = new Map<string, RequestHandler>([
    ["echo", (params) => params],
    ["nothing", () => undefined],
    [
      "refuse",
      () => {
        throw new ResponseError(ErrorCode.InvalidParams, "bad params");
      },
    ],
    [
      "crash",
      () => {
        throw new Error("boom");
      },
    ],
  ]);
  const call = (message: unknown) =>
    dispatch(handlers, JSON.stringify(message));

  test("a request is answered with its handler's result under its id", () => {
    expect(
      call({ jsonrpc: "2.0", id: 7, method: "echo", params: [1] }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: [1],
    });
  });

  test("a handler returning nothing answers null", () => {
    expect(call({ jsonrpc: "2.0", id: "a", method: "nothing" })).toEqual({
      jsonrpc: "2.0",
      id: "a",
      result: null,
    });
  });

  test("a notification is not answered", () => {
    expect(
      call({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } }),
    ).toBeUndefined();
  });

  test("failures carry their JSON-RPC codes", () => {
    expect(call({ jsonrpc: "2.0", id: 1, method: "missing" })).toMatchObject({
      error: { code: ErrorCode.MethodNotFound },
    });
    expect(call({ jsonrpc: "2.0", id: 1, method: "refuse" })).toMatchObject({
      error: { code: ErrorCode.InvalidParams, message: "bad params" },
    });
    expect(call({ jsonrpc: "2.0", id: 1, method: "crash" })).toMatchObject({
      error: {
        code: ErrorCode.InternalError,
        message: expect.stringContaining("boom"),
      },
    });
    expect(dispatch(handlers, "{not json")).toMatchObject({
      id: null,
      error: { code: ErrorCode.ParseError },
    });
    expect(call({ id: 1, method: "echo" })).toMatchObject({
      error: { code: ErrorCode.InvalidRequest },
    });
  });
});

describe("serve", () => {
  test("answers each request on the output and settles when the input ends", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const served = serve(
      new Map([["echo", (params) => params]]),
      input,
      output,
    );
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "echo", params: "a" }));
    input.end(frame({ jsonrpc: "2.0", id: 2, method: "echo", params: "b" }));
    await served;
    const bodies = new MessageReader().push(Buffer.concat(written));
    expect(bodies.map((body) => JSON.parse(body).result)).toEqual(["a", "b"]);
  });

  test("an input that ends inside a message rejects", async () => {
    const input = new PassThrough();
    const served = serve(new Map(), input, new PassThrough());
    input.end(frame({ jsonrpc: "2.0", id: 1, method: "x" }).subarray(0, 25));
    await expect(served).rejects.toThrow(/inside a message/u);
  });
});
