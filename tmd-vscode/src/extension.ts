import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "tanuMarkdownEditor.showWelcome",
    () => {
      const message =
        "Tanu Markdown Editor is installed. Features will arrive in a future release.";
      vscode.window.showInformationMessage(message);
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
