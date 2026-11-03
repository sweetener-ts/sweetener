// @ts-check
"use strict";

const vscode = require("vscode");

/**
 * The TypeScript 7 extension routes a file to its language server by the
 * extensions its loaded tsconfigs map, and it loads a tsconfig only for a file
 * it has been sent. A `.sts` opened on its own, before any `.ts` in the
 * project, would never be sent, so the tsconfig naming
 * `@sweetener/content-mapper` would never load. Registering the extensions
 * here is what has the server take `.sts` and `.stsx` from the start.
 *
 * Nothing is mapped by this registration itself: which content mapper
 * handles a file is still the tsconfig's to say.
 */
const typescriptExtension = "TypeScriptTeam.native-preview";

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  // Which of its activations has them: updated or enabled again, it is another.
  let registeredWith;
  let registration;
  let saidNoSupport = false;
  let disposed = false;
  // Cleared first: disposing against an old client may throw, and that is no
  // reason to go on trying it, or not to register with a new one.
  const release = () => {
    const previous = registration;
    registration = undefined;
    registeredWith = undefined;
    try {
      previous?.dispose();
    } catch (error) {
      console.error(
        `Sweetener could not let go of its old registration with ${typescriptExtension}:`,
        error,
      );
    }
  };
  const attempt = async () => {
    // Registering starts TypeScript's server and, through a tsconfig, a mapper
    // out of node_modules: not for a folder not trusted. Highlighting needs none
    // of that, which is why this extension is supported there at all.
    if (!vscode.workspace.isTrusted) return;
    const extension = vscode.extensions.getExtension(typescriptExtension);
    if (extension === undefined) {
      release();
      return;
    }
    try {
      const api = await extension.activate();
      // Gone while that ran: nothing would let go of a registration made now.
      if (disposed) return;
      if (typeof api?.registerContentMappers !== "function") {
        if (!saidNoSupport)
          console.error(
            `This version of ${typescriptExtension} has no content mappers, so .sts and .stsx will not reach TypeScript's language server. Update it.`,
          );
        saidNoSupport = true;
        release();
        return;
      }
      saidNoSupport = false;
      if (api === registeredWith) return;
      release();
      registration = api.registerContentMappers("sweetener", [
        { extensions: [".sts", ".stsx"] },
      ]);
      registeredWith = api;
    } catch (error) {
      // Highlighting goes on without it; a failure here is no failure of this
      // extension's, and is said where someone looking into it will read.
      console.error(
        `Sweetener could not reach ${typescriptExtension}, so .sts and .stsx will not reach TypeScript's language server:`,
        error,
      );
    }
  };
  // One at a time, and once more for what arrived during one.
  let running = false;
  let again = false;
  const register = async () => {
    again = true;
    if (running) return;
    running = true;
    while (again && !disposed) {
      again = false;
      await attempt();
    }
    running = false;
  };
  // Installed or enabled after this one starts, it is taken up then, rather
  // than at the next window.
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => void register()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void register()),
    {
      dispose: () => {
        disposed = true;
        release();
      },
    },
  );
  await register();
}

function deactivate() {}

module.exports = { activate, deactivate };
