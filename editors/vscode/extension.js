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
  let registering = false;
  let saidNoSupport = false;
  const register = async () => {
    // Registering starts TypeScript's server and, through a tsconfig, a mapper
    // out of node_modules: not for a folder not trusted. Highlighting needs none
    // of that, which is why this extension is supported there at all.
    if (registering || !vscode.workspace.isTrusted) return;
    const extension = vscode.extensions.getExtension(typescriptExtension);
    if (extension === undefined) return;
    registering = true;
    try {
      const api = await extension.activate();
      if (api === registeredWith) return;
      if (typeof api?.registerContentMappers !== "function") {
        if (!saidNoSupport)
          console.error(
            `This version of ${typescriptExtension} has no content mappers, so .sts and .stsx will not reach TypeScript's language server. Update it.`,
          );
        saidNoSupport = true;
        return;
      }
      context.subscriptions.push(
        api.registerContentMappers("sweetener", [
          { extensions: [".sts", ".stsx"] },
        ]),
      );
      registeredWith = api;
    } catch (error) {
      // Highlighting goes on without it; a failure here is no failure of this
      // extension's, and is said where someone looking into it will read.
      console.error(
        `Sweetener could not reach ${typescriptExtension}, so .sts and .stsx will not reach TypeScript's language server:`,
        error,
      );
    } finally {
      registering = false;
    }
  };
  // Installed or enabled after this one starts, it is taken up then, rather
  // than at the next window.
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => void register()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void register()),
  );
  await register();
}

function deactivate() {}

module.exports = { activate, deactivate };
