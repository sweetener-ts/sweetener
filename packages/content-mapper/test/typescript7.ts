import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frame, MessageReader } from "../src/json-rpc.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The TypeScript 7.1 nightly this package is tested against. */
export const tsc = join(
  packageRoot,
  "node_modules",
  "typescript7",
  "bin",
  "tsc",
);

/**
 * A project on disk that uses this package the way a user's would: through
 * `node_modules`, named in its tsconfig's `contentMappers`.
 */
export function mappedProject(
  files: Record<string, string>,
  compilerOptions: Record<string, unknown> = {},
): {
  readonly directory: string;
  file(name: string): string;
} {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sweet-ts7-")));
  mkdirSync(join(directory, "node_modules", "@sweetener"), { recursive: true });
  symlinkSync(
    packageRoot,
    join(directory, "node_modules", "@sweetener", "content-mapper"),
    "dir",
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        ...compilerOptions,
      },
      contentMappers: [
        { package: "@sweetener/content-mapper", extensions: [".sts", ".stsx"] },
      ],
      include: ["src"],
    }),
  );
  mkdirSync(join(directory, "src"));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(directory, "src", name), text);
  return { directory, file: (name) => join(directory, "src", name) };
}

/** `tsc --runExternalCode` over the project; its report, one line per entry. */
export function check(directory: string): {
  status: number | null;
  lines: string[];
} {
  const run = spawnSync(
    process.execPath,
    [tsc, "-p", directory, "--runExternalCode", "--pretty", "false"],
    { cwd: directory, encoding: "utf8" },
  );
  if (run.error !== undefined) throw run.error;
  return {
    status: run.status,
    lines: `${run.stdout}${run.stderr}`
      .split("\n")
      .filter((line) => line !== ""),
  };
}

interface Response {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

/**
 * An editor, as far as TypeScript's language server can tell.
 *
 * It says it trusts the workspace, which is what lets the server start
 * content mappers, and answers the server's own requests with empty settings.
 */
export class LanguageServerClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, (response: Response) => void>();
  readonly #stderr: string[] = [];
  #nextId = 1;

  private constructor(directory: string) {
    this.#child = spawn(process.execPath, [tsc, "--lsp", "--stdio"], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = new MessageReader();
    this.#child.stdout!.on("data", (chunk: Buffer) => {
      for (const body of reader.messages(chunk))
        this.#receive(JSON.parse(body));
    });
    this.#child.stderr!.on("data", (chunk: Buffer) =>
      this.#stderr.push(chunk.toString()),
    );
  }

  static async start(directory: string): Promise<LanguageServerClient> {
    const client = new LanguageServerClient(directory);
    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(directory).href,
      capabilities: {
        textDocument: {
          diagnostic: {},
          hover: { contentFormat: ["plaintext"] },
        },
        workspace: { didChangeWatchedFiles: { dynamicRegistration: true } },
      },
      initializationOptions: { runExternalCode: true },
    });
    client.notify("initialized", {});
    return client;
  }

  #receive(message: Record<string, unknown>): void {
    const id = message["id"];
    if (message["method"] === undefined) {
      if (typeof id !== "number") return;
      this.#pending.get(id)?.(message as unknown as Response);
      this.#pending.delete(id);
      return;
    }
    // A request of the server's own, which may carry a string id.
    if (typeof id !== "number" && typeof id !== "string") return;
    const params = message["params"] as { items?: unknown[] } | undefined;
    this.#send({
      jsonrpc: "2.0",
      id,
      result:
        message["method"] === "workspace/configuration"
          ? (params?.items ?? []).map(() => null)
          : null,
    });
  }

  #send(message: unknown): void {
    this.#child.stdin!.write(frame(message));
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const response = await new Promise<Response>((resolveResponse) => {
      this.#pending.set(id, resolveResponse);
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
    if (response.error !== undefined)
      throw new Error(
        `${method} failed: ${response.error.message}\n${this.#stderr.join("")}`,
      );
    return response.result;
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  open(fileName: string, text: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(fileName).href,
        languageId: "typescript",
        version: 1,
        text,
      },
    });
  }

  change(fileName: string, version: number, text: string): void {
    this.notify("textDocument/didChange", {
      textDocument: { uri: pathToFileURL(fileName).href, version },
      contentChanges: [{ text }],
    });
  }

  /** Diagnostics as `line:column code message`, one-based like an editor. */
  async diagnostics(fileName: string): Promise<string[]> {
    const report = (await this.request("textDocument/diagnostic", {
      textDocument: { uri: pathToFileURL(fileName).href },
    })) as {
      items: {
        range: { start: { line: number; character: number } };
        code: string | number;
        message: string;
      }[];
    };
    return report.items.map(
      ({ range, code, message }) =>
        `${range.start.line + 1}:${range.start.character + 1} ${code} ${message}`,
    );
  }

  async close(): Promise<void> {
    await this.request("shutdown");
    this.notify("exit", null);
    this.#child.stdin!.end();
    if (this.#child.exitCode !== null) return;
    await new Promise((resolveExit) => this.#child.once("exit", resolveExit));
  }
}
