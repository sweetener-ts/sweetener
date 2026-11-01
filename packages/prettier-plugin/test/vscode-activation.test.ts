import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

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

function load(extensions: Record<string, unknown>) {
  moduleWithLoader._load = function (request, ...rest) {
    if (request === "vscode")
      return {
        extensions: { getExtension: (id: string) => extensions[id] },
      };
    return originalLoad.call(this, request, ...rest);
  };
  return require(resolve(extensionRoot, "extension.js")) as {
    activate(context: { subscriptions: unknown[] }): Promise<void>;
  };
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
    const extension = load({
      "TypeScriptTeam.native-preview": {
        activate: async () => ({
          registerContentMappers: (id: string, contributions: unknown) => {
            registered.push([id, contributions]);
            return disposable;
          },
        }),
      },
    });
    const context = { subscriptions: [] as unknown[] };
    await extension.activate(context);
    expect(registered).toEqual([
      ["sweetener", [{ extensions: [".sts", ".stsx"] }]],
    ]);
    expect(context.subscriptions).toEqual([disposable]);
  });

  test("does nothing where TypeScript 7 is missing or has no content mappers", async () => {
    for (const installed of [
      {},
      { "TypeScriptTeam.native-preview": { activate: async () => ({}) } },
    ]) {
      const context = { subscriptions: [] as unknown[] };
      await load(installed).activate(context);
      expect(context.subscriptions).toEqual([]);
    }
  });
});
