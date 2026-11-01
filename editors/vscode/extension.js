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
const typescriptExtensions = ["TypeScriptTeam.native-preview"];

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  for (const id of typescriptExtensions) {
    const extension = vscode.extensions.getExtension(id);
    if (extension === undefined) continue;
    const api = await extension.activate();
    if (typeof api?.registerContentMappers !== "function") continue;
    context.subscriptions.push(
      api.registerContentMappers("sweetener", [
        { extensions: [".sts", ".stsx"] },
      ]),
    );
    return;
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
