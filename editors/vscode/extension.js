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
 * `node <sweetener> --lsp --stdio`, with the workspace as the working
 * directory. This checkout's sample config is not the workspace root, so
 * that directory becomes the working directory. A setting replaces this
 * only when the CLI is somewhere else.
 *
 * @param {string} root
 * @returns {{ command: string, args: string[], cwd: string } | undefined}
 */
function defaultLaunch(root) {
  const flags = ["--lsp", "--stdio"];
  const checkout = path.join(root, "packages/cli/bin/sweetener.mjs");
  const tour = path.join(root, "examples/language-tour");
  if (fileExists(checkout)) {
    const cwd = fileExists(path.join(tour, "sweetener.json")) ? tour : root;
    return { command: "node", args: [checkout, ...flags], cwd };
  }
  const installed = path.join(
    root,
    "node_modules/@sweetener/cli/bin/sweetener.mjs",
  );
  if (fileExists(installed)) {
    return { command: "node", args: [installed, ...flags], cwd: root };
  }
  const bin = path.join(root, "node_modules/.bin/sweetener");
  if (fileExists(bin)) return { command: bin, args: flags, cwd: root };
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
    return {
      command: command ?? "node",
      args: args ?? ["--lsp", "--stdio"],
      options: root === undefined ? undefined : { cwd: root },
    };
  }
  if (root !== undefined) {
    const launch = defaultLaunch(root);
    if (launch !== undefined) {
      return {
        command: launch.command,
        args: launch.args,
        options: { cwd: launch.cwd },
      };
    }
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
