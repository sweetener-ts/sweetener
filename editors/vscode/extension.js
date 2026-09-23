const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

const documentSelector = [
  { scheme: "file", language: "sweetener-typescript" },
  { scheme: "file", language: "sweetener-typescriptreact" },
];

/** @type {import("vscode-languageclient/node").LanguageClient | undefined} */
let client;

function fileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * `sweetener --lsp --stdio`. VS Code's client uses the workspace folder as
 * the working directory. The CLI reads `process.cwd()` from that.
 *
 * @param {string} root
 * @returns {{ command: string, args: string[] } | undefined}
 */
function defaultLaunch(root) {
  const flags = ["--lsp", "--stdio"];
  const checkout = path.join(root, "packages/cli/bin/sweetener.mjs");
  if (fileExists(checkout))
    return { command: "node", args: [checkout, ...flags] };
  const installed = path.join(
    root,
    "node_modules/@sweetener/cli/bin/sweetener.mjs",
  );
  if (fileExists(installed)) {
    return { command: "node", args: [installed, ...flags] };
  }
  const bin = path.join(root, "node_modules/.bin/sweetener");
  if (fileExists(bin)) return { command: bin, args: flags };
  return undefined;
}

function serverOptions() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const configured = vscode.workspace
    .getConfiguration("sweetener")
    .get("languageServer");
  const command =
    configured &&
    typeof configured.command === "string" &&
    configured.command.length > 0
      ? configured.command
      : undefined;
  const args =
    configured && Array.isArray(configured.args) && configured.args.length > 0
      ? configured.args
      : undefined;
  if (command !== undefined || args !== undefined) {
    return { command: command ?? "node", args: args ?? ["--lsp", "--stdio"] };
  }
  if (root !== undefined) {
    const launch = defaultLaunch(root);
    if (launch !== undefined) return launch;
  }
  throw new Error(
    "sweetener was not found in node_modules or in this checkout. Install @sweetener/cli, or set sweetener.languageServer.",
  );
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
