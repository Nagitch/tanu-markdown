import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { findActiveDocument } from "./activity.js";
import { TmdCliClient } from "./cli.js";
import { renderSafeMarkdown } from "./markdown.js";
import type { DocumentInspection, DocumentUpdate, ValidationReport } from "./types.js";

export const VIEW_TYPE = "tanuMarkdown.editor";

interface EditorState {
  markdown: string;
  title: string;
}

export class TanuMarkdownDocument implements vscode.CustomDocument {
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    readonly uri: vscode.Uri,
    private inspectionValue: DocumentInspection,
  ) {}

  get inspection(): DocumentInspection {
    return this.inspectionValue;
  }

  snapshot(): EditorState {
    return {
      markdown: this.inspectionValue.markdown,
      title: this.inspectionValue.manifest.title ?? "",
    };
  }

  applyState(state: EditorState): void {
    this.inspectionValue.markdown = state.markdown;
    this.inspectionValue.manifest.title = state.title || null;
  }

  replaceInspection(inspection: DocumentInspection): void {
    this.inspectionValue = inspection;
  }

  dispose(): void {
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}

export class TanuMarkdownEditorProvider
  implements vscode.CustomEditorProvider<TanuMarkdownDocument>
{
  private readonly changeEmitter =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<TanuMarkdownDocument>>();
  readonly onDidChangeCustomDocument = this.changeEmitter.event;
  private readonly panels = new Map<TanuMarkdownDocument, Set<vscode.WebviewPanel>>();
  private activeDocumentValue: TanuMarkdownDocument | undefined;

  constructor(private readonly clientFactory: () => TmdCliClient) {}

  get activeDocument(): TanuMarkdownDocument | undefined {
    return this.activeDocumentValue;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
  ): Promise<TanuMarkdownDocument> {
    const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    const inspection = await this.clientFactory().inspect(filePath(source));
    return new TanuMarkdownDocument(uri, inspection);
  }

  async resolveCustomEditor(
    document: TanuMarkdownDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = editorHtml(panel.webview);
    const documentPanels = this.panels.get(document) ?? new Set<vscode.WebviewPanel>();
    documentPanels.add(panel);
    this.panels.set(document, documentPanels);
    this.recomputeActiveDocument();

    panel.onDidChangeViewState(() => {
      this.recomputeActiveDocument();
    });
    panel.onDidDispose(() => {
      documentPanels.delete(panel);
      if (documentPanels.size === 0) {
        this.panels.delete(document);
      }
      this.recomputeActiveDocument();
    });
    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      try {
        await this.handleMessage(document, message);
      } catch (error) {
        await showError(error);
      }
    });
  }

  async saveCustomDocument(document: TanuMarkdownDocument): Promise<void> {
    const state = document.snapshot();
    const update: DocumentUpdate = {
      schema_version: 1,
      markdown: state.markdown,
      title: state.title,
    };
    const inspection = await this.clientFactory().update(filePath(document.uri), update);
    document.replaceInspection(inspection);
    await this.postModel(document);
  }

  async saveCustomDocumentAs(
    document: TanuMarkdownDocument,
    destination: vscode.Uri,
  ): Promise<void> {
    const client = this.clientFactory();
    await client.convert(filePath(document.uri), filePath(destination));
    const state = document.snapshot();
    await client.update(filePath(destination), {
      schema_version: 1,
      markdown: state.markdown,
      title: state.title,
    });
  }

  async revertCustomDocument(document: TanuMarkdownDocument): Promise<void> {
    document.replaceInspection(await this.clientFactory().inspect(filePath(document.uri)));
    await this.postModel(document);
  }

  async backupCustomDocument(
    document: TanuMarkdownDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    const extension = path.extname(document.uri.fsPath).toLowerCase() === ".tmdp" ? ".tmdp" : ".tmd";
    const destination = vscode.Uri.file(`${context.destination.fsPath}${extension}`);
    await this.saveCustomDocumentAs(document, destination);
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // VS Code may already have removed stale backup data.
        }
      },
    };
  }

  async validateActive(): Promise<ValidationReport> {
    const document = this.requireActiveDocument();
    const report = await this.clientFactory().validate(filePath(document.uri));
    document.inspection.validation = report;
    await this.postModel(document);
    return report;
  }

  async addAttachmentActive(source: vscode.Uri, logicalPath: string): Promise<void> {
    const document = this.requireActiveDocument();
    await this.clientFactory().addAttachment(
      filePath(document.uri),
      filePath(source),
      logicalPath,
    );
    await this.reloadAfterExternalChange(document);
  }

  async removeAttachmentActive(logicalPath: string): Promise<void> {
    const document = this.requireActiveDocument();
    await this.clientFactory().removeAttachment(filePath(document.uri), logicalPath);
    await this.reloadAfterExternalChange(document);
  }

  async exportActive(output: vscode.Uri, selfContained: boolean): Promise<void> {
    const document = this.requireActiveDocument();
    await this.clientFactory().exportHtml(
      filePath(document.uri),
      filePath(output),
      selfContained,
    );
  }

  async convertActive(output: vscode.Uri): Promise<void> {
    const document = this.requireActiveDocument();
    await this.clientFactory().convert(filePath(document.uri), filePath(output));
  }

  private requireActiveDocument(): TanuMarkdownDocument {
    if (!this.activeDocumentValue) {
      throw new Error("Open a .tmd or .tmdp document in the Tanu Markdown editor first.");
    }
    return this.activeDocumentValue;
  }

  private async reloadAfterExternalChange(document: TanuMarkdownDocument): Promise<void> {
    document.replaceInspection(await this.clientFactory().inspect(filePath(document.uri)));
    // Attachment operations have already persisted the container. Emitting a
    // content-change event here would incorrectly make the document dirty.
    await this.postModel(document);
  }

  private recomputeActiveDocument(): void {
    this.activeDocumentValue = findActiveDocument(this.panels);
  }

  private async handleMessage(
    document: TanuMarkdownDocument,
    message: unknown,
  ): Promise<void> {
    if (!isMessage(message)) {
      return;
    }
    switch (message.type) {
      case "ready":
        await this.postModel(document);
        break;
      case "edit": {
        if (typeof message.markdown !== "string" || typeof message.title !== "string") {
          return;
        }
        const before = document.snapshot();
        const after = { markdown: message.markdown, title: message.title };
        if (before.markdown === after.markdown && before.title === after.title) {
          return;
        }
        document.applyState(after);
        this.changeEmitter.fire({
          document,
          label: "Edit Tanu Markdown",
          undo: async () => {
            document.applyState(before);
            await this.postModel(document);
          },
          redo: async () => {
            document.applyState(after);
            await this.postModel(document);
          },
        });
        await this.postModel(document);
        break;
      }
      case "validate":
        await vscode.commands.executeCommand("tmd.validate");
        break;
      case "addAttachment":
        await vscode.commands.executeCommand("tmd.addAttachment");
        break;
      case "removeAttachment":
        if (typeof message.logicalPath === "string") {
          await vscode.commands.executeCommand("workbench.action.files.save");
          await this.removeAttachmentActive(message.logicalPath);
        }
        break;
      case "exportHtml":
        await vscode.commands.executeCommand("tmd.exportHtml");
        break;
    }
  }

  private async postModel(document: TanuMarkdownDocument): Promise<void> {
    const state = document.snapshot();
    const model = {
      type: "model",
      inspection: document.inspection,
      markdown: state.markdown,
      title: state.title,
      previewHtml: renderSafeMarkdown(state.markdown),
    };
    const panels = this.panels.get(document);
    if (!panels) {
      return;
    }
    await Promise.all([...panels].map((panel) => panel.webview.postMessage(model)));
  }
}

function isMessage(value: unknown): value is Record<string, unknown> & { type: string } {
  return typeof value === "object" && value !== null && "type" in value;
}

function filePath(uri: vscode.Uri): string {
  if (uri.scheme !== "file") {
    throw new Error(`Tanu Markdown currently supports local files only, not ${uri.scheme}: URIs.`);
  }
  return uri.fsPath;
}

async function showError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await vscode.window.showErrorMessage(message);
}

function editorHtml(_webview: vscode.Webview): string {
  const nonce = randomBytes(18).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tanu Markdown Editor</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: .5rem; padding: .65rem; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: .35rem .65rem; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .layout { display: grid; grid-template-columns: minmax(22rem, 1fr) minmax(20rem, 1fr); min-height: calc(100vh - 3rem); }
    .pane { padding: 1rem; overflow: auto; }
    .pane + .pane { border-left: 1px solid var(--vscode-panel-border); }
    label { display: block; margin-bottom: .35rem; font-weight: 600; }
    input, textarea { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: .5rem; }
    textarea { min-height: 55vh; resize: vertical; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 1.5; }
    .field { margin-bottom: 1rem; }
    .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem; }
    .card { padding: .65rem; border: 1px solid var(--vscode-panel-border); }
    .valid { color: var(--vscode-testing-iconPassed); }
    .invalid { color: var(--vscode-testing-iconFailed); }
    li { margin: .35rem 0; }
    .attachment { display: flex; justify-content: space-between; gap: .5rem; align-items: center; }
    .preview { line-height: 1.6; }
    .preview pre { overflow: auto; padding: .75rem; background: var(--vscode-textCodeBlock-background); }
    .image-placeholder { display: inline-block; padding: .25rem .5rem; border: 1px dashed var(--vscode-panel-border); }
    @media (max-width: 850px) { .layout { grid-template-columns: 1fr; } .pane + .pane { border-left: 0; border-top: 1px solid var(--vscode-panel-border); } }
  </style>
</head>
<body>
  <nav class="toolbar" aria-label="Document actions">
    <button id="validate" type="button">Validate</button>
    <button id="add-attachment" type="button">Add attachment</button>
    <button id="export-html" type="button">Export HTML</button>
  </nav>
  <main class="layout">
    <section class="pane">
      <div class="field"><label for="title">Title</label><input id="title" type="text"></div>
      <div class="field"><label for="markdown">Markdown</label><textarea id="markdown" spellcheck="true"></textarea></div>
      <div class="summary">
        <div class="card"><strong>Format</strong><div id="format">—</div></div>
        <div class="card"><strong>Database version</strong><div id="database-version">—</div></div>
      </div>
      <h2>Attachments</h2>
      <ul id="attachments"></ul>
      <h2>Database objects</h2>
      <ul id="database-objects"></ul>
      <h2>Validation</h2>
      <div id="validation"></div>
    </section>
    <section class="pane">
      <h2>Safe preview</h2>
      <div id="preview" class="preview"></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const title = document.getElementById("title");
    const markdown = document.getElementById("markdown");
    const attachments = document.getElementById("attachments");
    const databaseObjects = document.getElementById("database-objects");
    const validation = document.getElementById("validation");
    const preview = document.getElementById("preview");
    let editTimer;
    const sendEdit = () => {
      clearTimeout(editTimer);
      editTimer = setTimeout(() => vscode.postMessage({ type: "edit", title: title.value, markdown: markdown.value }), 150);
    };
    title.addEventListener("input", sendEdit);
    markdown.addEventListener("input", sendEdit);
    document.getElementById("validate").addEventListener("click", () => vscode.postMessage({ type: "validate" }));
    document.getElementById("add-attachment").addEventListener("click", () => vscode.postMessage({ type: "addAttachment" }));
    document.getElementById("export-html").addEventListener("click", () => vscode.postMessage({ type: "exportHtml" }));
    preview.addEventListener("click", (event) => { if (event.target.closest("a")) event.preventDefault(); });
    window.addEventListener("message", (event) => {
      const model = event.data;
      if (!model || model.type !== "model") return;
      if (document.activeElement !== title) title.value = model.title;
      if (document.activeElement !== markdown) markdown.value = model.markdown;
      document.getElementById("format").textContent = model.inspection.format;
      document.getElementById("database-version").textContent = String(model.inspection.database_user_version);
      attachments.replaceChildren();
      for (const attachment of model.inspection.attachments) {
        const item = document.createElement("li");
        item.className = "attachment";
        const label = document.createElement("span");
        label.textContent = attachment.logical_path + " (" + attachment.length + " bytes)";
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => vscode.postMessage({ type: "removeAttachment", logicalPath: attachment.logical_path }));
        item.append(label, remove);
        attachments.append(item);
      }
      databaseObjects.replaceChildren();
      for (const object of model.inspection.database.objects) {
        const item = document.createElement("li");
        item.textContent = object.type + ": " + object.name;
        databaseObjects.append(item);
      }
      validation.replaceChildren();
      const status = document.createElement("p");
      status.className = model.inspection.validation.valid ? "valid" : "invalid";
      status.textContent = model.inspection.validation.valid ? "Valid" : "Validation errors";
      validation.append(status);
      const issues = document.createElement("ul");
      for (const issue of model.inspection.validation.issues) {
        const item = document.createElement("li");
        item.textContent = issue.severity + " [" + issue.code + "]: " + issue.message;
        issues.append(item);
      }
      validation.append(issues);
      preview.innerHTML = model.previewHtml;
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
