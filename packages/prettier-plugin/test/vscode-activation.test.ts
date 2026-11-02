import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * What the editor extension does when it activates: hand `.sts` and `.stsx`
 * to TypeScript 7's language server, through the API its extension exports.
 * Without it, a `.sts` opened before any `.ts` in the project is never sent
 * to the server, so the tsconfig naming the content mapper never loads.
 *
 * The extension is run against a stand-in for the `vscode` module, since the
 * real one exists only inside VS Code.
 */

const extensionRoot = resolve(import.meta.dirname, "../../../editors/vscode");
const require = createRequire(import.meta.url);

type Loader = (request: string, ...rest: unknown[]) => unknown;
const moduleWithLoader = Module as unknown as { _load: Loader };
const originalLoad = moduleWithLoader._load;

afterEach(() => {
  moduleWithLoader._load = originalLoad;
  delete require.cache[resolve(extensionRoot, "extension.js")];
});

const watching = { dispose() {} };

function load(extensions: Record<string, unknown>, trusted = true) {
  const changed: (() => void)[] = [];
  const workspace = {
    isTrusted: trusted,
    onDidGrantWorkspaceTrust: (listener: () => void) => {
      changed.push(listener);
      return watching;
    },
  };
  moduleWithLoader._load = function (request, ...rest) {
    if (request === "vscode")
      return {
        workspace,
        extensions: {
          getExtension: (id: string) => extensions[id],
          onDidChange: (listener: () => void) => {
            changed.push(listener);
            return watching;
          },
        },
      };
    return originalLoad.call(this, request, ...rest);
  };
  return {
    extension: require(resolve(extensionRoot, "extension.js")) as {
      activate(context: { subscriptions: unknown[] }): Promise<void>;
    },
    trust: () => {
      workspace.isTrusted = true;
    },
    changed: async () => {
      for (const listener of changed) listener();
      await new Promise((settled) => setImmediate(settled));
    },
  };
}

function typescript7(registered: unknown[], disposable: unknown) {
  const api = {
    registerContentMappers: (id: string, contributions: unknown) => {
      registered.push([id, contributions]);
      return disposable;
    },
  };
  return { activate: async () => api };
}

describe("activation", () => {
  test("the manifest activates it for both languages", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(extensionRoot, "package.json"), "utf8"),
    ) as { main: string; activationEvents: string[] };
    expect(manifest.main).toBe("./extension.js");
    expect(manifest.activationEvents).toEqual([
      "onLanguage:sweetener-typescript",
      "onLanguage:sweetener-typescriptreact",
    ]);
  });

  test("registers both extensions with TypeScript 7 and keeps the registration", async () => {
    const registered: unknown[] = [];
    const disposable = { dispose() {} };
    const { extension, changed } = load({
      "TypeScriptTeam.native-preview": typescript7(registered, disposable),
    });
    const context = { subscriptions: [] as unknown[] };
    await extension.activate(context);
    expect(registered).toEqual([
      ["sweetener", [{ extensions: [".sts", ".stsx"] }]],
    ]);
    expect(context.subscriptions).toHaveLength(3);
    // Going away takes the registration with it.
    let disposed = false;
    disposable.dispose = () => {
      disposed = true;
    };
    (context.subscriptions[2] as { dispose(): void }).dispose();
    expect(disposed).toBe(true);
    // Once: another extension changing registers nothing again.
    await changed();
    expect(registered).toHaveLength(1);
  });

  test("does nothing where TypeScript 7 is missing", async () => {
    const context = { subscriptions: [] as unknown[] };
    await load({}).extension.activate(context);
    expect(context.subscriptions).toHaveLength(3);
  });

  test.each([
    ["exports something else", {}],
    ["exports nothing", undefined],
  ])(
    "says once that a TypeScript 7 that %s will not do",
    async (_, exported) => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const { extension, changed } = load({
        "TypeScriptTeam.native-preview": { activate: async () => exported },
      });
      const context = { subscriptions: [] as unknown[] };
      await extension.activate(context);
      await changed();
      expect(context.subscriptions).toHaveLength(3);
      expect(logged).toHaveBeenCalledOnce();
      logged.mockRestore();
    },
  );

  test("runs on a web host, where its grammar is all there is", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(extensionRoot, "package.json"), "utf8"),
    ) as { main: string; browser: string };
    expect(manifest.browser).toBe(manifest.main);
    expect(
      readFileSync(resolve(extensionRoot, "extension.js"), "utf8"),
    ).not.toMatch(/require\("(?!vscode")/u);
  });

  test("stays supported in a folder not trusted, and leaves TypeScript alone until it is", async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(extensionRoot, "package.json"), "utf8"),
    ) as { capabilities: { untrustedWorkspaces: { supported: boolean } } };
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(true);
    const registered: unknown[] = [];
    const { extension, changed, trust } = load(
      { "TypeScriptTeam.native-preview": typescript7(registered, watching) },
      false,
    );
    await extension.activate({ subscriptions: [] });
    expect(registered).toEqual([]);
    trust();
    await changed();
    expect(registered).toHaveLength(1);
  });

  test("hears a change that arrives while it is registering", async () => {
    const registered: unknown[] = [];
    let finish: () => void = () => {};
    const first = typescript7(registered, watching);
    const installed: Record<string, unknown> = {
      "TypeScriptTeam.native-preview": {
        activate: () =>
          new Promise((settle) => {
            finish = () => {
              void first.activate().then(settle);
            };
          }),
      },
    };
    const { extension, changed } = load(installed);
    const activated = extension.activate({ subscriptions: [] });
    installed["TypeScriptTeam.native-preview"] = typescript7(
      registered,
      watching,
    );
    await changed();
    finish();
    await activated;
    expect(registered).toHaveLength(2);
  });

  test("registers with a new one though letting go of the old throws", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const registered: unknown[] = [];
    const installed: Record<string, unknown> = {
      "TypeScriptTeam.native-preview": typescript7(registered, {
        dispose() {
          throw new Error("the client is gone");
        },
      }),
    };
    const { extension, changed } = load(installed);
    await extension.activate({ subscriptions: [] });
    installed["TypeScriptTeam.native-preview"] = typescript7(
      registered,
      watching,
    );
    await changed();
    expect(registered).toHaveLength(2);
    logged.mockRestore();
  });

  test("lets go of the old registration when registering with a new one", async () => {
    let disposals = 0;
    const registered: unknown[] = [];
    const counted = {
      dispose() {
        disposals += 1;
      },
    };
    const installed: Record<string, unknown> = {
      "TypeScriptTeam.native-preview": typescript7(registered, counted),
    };
    const { extension, changed } = load(installed);
    await extension.activate({ subscriptions: [] });
    installed["TypeScriptTeam.native-preview"] = typescript7(
      registered,
      counted,
    );
    await changed();
    expect(disposals).toBe(1);
  });

  test("registers again with a TypeScript 7 updated while it runs", async () => {
    const registered: unknown[] = [];
    const installed: Record<string, unknown> = {
      "TypeScriptTeam.native-preview": typescript7(registered, watching),
    };
    const { extension, changed } = load(installed);
    await extension.activate({ subscriptions: [] });
    expect(registered).toHaveLength(1);
    installed["TypeScriptTeam.native-preview"] = typescript7(
      registered,
      watching,
    );
    await changed();
    expect(registered).toHaveLength(2);
  });

  test("registers with TypeScript 7 once it is installed", async () => {
    const installed: Record<string, unknown> = {};
    const { extension, changed } = load(installed);
    const registered: unknown[] = [];
    await extension.activate({ subscriptions: [] });
    expect(registered).toEqual([]);
    installed["TypeScriptTeam.native-preview"] = typescript7(
      registered,
      watching,
    );
    await changed();
    expect(registered).toHaveLength(1);
  });

  test("starts anyway where TypeScript 7 fails to, and says so", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { extension } = load({
      "TypeScriptTeam.native-preview": {
        activate: async () => {
          throw new Error("it broke");
        },
      },
    });
    await expect(
      extension.activate({ subscriptions: [] }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});
