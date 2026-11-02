import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
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
        ...reader.messages(bytes.subarray(0, cut)),
        ...reader.messages(bytes.subarray(cut)),
      ];
      expect(bodies.map((body) => JSON.parse(body))).toEqual([message]);
      expect(reader.pending).toBe(false);
    }
  });

  test("a long message is joined once it has all come, not at every chunk", () => {
    const message = frame({ text: "x".repeat(100_000) });
    const reader = new MessageReader();
    const header = message.indexOf("\r\n\r\n") + 4;
    expect([...reader.messages(message.subarray(0, header))]).toEqual([]);
    const joins = vi.spyOn(Buffer, "concat");
    const bodies: string[] = [];
    for (let at = header; at < message.length; at += 1024)
      bodies.push(...reader.messages(message.subarray(at, at + 1024)));
    expect(joins).toHaveBeenCalledOnce();
    joins.mockRestore();
    expect(bodies).toHaveLength(1);
    expect(reader.pending).toBe(false);
  });

  test("several messages in one chunk come out in order", () => {
    const reader = new MessageReader();
    const bodies = [
      ...reader.messages(
        Buffer.concat([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 })]),
      ),
    ];
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
    expect(() => [
      ...new MessageReader().messages(Buffer.from("Content-Type: x\r\n\r\n{}")),
    ]).toThrow(/no Content-Length/u);
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
    const bodies = [...new MessageReader().messages(Buffer.concat(written))];
    expect(bodies.map((body) => JSON.parse(body).result)).toEqual(["a", "b"]);
  });

  test("answers what came before a header it cannot read, then rejects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: Buffer[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk));
    const served = serve(
      new Map([["echo", (params) => params]]),
      input,
      output,
    );
    input.write(
      Buffer.concat([
        frame({ jsonrpc: "2.0", id: 1, method: "echo", params: "a" }),
        Buffer.from("Content-Length: nope\r\n\r\n", "ascii"),
      ]),
    );
    await expect(served).rejects.toThrow(/Malformed Content-Length/u);
    const bodies = [...new MessageReader().messages(Buffer.concat(written))];
    expect(bodies.map((body) => JSON.parse(body).result)).toEqual(["a"]);
  });

  test("the server's last reply arrives whole after its input ends", async () => {
    const server = spawn(
      process.execPath,
      [fileURLToPath(new URL("../dist/src/server.js", import.meta.url))],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const received: Buffer[] = [];
    server.stdout.on("data", (chunk: Buffer) => received.push(chunk));
    // Far more than a pipe holds at once, so the reply is still being written
    // when the input has ended.
    const method = "x".repeat(4_000_000);
    server.stdin.end(frame({ jsonrpc: "2.0", id: 1, method }));
    const status = await new Promise((resolveExit) =>
      server.once("close", resolveExit),
    );
    expect(status).toBe(0);
    const bodies = [...new MessageReader().messages(Buffer.concat(received))];
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).error.message).toContain(method);
  });

  test("stray writes to stdout do not reach the protocol", async () => {
    // Whatever writes them, once the server is reading its first message.
    const stray = `const parse = JSON.parse;
JSON.parse = (...args) => {
  JSON.parse = parse;
  console.log("stray log");
  console.dir("stray dir");
  process.stdout.write("stray write\\n");
  return parse(...args);
};`;
    const server = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(stray)}`,
        fileURLToPath(new URL("../dist/src/server.js", import.meta.url)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const received: Buffer[] = [];
    let logged = "";
    server.stdout.on("data", (chunk: Buffer) => received.push(chunk));
    server.stderr.on("data", (chunk: Buffer) => (logged += chunk.toString()));
    server.stdin.end(frame({ jsonrpc: "2.0", id: 1, method: "unknown" }));
    const status = await new Promise((resolveExit) =>
      server.once("close", resolveExit),
    );
    expect(status).toBe(0);
    const bodies = [...new MessageReader().messages(Buffer.concat(received))];
    expect(bodies.map((body) => JSON.parse(body).id)).toEqual([1]);
    expect(logged).toContain("stray log");
    expect(logged).toContain("stray dir");
    expect(logged).toContain("stray write");
  });

  test("what a dependency prints as it loads does not reach the protocol", async () => {
    const hooks = `import { registerHooks } from "node:module";
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    return url.endsWith("/mapper.js")
      ? { ...loaded, source: 'console.log("printed loading");\\n' + loaded.source }
      : loaded;
  },
});`;
    const server = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(hooks)}`,
        fileURLToPath(new URL("../dist/src/server.js", import.meta.url)),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const received: Buffer[] = [];
    let logged = "";
    server.stdout.on("data", (chunk: Buffer) => received.push(chunk));
    server.stderr.on("data", (chunk: Buffer) => (logged += chunk.toString()));
    server.stdin.end(frame({ jsonrpc: "2.0", id: 1, method: "unknown" }));
    await new Promise((resolveExit) => server.once("close", resolveExit));
    expect(logged).toContain("printed loading");
    const bodies = [...new MessageReader().messages(Buffer.concat(received))];
    expect(bodies.map((body) => JSON.parse(body).id)).toEqual([1]);
  });

  test("an output that fails rejects, and is not left to crash the process", async () => {
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error("EPIPE"));
      },
    });
    const served = serve(new Map(), input, output);
    input.write(frame({ jsonrpc: "2.0", id: 1, method: "unknown" }));
    await expect(served).rejects.toThrow("EPIPE");
  });

  test("an input that ends inside a message rejects", async () => {
    const input = new PassThrough();
    const served = serve(new Map(), input, new PassThrough());
    input.end(frame({ jsonrpc: "2.0", id: 1, method: "x" }).subarray(0, 25));
    await expect(served).rejects.toThrow(/inside a message/u);
  });
});
