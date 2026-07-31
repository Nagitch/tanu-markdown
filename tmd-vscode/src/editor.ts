import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { findActiveDocument } from "./activity.js";
import { TmdCliClient } from "./cli.js";
import { authoritativeStateScript, editInputScript } from "./input.js";
import { renderSafeMarkdown } from "./markdown.js";
import {
  persistRetainedDocument,
  persistLatestEditorState,
  TanuMarkdownModel,
  type EditorState,
} from "./model.js";
import { SerialTaskQueue } from "./queue.js";
import { ClientRevisionTracker } from "./revision.js";
import type { DocumentInspection, DocumentUpdate, ValidationReport } from "./types.js";

export const VIEW_TYPE = "tanuMarkdown.editor";

export class TanuMarkdownDocument implements vscode.CustomDocument {
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  private readonly model: TanuMarkdownModel;

  constructor(
    readonly uri: vscode.Uri,
    inspection: DocumentInspection,
    private persistedBytesValue: Uint8Array,
    private diskBytesValue: Uint8Array | undefined,
  ) {
    this.model = new TanuMarkdownModel(inspection);
  }

  get inspection(): DocumentInspection {
    return this.model.inspection;
  }

  get contentRevision(): number {
    return this.model.contentRevision;
  }

  get isCurrentRevisionPersisted(): boolean {
    return this.model.isCurrentRevisionPersisted;
  }

  get isValidationCurrent(): boolean {
    return this.model.isValidationCurrent;
  }

  get persistedBytes(): Uint8Array {
    return this.persistedBytesValue;
  }

  replacePersistedBytes(bytes: Uint8Array): void {
    this.persistedBytesValue = bytes;
    this.diskBytesValue = bytes;
  }

  get expectedDiskState(): string {
    return diskState(this.diskBytesValue);
  }

  snapshot(): EditorState {
    return this.model.snapshot();
  }

  applyState(state: EditorState): void {
    this.model.applyState(state);
  }

  replaceInspectionIfCurrent(
    inspection: DocumentInspection,
    expectedRevision: number,
  ): boolean {
    return this.model.replaceInspectionIfCurrent(inspection, expectedRevision);
  }

  applyPersistedInspection(
    inspection: DocumentInspection,
    persistedRevision: number,
  ): void {
    this.model.applyPersistedInspection(inspection, persistedRevision);
  }

  applyValidation(report: ValidationReport, validatedRevision: number): boolean {
    return this.model.applyValidation(report, validatedRevision);
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
  private readonly panelClientRevisions =
    new ClientRevisionTracker<vscode.WebviewPanel>();
  private readonly documentOperations = new SerialTaskQueue<TanuMarkdownDocument>();
  private readonly editLocks = new Set<TanuMarkdownDocument>();
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
    const { inspection, persistedBytes } = await readAndInspectDocument(
      this.clientFactory(),
      source,
    );
    const diskBytes = openContext.backupId
      ? await readOptionalFile(uri)
      : persistedBytes;
    return new TanuMarkdownDocument(uri, inspection, persistedBytes, diskBytes);
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
        await this.handleMessage(document, panel, message);
      } catch (error) {
        await showError(error);
      }
    });
  }

  async saveCustomDocument(document: TanuMarkdownDocument): Promise<void> {
    await this.documentOperations.run(document, async () => {
      const state = document.snapshot();
      const savedRevision = document.contentRevision;
      const update: DocumentUpdate = {
        schema_version: 1,
        markdown: state.markdown,
        title: state.title,
      };
      const client = this.clientFactory();
      await this.saveRetainedState(document, client, update);
      const { inspection, persistedBytes } = await readAndInspectDocument(
        client,
        document.uri,
      );
      document.replacePersistedBytes(persistedBytes);
      document.applyPersistedInspection(inspection, savedRevision);
      await this.postModel(document);
    });
  }

  async saveCustomDocumentAs(
    document: TanuMarkdownDocument,
    destination: vscode.Uri,
  ): Promise<void> {
    await this.documentOperations.run(document, async () => {
      const client = this.clientFactory();
      const destinationExtension = path.extname(destination.fsPath).toLowerCase();
      if (![".tmd", ".tmdp"].includes(destinationExtension)) {
        throw new Error("Save As destination must use the .tmd or .tmdp extension.");
      }
      const sourceExtension = document.inspection.format === "tmdp" ? ".tmdp" : ".tmd";
      let destinationPublished = false;
      let expectedDestinationState = diskState(
        await readOptionalFile(destination),
      );
      for (;;) {
        const stagingDirectory = await fs.mkdtemp(
          path.join(path.dirname(destination.fsPath), ".tmd-save-"),
        );
        const sourcePath = path.join(stagingDirectory, `source${sourceExtension}`);
        const stagedPath =
          sourceExtension === destinationExtension
            ? sourcePath
            : path.join(stagingDirectory, `destination${destinationExtension}`);
        let stagedRevision = document.contentRevision;
        try {
          await fs.writeFile(sourcePath, document.persistedBytes, { flag: "wx" });
          if (sourcePath !== stagedPath) {
            await client.convert(sourcePath, stagedPath);
          }
          await persistLatestEditorState(
            document,
            async (state) => {
              await client.update(stagedPath, {
                schema_version: 1,
                markdown: state.markdown,
                title: state.title,
              });
            },
            destinationPublished ? Number.MAX_SAFE_INTEGER : 3,
          );
          stagedRevision = document.contentRevision;
          const publishedState = diskState(await fs.readFile(stagedPath));
          await client.convert(
            stagedPath,
            filePath(destination),
            expectedDestinationState,
          );
          destinationPublished = true;
          expectedDestinationState = publishedState;
        } finally {
          await fs.rm(stagingDirectory, { force: true, recursive: true });
        }
        if (document.contentRevision === stagedRevision) {
          return;
        }
      }
    });
  }

  async revertCustomDocument(document: TanuMarkdownDocument): Promise<void> {
    await this.documentOperations.run(document, async () => {
      const revertedRevision = document.contentRevision;
      const { inspection, persistedBytes } = await readAndInspectDocument(
        this.clientFactory(),
        document.uri,
      );
      document.replacePersistedBytes(persistedBytes);
      if (!document.replaceInspectionIfCurrent(inspection, revertedRevision)) {
        throw new Error(
          "The document changed while revert was loading; edits were preserved and revert was cancelled.",
        );
      }
      await this.postModel(document);
    });
  }

  async backupCustomDocument(
    document: TanuMarkdownDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    const extension = path.extname(document.uri.fsPath).toLowerCase() === ".tmdp" ? ".tmdp" : ".tmd";
    const destination = vscode.Uri.file(`${context.destination.fsPath}${extension}`);
    await this.documentOperations.run(document, async () => {
      try {
        await fs.mkdir(path.dirname(destination.fsPath), { recursive: true });
        const client = this.clientFactory();
        await persistRetainedDocument(
          document,
          async (bytes) => vscode.workspace.fs.writeFile(destination, bytes),
          async (state) => {
            await client.update(filePath(destination), {
              schema_version: 1,
              markdown: state.markdown,
              title: state.title,
            });
          },
        );
      } catch (error) {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // The failed backup may not have created an output.
        }
        throw error;
      }
    });
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

  async validateDocument(document: TanuMarkdownDocument): Promise<ValidationReport> {
    return this.documentOperations.run(document, async () => {
      const validatedRevision = document.contentRevision;
      requirePersistedRevision(document, "validate");
      const report = await this.clientFactory().validate(filePath(document.uri));
      if (!document.applyValidation(report, validatedRevision)) {
        throw new Error(
          "The document changed while validation was running; save and validate again.",
        );
      }
      await this.postModel(document);
      return report;
    });
  }

  async addAttachment(
    document: TanuMarkdownDocument,
    source: vscode.Uri,
    logicalPath: string,
  ): Promise<void> {
    await this.documentOperations.run(document, async () => {
      requirePersistedRevision(document, "add the attachment");
      const persistedRevision = document.contentRevision;
      await this.clientFactory().addAttachment(
        filePath(document.uri),
        filePath(source),
        logicalPath,
      );
      await this.reloadAfterExternalChange(document, persistedRevision);
    });
  }

  async removeAttachment(
    document: TanuMarkdownDocument,
    logicalPath: string,
  ): Promise<void> {
    await this.documentOperations.run(document, async () => {
      this.editLocks.add(document);
      try {
        await this.postModel(document);
        requirePersistedRevision(document, "remove the attachment");
        const persistedRevision = document.contentRevision;
        await this.clientFactory().removeAttachment(filePath(document.uri), logicalPath);
        await this.reloadAfterExternalChange(document, persistedRevision);
      } finally {
        this.editLocks.delete(document);
        await this.postModel(document);
      }
    });
  }

  async exportDocument(
    document: TanuMarkdownDocument,
    output: vscode.Uri,
    selfContained: boolean,
  ): Promise<void> {
    const expectedOutputState = diskState(await readOptionalFile(output));
    await this.documentOperations.run(document, async () => {
      requirePersistedRevision(document, "export");
      await this.clientFactory().exportHtml(
        filePath(document.uri),
        filePath(output),
        selfContained,
        expectedOutputState,
      );
    });
  }

  async convertDocument(
    document: TanuMarkdownDocument,
    output: vscode.Uri,
  ): Promise<void> {
    const expectedOutputState = diskState(await readOptionalFile(output));
    await this.documentOperations.run(document, async () => {
      requirePersistedRevision(document, "convert");
      await this.clientFactory().convert(
        filePath(document.uri),
        filePath(output),
        expectedOutputState,
      );
    });
  }

  private async reloadAfterExternalChange(
    document: TanuMarkdownDocument,
    persistedRevision: number,
  ): Promise<void> {
    const { inspection, persistedBytes } = await readAndInspectDocument(
      this.clientFactory(),
      document.uri,
    );
    document.replacePersistedBytes(persistedBytes);
    document.applyPersistedInspection(inspection, persistedRevision);
    // Attachment operations have already persisted the container. Emitting a
    // content-change event here would incorrectly make the document dirty.
    await this.postModel(document);
  }

  private async saveRetainedState(
    document: TanuMarkdownDocument,
    client: TmdCliClient,
    update: DocumentUpdate,
  ): Promise<void> {
    const sourceExtension = document.inspection.format === "tmdp" ? ".tmdp" : ".tmd";
    const stagingPath = path.join(
      path.dirname(document.uri.fsPath),
      `.tmd-save-${randomBytes(16).toString("hex")}${sourceExtension}`,
    );
    let stagingCreated = false;
    try {
      await fs.writeFile(stagingPath, document.persistedBytes, { flag: "wx" });
      stagingCreated = true;
      await client.update(stagingPath, update);
      const publishedBytes = await fs.readFile(stagingPath);
      try {
        await client.convert(
          stagingPath,
          filePath(document.uri),
          document.expectedDiskState,
        );
      } catch (error) {
        const currentBytes = await readOptionalFile(document.uri);
        if (diskState(currentBytes) !== diskState(publishedBytes)) {
          throw error;
        }
      }
      document.replacePersistedBytes(publishedBytes);
    } finally {
      if (stagingCreated) {
        await fs.rm(stagingPath, { force: true });
      }
    }
  }

  private recomputeActiveDocument(): void {
    this.activeDocumentValue = findActiveDocument(this.panels);
  }

  private async handleMessage(
    document: TanuMarkdownDocument,
    panel: vscode.WebviewPanel,
    message: unknown,
  ): Promise<void> {
    if (!isMessage(message)) {
      return;
    }
    switch (message.type) {
      case "ready":
        // Reloaded webviews restart their client-side revision counter.
        this.panelClientRevisions.reset(panel);
        await this.postModel(document);
        break;
      case "edit": {
        if (
          typeof message.markdown !== "string" ||
          typeof message.title !== "string" ||
          typeof message.clientRevision !== "number" ||
          !Number.isSafeInteger(message.clientRevision) ||
          message.clientRevision <= 0
        ) {
          return;
        }
        const clientRevision = message.clientRevision;
        if (this.editLocks.has(document)) {
          this.panelClientRevisions.accept(panel, clientRevision);
          await this.postModel(document);
          return;
        }
        if (!this.panelClientRevisions.accept(panel, clientRevision)) {
          await panel.webview.postMessage({
            type: "editAck",
            clientRevision,
            contentRevision: document.contentRevision,
          });
          return;
        }
        const before = document.snapshot();
        const after = { markdown: message.markdown, title: message.title };
        if (before.markdown !== after.markdown || before.title !== after.title) {
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
        }
        await panel.webview.postMessage({
          type: "editAck",
          clientRevision,
          contentRevision: document.contentRevision,
        });
        break;
      }
      case "preview": {
        if (
          typeof message.markdown !== "string" ||
          typeof message.clientRevision !== "number" ||
          !Number.isSafeInteger(message.clientRevision) ||
          message.clientRevision <= 0 ||
          message.clientRevision !== this.panelClientRevisions.latest(panel) ||
          message.markdown !== document.snapshot().markdown
        ) {
          return;
        }
        await panel.webview.postMessage({
          type: "preview",
          clientRevision: message.clientRevision,
          contentRevision: document.contentRevision,
          previewHtml: renderSafeMarkdown(message.markdown),
        });
        break;
      }
      case "validate":
        await vscode.commands.executeCommand("tmd.validate", document);
        break;
      case "addAttachment":
        await vscode.commands.executeCommand("tmd.addAttachment", document);
        break;
      case "removeAttachment":
        if (typeof message.logicalPath === "string") {
          await vscode.commands.executeCommand(
            "tmd.removeAttachment",
            document,
            message.logicalPath,
          );
        }
        break;
      case "exportHtml":
        await vscode.commands.executeCommand("tmd.exportHtml", document);
        break;
    }
  }

  private async postModel(document: TanuMarkdownDocument): Promise<void> {
    const state = document.snapshot();
    const model = {
      type: "model",
      contentRevision: document.contentRevision,
      inspection: document.inspection,
      validationCurrent: document.isValidationCurrent,
      markdown: state.markdown,
      title: state.title,
      previewHtml: renderSafeMarkdown(state.markdown),
      editingLocked: this.editLocks.has(document),
    };
    const panels = this.panels.get(document);
    if (!panels) {
      return;
    }
    await Promise.all(
      [...panels].map((panel) =>
        panel.webview.postMessage({
          ...model,
          acknowledgedClientRevision: this.panelClientRevisions.latest(panel),
        }),
      ),
    );
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

async function readOptionalFile(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
      return undefined;
    }
    throw error;
  }
}

async function inspectRetainedBytes(
  client: TmdCliClient,
  source: vscode.Uri,
  bytes: Uint8Array,
): Promise<DocumentInspection> {
  const extension = path.extname(source.fsPath).toLowerCase();
  if (![".tmd", ".tmdp"].includes(extension)) {
    throw new Error("TMD documents must use the .tmd or .tmdp extension.");
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tmd-open-"));
  const snapshotPath = path.join(directory, `snapshot${extension}`);
  try {
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return await client.inspect(snapshotPath);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

async function readAndInspectDocument(
  client: TmdCliClient,
  source: vscode.Uri,
): Promise<{ inspection: DocumentInspection; persistedBytes: Uint8Array }> {
  const persistedBytes = await vscode.workspace.fs.readFile(source);
  const inspection = await inspectRetainedBytes(client, source, persistedBytes);
  return { inspection, persistedBytes };
}

function diskState(bytes: Uint8Array | undefined): string {
  return bytes
    ? createHash("sha256").update(bytes).digest("hex")
    : "missing";
}

function requirePersistedRevision(
  document: TanuMarkdownDocument,
  operation: string,
): void {
  if (!document.isCurrentRevisionPersisted) {
    throw new Error(
      `The latest editor revision has not reached disk; save and ${operation} again.`,
    );
  }
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
    .stale { color: var(--vscode-descriptionForeground); }
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
      <div class="field"><label for="title">Title</label><input id="title" type="text" disabled></div>
      <div class="field"><label for="markdown">Markdown</label><textarea id="markdown" spellcheck="true" disabled></textarea></div>
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
    ${editInputScript()}
    ${authoritativeStateScript()}
    document.getElementById("validate").addEventListener("click", () => vscode.postMessage({ type: "validate" }));
    document.getElementById("add-attachment").addEventListener("click", () => vscode.postMessage({ type: "addAttachment" }));
    document.getElementById("export-html").addEventListener("click", () => vscode.postMessage({ type: "exportHtml" }));
    preview.addEventListener("click", (event) => { if (event.target.closest("a")) event.preventDefault(); });
    function renderValidation(report, current) {
      validation.replaceChildren();
      const status = document.createElement("p");
      if (!current || !report) {
        status.className = "stale";
        status.textContent = "Validation required";
        validation.append(status);
        return;
      }
      status.className = report.valid ? "valid" : "invalid";
      status.textContent = report.valid ? "Valid" : "Validation errors";
      validation.append(status);
      const issues = document.createElement("ul");
      for (const issue of report.issues) {
        const item = document.createElement("li");
        item.textContent = issue.severity + " [" + issue.code + "]: " + issue.message;
        issues.append(item);
      }
      validation.append(issues);
    }
    window.addEventListener("message", (event) => {
      const model = event.data;
      if (!model) return;
      if (model.type === "preview") {
        applyPreview(model);
        return;
      }
      if (model.type === "editAck") {
        applyEditAck(model);
        return;
      }
      if (model.type !== "model") return;
      if (!applyAuthoritativeState(model)) return;
      clearTimeout(previewTimer);
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
      renderValidation(model.inspection.validation, model.validationCurrent);
      preview.innerHTML = model.previewHtml;
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
}
