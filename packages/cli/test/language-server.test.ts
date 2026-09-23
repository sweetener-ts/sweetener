import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { unimplementedLanguageServerMethods } from "../src/language-server.js";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = fileURLToPath(
  new URL("../bin/sweetener.mjs", import.meta.url),
);
const project = resolve(repository, "examples/language-tour");
const mainPath = resolve(project, "new/clamp-expression/main.sts");
const macroPath = resolve(project, "new/clamp-expression/macros.sts");
const jsxPath = resolve(project, "recovered/jsx-control-flow/main.stsx");
const runtimePath = resolve(project, "recovered/jsx-control-flow/runtime.ts");

interface RpcMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

function positionOf(
  text: string,
  offset: number,
): {
  line: number;
  character: number;
} {
  let line = 0;
  let start = 0;
  for (let index = 0; index < offset; index += 1)
    if (text[index] === "\n") {
      line += 1;
      start = index + 1;
    }
  return { line, character: offset - start };
}

function offsetOf(
  text: string,
  position: { line: number; character: number },
): number {
  let line = 0;
  let index = 0;
  while (line < position.line && index < text.length) {
    if (text[index] === "\n") line += 1;
    index += 1;
  }
  return index + position.character;
}

function slice(
  text: string,
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  },
): string {
  return text.slice(offsetOf(text, range.start), offsetOf(text, range.end));
}

interface Session {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  stop(): Promise<void>;
  stderr(): string;
}

function startServer(directory: string = project): Session {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [launcher, "--lsp", "--stdio", "--project", directory],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let pending = Buffer.alloc(0);
  let stderr = "";
  const waiting = new Map<
    number,
    { resolve: (message: RpcMessage) => void; reject: (error: Error) => void }
  >();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const headerEnd = pending.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = pending.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/iu.exec(header);
      if (match === null) throw new Error(`bad header ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (pending.length < bodyStart + length) return;
      const message = JSON.parse(
        pending.subarray(bodyStart, bodyStart + length).toString("utf8"),
      ) as RpcMessage;
      pending = pending.subarray(bodyStart + length);
      if (message.id === undefined) continue;
      const waiter = waiting.get(message.id);
      if (waiter === undefined) continue;
      waiting.delete(message.id);
      waiter.resolve(message);
    }
  });
  let nextId = 1;
  const send = (message: unknown): void => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    child.stdin.write(
      `Content-Length: ${String(body.length)}\r\n\r\n${body.toString("utf8")}`,
    );
  };
  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`timed out waiting for ${method}\n${stderr}`));
        }, 30_000);
        waiting.set(id, {
          resolve: (message) => {
            clearTimeout(timer);
            if (message.error !== undefined)
              reject(
                new Error(
                  `${method} failed: ${message.error.message ?? "error"}\n${stderr}`,
                ),
              );
            else resolveResult(message.result);
          },
          reject,
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    stderr: () => stderr,
    async stop() {
      send({ jsonrpc: "2.0", method: "exit" });
      child.stdin.end();
      await new Promise<void>((resolveResult) => {
        if (child.exitCode !== null) resolveResult();
        else child.once("exit", () => resolveResult());
      });
    },
  };
}

interface Hover {
  readonly contents: { readonly kind?: string; readonly value: string };
  readonly range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface Location {
  readonly uri: string;
  readonly range: Hover["range"];
}

interface DiagnosticReport {
  readonly kind: string;
  readonly items: readonly {
    readonly message: string;
    readonly range: Hover["range"];
    readonly source: string;
  }[];
}

function within(text: string, range: Hover["range"]): boolean {
  const start = offsetOf(text, range.start);
  const end = offsetOf(text, range.end);
  return start >= 0 && end >= start && end <= text.length;
}

describe("sweetener language server", () => {
  test("re-expands when a macro dependency changes on disk", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-lsp-watch-"));
    const macros = join(directory, "macros.sts");
    const main = join(directory, "main.sts");
    writeFileSync(
      macros,
      `export syntax clamp:expr {
  rule { clamp($value:expr, $minimum:expr, $maximum:expr) } => {
    globalThis.Math.min($maximum, globalThis.Math.max($minimum, $value))
  }
}
`,
    );
    const source = `import { clamp } from "./macros.sts" for syntax;
export const low = clamp(-4, 0, 10);
`;
    writeFileSync(main, source);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: ["macros.sts", "main.sts"],
      }),
    );
    const server = startServer(directory);
    const uri = pathToFileURL(main).href;
    try {
      await server.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(directory).href,
        capabilities: {},
      });
      server.notify("initialized", {});
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: "sweetener",
          version: 1,
          text: source,
        },
      });
      const position = positionOf(source, source.indexOf("clamp(-4"));
      const before = (await server.request("textDocument/hover", {
        textDocument: { uri },
        position,
      })) as Hover;
      expect(before.contents.value).toContain("Math.min");
      writeFileSync(
        macros,
        `export syntax clamp:expr {
  rule { clamp($value:expr, $minimum:expr, $maximum:expr) } => {
    afterEdit($value)
  }
}
`,
      );
      const started = Date.now();
      let after = before;
      while (!after.contents.value.includes("afterEdit")) {
        if (Date.now() - started > 5_000)
          throw new Error(
            `expansion did not notice the macro edit: ${after.contents.value}`,
          );
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        after = (await server.request("textDocument/hover", {
          textDocument: { uri },
          position,
        })) as Hover;
      }
      expect(after.contents.value).toContain("afterEdit(-4)");
      expect(readFileSync(main, "utf8")).toBe(source);
    } finally {
      await server.stop();
    }
  }, 20_000);

  test("expands a file outside the configured project for one request", async () => {
    const home = mkdtempSync(join(tmpdir(), "sweet-lsp-home-"));
    const other = mkdtempSync(join(tmpdir(), "sweet-lsp-other-"));
    const writeProject = (directory: string, body: string): string => {
      writeFileSync(
        join(directory, "macros.sts"),
        `export syntax marker:expr {
  rule { marker($value:expr) } => { ${body} }
}
`,
      );
      const source = `import { marker } from "./macros.sts" for syntax;
export const value = marker(1);
`;
      writeFileSync(join(directory, "main.sts"), source);
      writeFileSync(
        join(directory, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
          },
          files: ["macros.sts", "main.sts"],
        }),
      );
      return source;
    };
    const homeSource = writeProject(home, "kept($value)");
    const otherSource = writeProject(other, "once($value)");
    const server = startServer(home);
    const homeUri = pathToFileURL(join(home, "main.sts")).href;
    const otherPath = join(other, "main.sts");
    const otherUri = pathToFileURL(otherPath).href;
    try {
      await server.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(home).href,
        capabilities: {},
      });
      server.notify("initialized", {});
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: homeUri,
          languageId: "sweetener",
          version: 1,
          text: homeSource,
        },
      });
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri: otherUri,
          languageId: "sweetener",
          version: 1,
          text: otherSource,
        },
      });
      const otherAt = positionOf(otherSource, otherSource.indexOf("marker(1"));
      const first = (await server.request("textDocument/hover", {
        textDocument: { uri: otherUri },
        position: otherAt,
      })) as Hover;
      expect(first.contents.value).toContain("(macro) marker: expr");
      expect(first.contents.value).toContain("once(1)");
      writeFileSync(
        join(other, "macros.sts"),
        `export syntax marker:expr {
  rule { marker($value:expr) } => { again($value) }
}
`,
      );
      const second = (await server.request("textDocument/hover", {
        textDocument: { uri: otherUri },
        position: otherAt,
      })) as Hover;
      expect(second.contents.value).toContain("again(1)");
      const homeHover = (await server.request("textDocument/hover", {
        textDocument: { uri: homeUri },
        position: positionOf(homeSource, homeSource.indexOf("marker(1")),
      })) as Hover;
      expect(homeHover.contents.value).toContain("kept(1)");
    } finally {
      await server.stop();
    }
  }, 20_000);

  test("completes a for-syntax import and jumps from else to its macro", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sweet-lsp-import-"));
    writeFileSync(
      join(directory, "macros.sts"),
      `export syntax when:expr {
  rule { when ($condition:expr) } => { $condition }
}
export syntax marker:expr {
  rule { marker($value:expr) } => { $value }
}
`,
    );
    const source = `import { } from "./macros.sts" for syntax;
export const value = {when (true)} {else} {end};
`;
    writeFileSync(join(directory, "main.sts"), source);
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        files: ["macros.sts", "main.sts"],
      }),
    );
    const server = startServer(directory);
    const uri = pathToFileURL(join(directory, "main.sts")).href;
    try {
      await server.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(directory).href,
        capabilities: {},
      });
      server.notify("initialized", {});
      server.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: "sweetener",
          version: 1,
          text: source,
        },
      });
      const inside = positionOf(source, source.indexOf("{ }") + 1);
      const completion = (await server.request("textDocument/completion", {
        textDocument: { uri },
        position: inside,
      })) as { items: { label: string; detail?: string }[] };
      expect(completion.items.map((item) => item.label).sort()).toEqual([
        "marker",
        "when",
      ]);
      const definitions = (await server.request("textDocument/definition", {
        textDocument: { uri },
        position: positionOf(source, source.indexOf("else")),
      })) as Location[];
      expect(definitions.length).toBeGreaterThan(0);
      const macro = readFileSync(join(directory, "macros.sts"), "utf8");
      expect(
        definitions.some(
          (definition) => slice(macro, definition.range) === "when",
        ),
      ).toBe(true);
      const typed = (await server.request("textDocument/typeDefinition", {
        textDocument: { uri },
        position: positionOf(source, source.indexOf("value")),
      })) as Location[] | null;
      expect(typed === null || Array.isArray(typed)).toBe(true);
    } finally {
      await server.stop();
    }
  }, 20_000);

  test("does not expand language-tour again on the next jump", async () => {
    const server = startServer(repository);
    const main = resolve(
      repository,
      "examples/language-tour/recovered/core-rewrites/main.sts",
    );
    const text = readFileSync(main, "utf8");
    const uri = pathToFileURL(main).href;
    const position = positionOf(text, text.indexOf("exact"));
    try {
      await server.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(repository).href,
        capabilities: {},
      });
      server.notify("initialized", {});
      server.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "sweetener", version: 1, text },
      });
      const firstStarted = performance.now();
      const first = (await server.request("textDocument/definition", {
        textDocument: { uri },
        position,
      })) as Location[];
      const firstMs = performance.now() - firstStarted;
      const secondStarted = performance.now();
      const second = (await server.request("textDocument/definition", {
        textDocument: { uri },
        position,
      })) as Location[];
      const secondMs = performance.now() - secondStarted;
      expect(second).toEqual(first);
      expect(first.length).toBeGreaterThan(0);
      expect(secondMs).toBeLessThan(firstMs);
      expect(secondMs).toBeLessThan(80);
    } finally {
      await server.stop();
    }
  }, 30_000);

  test("answers mapped editor requests for the language tour", async () => {
    const launches = [];
    for (let launch = 0; launch < 2; launch += 1)
      launches.push(await exercise());
    expect(launches[1]?.lowHover).toEqual(launches[0]?.lowHover);
    expect(launches[1]?.lowHoverAfterEdit).toEqual(
      launches[0]?.lowHoverAfterEdit,
    );
    expect(launches[1]?.diagnostics).toEqual(launches[0]?.diagnostics);
    expect(launches[0]?.diagnostics.length).toBeGreaterThan(0);
    expect(launches[0]?.warmMedian).toBeLessThan(
      launches[0]?.firstRequest ?? 0,
    );
    expect(launches[1]?.warmMedian).toBeLessThan(
      launches[1]?.firstRequest ?? 0,
    );
    console.log(
      JSON.stringify(
        {
          advertised: launches[0]?.advertised,
          unimplemented: [...unimplementedLanguageServerMethods],
          warm: launches.map(({ firstRequest, warmMedian, warmP95 }) => ({
            firstRequest,
            warmMedian,
            warmP95,
          })),
        },
        null,
        2,
      ),
    );
  }, 120_000);
});

async function exercise(): Promise<{
  advertised: unknown;
  lowHover: unknown;
  lowHoverAfterEdit: unknown;
  diagnostics: readonly unknown[];
  firstRequest: number;
  warmMedian: number;
  warmP95: number;
}> {
  const server = startServer();
  const source = readFileSync(mainPath, "utf8");
  const macros = readFileSync(macroPath, "utf8");
  const mainUri = pathToFileURL(mainPath).href;
  const macroUri = pathToFileURL(macroPath).href;
  try {
    const initialized = (await server.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(project).href,
      capabilities: {},
    })) as { capabilities: Record<string, unknown> };
    server.notify("initialized", {});
    const open = (uri: string, text: string): void => {
      server.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "sweetener", version: 1, text },
      });
    };
    open(mainUri, source);
    open(macroUri, macros);

    const low = positionOf(source, source.indexOf("low"));
    const samples: number[] = [];
    let lowHover: Hover | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const started = performance.now();
      const hover = (await server.request("textDocument/hover", {
        textDocument: { uri: mainUri },
        position: low,
      })) as Hover;
      samples.push(performance.now() - started);
      lowHover = hover;
    }
    if (lowHover === undefined) throw new Error("missing hover");
    expect(lowHover.contents.kind).toBe("markdown");
    expect(lowHover.contents.value).toContain("```typescript");
    expect(lowHover.contents.value).toContain("low");
    expect(lowHover.contents.value).toContain("number");
    expect(lowHover.contents.value.toLowerCase()).not.toContain("clamp");
    expect(slice(source, lowHover.range)).toBe("low");

    const clampAt = positionOf(source, source.indexOf("clamp(-4"));
    const clampHover = (await server.request("textDocument/hover", {
      textDocument: { uri: mainUri },
      position: clampAt,
    })) as Hover;
    expect(clampHover.contents.value).toContain("(macro) clamp: expr");
    expect(clampHover.contents.value).toContain("Math.min");
    expect(slice(source, clampHover.range)).toBe("clamp");
    const clampDefinitions = (await server.request("textDocument/definition", {
      textDocument: { uri: mainUri },
      position: clampAt,
    })) as Location[];
    expect(
      clampDefinitions.some(
        (definition) =>
          definition.uri === macroUri &&
          slice(macros, definition.range) === "clamp",
      ),
    ).toBe(true);

    const definitions = (await server.request("textDocument/definition", {
      textDocument: { uri: mainUri },
      position: low,
    })) as Location[];
    expect(
      definitions.some(
        (definition) =>
          definition.uri === mainUri &&
          slice(source, definition.range) === "low",
      ),
    ).toBe(true);

    const references = (await server.request("textDocument/references", {
      textDocument: { uri: mainUri },
      position: low,
      context: { includeDeclaration: true },
    })) as Location[];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references)
      expect(
        within(reference.uri === mainUri ? source : macros, reference.range),
      ).toBe(true);

    const jsx = readFileSync(jsxPath, "utf8");
    const runtime = readFileSync(runtimePath, "utf8");
    const jsxUri = pathToFileURL(jsxPath).href;
    const runtimeUri = pathToFileURL(runtimePath).href;
    open(jsxUri, jsx);
    const renderAt = positionOf(jsx, jsx.indexOf("render("));
    const declarationAt = positionOf(
      runtime,
      runtime.indexOf("function render") + "function ".length,
    );
    const renderReferences = (await server.request("textDocument/references", {
      textDocument: { uri: jsxUri },
      position: renderAt,
      context: { includeDeclaration: true },
    })) as Location[];
    expect(
      renderReferences.some(
        (reference) =>
          reference.uri === runtimeUri &&
          slice(runtime, reference.range) === "render" &&
          reference.range.start.line === declarationAt.line &&
          reference.range.start.character === declarationAt.character,
      ),
    ).toBe(true);
    const usesOnly = (await server.request("textDocument/references", {
      textDocument: { uri: jsxUri },
      position: renderAt,
      context: { includeDeclaration: false },
    })) as Location[];
    expect(
      usesOnly.some(
        (reference) =>
          reference.uri === runtimeUri &&
          reference.range.start.line === declarationAt.line &&
          reference.range.start.character === declarationAt.character,
      ),
    ).toBe(false);
    expect(
      usesOnly.some(
        (reference) =>
          reference.uri === runtimeUri &&
          slice(runtime, reference.range) === "render",
      ),
    ).toBe(true);

    const completions = (await server.request("textDocument/completion", {
      textDocument: { uri: mainUri },
      position: positionOf(source, source.indexOf("10")),
    })) as {
      items: readonly {
        label: string;
        textEdit?: { range: Hover["range"] };
      }[];
    };
    expect(completions.items.some((item) => item.label === "low")).toBe(true);
    for (const item of completions.items)
      if (item.textEdit !== undefined)
        expect(within(source, item.textEdit.range)).toBe(true);

    const prepared = (await server.request("textDocument/prepareRename", {
      textDocument: { uri: mainUri },
      position: low,
    })) as { range: Hover["range"]; placeholder: string };
    expect(slice(source, prepared.range)).toBe("low");
    const renamed = (await server.request("textDocument/rename", {
      textDocument: { uri: mainUri },
      position: low,
      newName: "floor",
    })) as {
      changes: Record<string, { range: Hover["range"]; newText: string }[]>;
    };
    const edits = renamed.changes[mainUri];
    expect(edits?.length).toBeGreaterThan(0);
    expect(edits?.every((edit) => slice(source, edit.range) === "low")).toBe(
      true,
    );

    await expect(
      server.request("textDocument/rename", {
        textDocument: { uri: mainUri },
        position: clampAt,
        newName: "limit",
      }),
    ).rejects.toThrow(/rename|generated|boundary|location|binding|captured/iu);

    const ruleAt = positionOf(macros, macros.indexOf("rule"));
    expect(
      await server.request("textDocument/hover", {
        textDocument: { uri: macroUri },
        position: ruleAt,
      }),
    ).toBeNull();
    expect(
      await server.request("textDocument/definition", {
        textDocument: { uri: macroUri },
        position: ruleAt,
      }),
    ).toBeNull();

    const withBound = `import { clamp } from "./macros.sts" for syntax;

const bound = 1;
export const low = clamp(bound, 0, 10);
export const middle = clamp(6, 0, 10);
export const high = clamp(14, 0, 10);
`;
    server.notify("textDocument/didChange", {
      textDocument: { uri: mainUri, version: 2 },
      contentChanges: [{ text: withBound }],
    });
    await expect(
      server.request("textDocument/rename", {
        textDocument: { uri: mainUri },
        position: positionOf(withBound, withBound.lastIndexOf("bound")),
        newName: "value",
      }),
    ).rejects.toThrow(/binding/);

    const edited = source.replace("-4", '"zz"');
    server.notify("textDocument/didChange", {
      textDocument: { uri: mainUri, version: 3 },
      contentChanges: [{ text: edited }],
    });
    const lowHoverAfterEdit = (await server.request("textDocument/hover", {
      textDocument: { uri: mainUri },
      position: positionOf(edited, edited.indexOf("low")),
    })) as Hover;
    expect(lowHoverAfterEdit.contents.value).toContain("low");
    expect(slice(edited, lowHoverAfterEdit.range)).toBe("low");
    expect(lowHoverAfterEdit.contents.value.toLowerCase()).not.toContain(
      "cannot find name",
    );

    const literalAt = positionOf(edited, edited.indexOf("zz"));
    const literalHover = (await server.request("textDocument/hover", {
      textDocument: { uri: mainUri },
      position: literalAt,
    })) as Hover;
    expect(literalHover.contents.value).toContain("z");
    expect(within(edited, literalHover.range)).toBe(true);
    expect(slice(edited, literalHover.range)).toContain("z");

    const diagnostics = (await server.request("textDocument/diagnostic", {
      textDocument: { uri: mainUri },
    })) as DiagnosticReport;
    expect(diagnostics.kind).toBe("full");
    expect(diagnostics.items.length).toBeGreaterThan(0);
    expect(diagnostics.items.every((item) => within(edited, item.range))).toBe(
      true,
    );
    expect(
      diagnostics.items.some(
        (item) =>
          slice(edited, item.range).includes("zz") ||
          item.message.includes("zz") ||
          item.message.includes("not assignable"),
      ),
    ).toBe(true);

    const other = (await server.request("textDocument/diagnostic", {
      textDocument: { uri: macroUri },
    })) as DiagnosticReport;
    expect(other.kind).toBe("full");
    expect(readFileSync(mainPath, "utf8")).toBe(source);
    expect(readFileSync(mainPath, "utf8")).toContain("-4");

    const warm = [...samples.slice(1)].sort((left, right) => left - right);
    const warmMedian = warm[Math.floor(warm.length / 2)] ?? samples[0] ?? 0;
    const warmP95 =
      warm[Math.min(warm.length - 1, Math.ceil(0.95 * warm.length) - 1)] ??
      warmMedian;
    return {
      advertised: initialized.capabilities,
      lowHover,
      lowHoverAfterEdit,
      diagnostics: diagnostics.items,
      firstRequest: samples[0] ?? 0,
      warmMedian,
      warmP95,
    };
  } finally {
    await server.stop();
  }
}
