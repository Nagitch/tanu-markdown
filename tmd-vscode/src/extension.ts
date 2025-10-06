import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const newDoc = vscode.commands.registerCommand("tmd.newDocument", async () => {
    const uri = await vscode.window.showSaveDialog({ filters: { "Tanu Markdown": ["tmd"] } });
    if (!uri) return;
    const boilerplate = `---
tmd: 1
title: "Untitled"
schemaVersion: "2025.10"
attachments: []
data:
  engine: sqlite
  entry: data/main.sqlite
---

# New Tanu Markdown

Hello!
`;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(boilerplate, "utf8"));
    vscode.window.showTextDocument(uri);
  });

  const insertAttach = vscode.commands.registerCommand("tmd.insertAttachmentLink", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const path = await vscode.window.showInputBox({ prompt: "Attachment path (e.g., images/foo.png)" });
    if (!path) return;
    const snippet = `![attachment](attach:${path})`;
    editor.insertSnippet(new vscode.SnippetString(snippet));
  });

  const validate = vscode.commands.registerCommand("tmd.validate", async () => {
    vscode.window.showInformationMessage("Validate: (MVP stub) parse EOCD comment, match markdown length, check manifest hashes.");
  });

  const exportHtml = vscode.commands.registerCommand("tmd.exportHtml", async () => {
    vscode.window.showInformationMessage("Export HTML (self-contained): (MVP stub)");
  });

  const convertToTmdz = vscode.commands.registerCommand("tmd.convertToTmdz", async () => {
    vscode.window.showInformationMessage("Convert to .tmdz: (MVP stub)");
  });

  context.subscriptions.push(newDoc, insertAttach, validate, exportHtml, convertToTmdz);
}

export function deactivate() {}
