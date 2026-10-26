// Starts the MK language server (`mk lsp`) for .mk files: diagnostics as you type,
// hover with inferred types, go to definition, outline and completion.
const { workspace, window } = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;

function activate(context) {
  const config = workspace.getConfiguration("mk");
  const command = config.get("serverPath") || "mk";
  const server = { command, args: ["lsp"], options: { shell: process.platform === "win32" } };

  client = new LanguageClient(
    "mk",
    "MK Language Server",
    { run: server, debug: server },
    { documentSelector: [{ scheme: "file", language: "mk" }, { scheme: "untitled", language: "mk" }] },
  );
  client.start().catch((error) => {
    window.showWarningMessage(
      `MK: could not start '${command} lsp' (${error.message}). Install MK (npm link in the mkcode repo) or set "mk.serverPath".`,
    );
  });
  context.subscriptions.push({ dispose: () => client && client.stop() });
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
