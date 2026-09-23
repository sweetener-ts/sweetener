const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

const documentSelector = [
  { scheme: "file", language: "sweetener-typescript" },
  { scheme: "file", language: "sweetener-typescriptreact" },
];

/** @type {import("vscode-languageclient/node").LanguageClient | undefined} */
let client;

function serverOptions() {
  const configured = vscode.workspace
    .getConfiguration("sweetener")
    .get("languageServer");
  const command =
    configured &&
    typeof configured.command === "string" &&
    configured.command.length > 0
      ? configured.command
      : "node";
  const args =
    configured && Array.isArray(configured.args) ? configured.args : [];
  if (args.length === 0) {
    throw new Error(
      "sweetener.languageServer.args must be the language server script and the project directory",
    );
  }
  return { command, args };
}

async function activate(context) {
  const output = vscode.window.createOutputChannel("Sweetener");
  context.subscriptions.push(output);
  let options;
  try {
    options = serverOptions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(message);
    return;
  }
  output.appendLine(`starting ${options.command} ${options.args.join(" ")}`);
  client = new LanguageClient("sweetener-lsp", "Sweetener", options, {
    documentSelector,
    outputChannel: output,
  });
  context.subscriptions.push(client);
  await client.start();
  output.appendLine("Sweetener language server started");
}

async function deactivate() {
  if (client !== undefined) await client.stop();
}

module.exports = { activate, deactivate };
