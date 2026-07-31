import * as path from "node:path";
import * as vscode from "vscode";
import { TmdCliClient } from "./cli.js";
import {
  TanuMarkdownDocument,
  TanuMarkdownEditorProvider,
  VIEW_TYPE,
} from "./editor.js";

function client(): TmdCliClient {
  const configuration = vscode.workspace.getConfiguration("tanuMarkdown");
  return new TmdCliClient(
    configuration.get<string>("cliPath", "tmd"),
    configuration.get<number>("timeoutMs", 15_000),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new TanuMarkdownEditorProvider(client);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: false,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("tmd.newDocument", async () => {
      await withErrorHandling(async () => {
        const uri = await vscode.window.showSaveDialog({
          filters: {
            "Tanu Markdown": ["tmd", "tmdp"],
          },
        });
        if (!uri) return;
        const title = await vscode.window.showInputBox({
          prompt: "Document title",
          value: "New TMD Document",
        });
        if (title === undefined) return;
        await client().newDocument(uri.fsPath, title);
        await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
      });
    }),
    vscode.commands.registerCommand(
      "tmd.validate",
      async (target?: TanuMarkdownDocument) => {
        await withErrorHandling(async () => {
          const document = requireDocument(provider, target);
          await saveDocument(document);
          const report = await provider.validateDocument(document);
          if (report.valid) {
            await vscode.window.showInformationMessage(
              `Tanu Markdown document is valid (${report.issues.length} warning(s)).`,
            );
          } else {
            const first = report.issues.find((issue) => issue.severity === "error");
            await vscode.window.showErrorMessage(
              first ? `Validation failed: ${first.message}` : "Validation failed.",
            );
          }
        });
      },
    ),
    vscode.commands.registerCommand(
      "tmd.addAttachment",
      async (target?: TanuMarkdownDocument) => {
        await withErrorHandling(async () => {
          const document = requireDocument(provider, target);
          await saveDocument(document);
          const selected = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            title: "Select attachment",
          });
          const source = selected?.[0];
          if (!source) return;
          const logicalPath = await vscode.window.showInputBox({
            prompt: "Logical attachment path",
            value: `attachments/${path.basename(source.fsPath)}`,
            validateInput: (value) => (!value.trim() ? "A logical path is required." : undefined),
          });
          if (!logicalPath) return;
          await provider.addAttachment(document, source, logicalPath);
        });
      },
    ),
    vscode.commands.registerCommand(
      "tmd.removeAttachment",
      async (target?: TanuMarkdownDocument, requestedLogicalPath?: string) => {
        await withErrorHandling(async () => {
          const document = requireDocument(provider, target);
          await saveDocument(document);
          const logicalPath =
            requestedLogicalPath ??
            (await vscode.window.showQuickPick(
              document.inspection.attachments.map((attachment) => attachment.logical_path),
              { placeHolder: "Select an attachment to remove" },
            ));
          if (!logicalPath) return;
          await provider.removeAttachment(document, logicalPath);
        });
      },
    ),
    vscode.commands.registerCommand(
      "tmd.exportHtml",
      async (target?: TanuMarkdownDocument) => {
        await withErrorHandling(async () => {
          const document = requireDocument(provider, target);
          await saveDocument(document);
          const mode = await vscode.window.showQuickPick(
            [
              { label: "Self-contained HTML", selfContained: true },
              { label: "HTML with asset directory", selfContained: false },
            ],
            { placeHolder: "Choose attachment export mode" },
          );
          if (!mode) return;
          const output = await vscode.window.showSaveDialog({
            filters: { HTML: ["html"] },
            defaultUri: defaultSibling(document, ".html"),
          });
          if (!output) return;
          await provider.exportDocument(document, output, mode.selfContained);
          await vscode.window.showInformationMessage(`Exported ${output.fsPath}`);
        });
      },
    ),
    vscode.commands.registerCommand(
      "tmd.convert",
      async (target?: TanuMarkdownDocument) => {
        await withErrorHandling(async () => {
          const document = requireDocument(provider, target);
          await saveDocument(document);
          const targetExtension = document.uri.fsPath.toLowerCase().endsWith(".tmdp")
            ? ".tmd"
            : ".tmdp";
          const output = await vscode.window.showSaveDialog({
            filters: { "Tanu Markdown": [targetExtension.slice(1)] },
            defaultUri: defaultSibling(document, targetExtension),
          });
          if (!output) return;
          await provider.convertDocument(document, output);
          await vscode.commands.executeCommand("vscode.openWith", output, VIEW_TYPE);
        });
      },
    ),
  );
}

function requireDocument(
  provider: TanuMarkdownEditorProvider,
  target?: TanuMarkdownDocument,
): TanuMarkdownDocument {
  const document = target ?? provider.activeDocument;
  if (!document) {
    throw new Error("Open a Tanu Markdown document first.");
  }
  return document;
}

async function saveDocument(document: TanuMarkdownDocument): Promise<void> {
  const saved = await vscode.workspace.save(document.uri);
  if (!saved) {
    throw new Error(`Could not save ${document.uri.fsPath}.`);
  }
}

function defaultSibling(document: TanuMarkdownDocument, extension: string): vscode.Uri {
  const current = document.uri.fsPath;
  const base = current.slice(0, current.length - path.extname(current).length);
  return vscode.Uri.file(`${base}${extension}`);
}

async function withErrorHandling(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export function deactivate(): void {}
