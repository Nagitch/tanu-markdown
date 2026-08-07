import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { findActiveDocument } from "./activity.js";
import { TmdCliClient } from "./cli.js";
import {
  inspectDataSourceRegistry,
  validateDataSources,
} from "./data-sources.js";
import type { EditorState } from "./model.js";
import { publishLatestRevision } from "./publication.js";
import { ClientRevisionTracker } from "./revision.js";
import { diskState, LocalTmdSession, readOptionalFile } from "./session.js";
import type {
  DataSource,
  ValidationReport,
} from "./types.js";
import { isEditorRequest } from "./webview-protocol.js";

export const VIEW_TYPE = "tanuMarkdown.editor";

export class TanuMarkdownDocument implements vscode.CustomDocument {
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    readonly uri: vscode.Uri,
    readonly session: LocalTmdSession,
  ) {}

  get inspection(): LocalTmdSession["inspection"] {
    return this.session.inspection;
  }

  get contentRevision(): number {
    return this.session.contentRevision;
  }

  get isCurrentRevisionPersisted(): boolean {
    return this.session.isCurrentRevisionPersisted;
  }

  get isValidationCurrent(): boolean {
    return this.session.isValidationCurrent;
  }

  snapshot(): EditorState {
    return this.session.snapshot();
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
  private activeDocumentValue: TanuMarkdownDocument | undefined;

  constructor(
    private readonly clientFactory: () => TmdCliClient,
    private readonly errorHandler: (error: unknown) => Promise<void> = showError,
  ) {}

  get activeDocument(): TanuMarkdownDocument | undefined {
    return this.activeDocumentValue;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
  ): Promise<TanuMarkdownDocument> {
    try {
      const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
      const documentPath = filePath(uri);
      const session = await LocalTmdSession.open(
        documentPath,
        filePath(source),
        await readOptionalFile(documentPath),
        this.clientFactory,
      );
      return new TanuMarkdownDocument(uri, session);
    } catch (error) {
      await this.errorHandler(error);
      throw error;
    }
  }

  async resolveCustomEditor(
    document: TanuMarkdownDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const webviewRoot = vscode.Uri.joinPath(vscode.Uri.file(__dirname), "webview");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
    };
    const webviewTemplate = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(webviewRoot, "index.html"),
      ),
    );
    panel.webview.html = editorHtml(
      panel.webview,
      panel.webview.asWebviewUri(webviewRoot),
      webviewTemplate,
    );
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
        await this.errorHandler(error);
      }
    });
  }

  async saveCustomDocument(document: TanuMarkdownDocument): Promise<void> {
    await document.session.save();
    await this.postModel(document);
  }

  async saveCustomDocumentAs(
    document: TanuMarkdownDocument,
    destination: vscode.Uri,
  ): Promise<void> {
    await document.session.saveAs(filePath(destination));
  }

  async revertCustomDocument(document: TanuMarkdownDocument): Promise<void> {
    await document.session.revert();
    await this.postModel(document);
  }

  async backupCustomDocument(
    document: TanuMarkdownDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    const destination = vscode.Uri.file(`${context.destination.fsPath}.tmd`);
    try {
      await document.session.backup(filePath(destination));
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(destination);
      } catch {
        // The failed backup may not have created an output.
      }
      throw error;
    }
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
    const report = await document.session.validate();
    await this.postModel(document);
    return report;
  }

  async addAttachment(
    document: TanuMarkdownDocument,
    source: vscode.Uri,
    logicalPath: string,
  ): Promise<void> {
    await document.session.addAttachment(filePath(source), logicalPath);
    await this.postModel(document);
  }

  async removeAttachment(
    document: TanuMarkdownDocument,
    logicalPath: string,
  ): Promise<void> {
    const releaseEditingLock = document.session.acquireEditingLock();
    try {
      await this.postModel(document);
      await document.session.removeAttachment(logicalPath);
    } finally {
      releaseEditingLock();
      await this.postModel(document);
    }
  }

  async exportDocument(
    document: TanuMarkdownDocument,
    output: vscode.Uri,
    selfContained: boolean,
  ): Promise<void> {
    const outputPath = filePath(output);
    await document.session.exportHtml(
      outputPath,
      selfContained,
      diskState(await readOptionalFile(outputPath)),
    );
  }

  private recomputeActiveDocument(): void {
    this.activeDocumentValue = findActiveDocument(this.panels);
  }

  private async handleMessage(
    document: TanuMarkdownDocument,
    panel: vscode.WebviewPanel,
    message: unknown,
  ): Promise<void> {
    if (!isEditorRequest(message)) {
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
        const before = document.snapshot();
        await this.applyEditorState(
          document,
          panel,
          message.clientRevision,
          {
            ...before,
            markdown: message.markdown,
            title: message.title,
          },
          "Edit Tanu Markdown",
        );
        break;
      }
      case "editDataSources": {
        if (
          typeof message.clientRevision !== "number" ||
          !Number.isSafeInteger(message.clientRevision) ||
          message.clientRevision <= 0
        ) {
          return;
        }
        const dataSources = parseDataSources(message.dataSources);
        if (!dataSources) {
          return;
        }
        validateDataSources(dataSources);
        dataSources.sort((left, right) => left.name.localeCompare(right.name));
        const before = document.snapshot();
        await this.applyEditorState(
          document,
          panel,
          message.clientRevision,
          { ...before, dataSources },
          "Edit TMD data sources",
        );
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
        const contentRevision = document.contentRevision;
        const state = document.snapshot();
        const previewHtml = await this.renderPreview(document, state);
        if (
          message.clientRevision !== this.panelClientRevisions.latest(panel) ||
          message.markdown !== document.snapshot().markdown ||
          contentRevision !== document.contentRevision
        ) {
          return;
        }
        await panel.webview.postMessage({
          type: "preview",
          clientRevision: message.clientRevision,
          contentRevision,
          previewHtml,
        });
        break;
      }
      case "dataSourceTable": {
        if (
          typeof message.source !== "string" ||
          typeof message.requestId !== "number" ||
          !Number.isSafeInteger(message.requestId) ||
          message.requestId <= 0 ||
          typeof message.clientRevision !== "number" ||
          !Number.isSafeInteger(message.clientRevision) ||
          message.clientRevision < 0 ||
          message.clientRevision !== this.panelClientRevisions.latest(panel)
        ) {
          return;
        }
        const state = document.snapshot();
        if (!state.dataSources.some((source) => source.name === message.source)) {
          return;
        }
        const contentRevision = document.contentRevision;
        try {
          const table = await document.session.dataSourceTable(message.source, state);
          await panel.webview.postMessage({
            type: "dataSourceTable",
            clientRevision: message.clientRevision,
            contentRevision,
            requestId: message.requestId,
            source: message.source,
            table,
          });
        } catch (error) {
          await panel.webview.postMessage({
            type: "dataSourceTable",
            clientRevision: message.clientRevision,
            contentRevision,
            requestId: message.requestId,
            source: message.source,
            issue: boundedMessage(error),
          });
        }
        break;
      }
      case "rhaiScript": {
        if (
          typeof message.source !== "string" ||
          typeof message.requestId !== "number" ||
          !Number.isSafeInteger(message.requestId) ||
          message.requestId <= 0 ||
          typeof message.clientRevision !== "number" ||
          !Number.isSafeInteger(message.clientRevision) ||
          message.clientRevision < 0 ||
          message.clientRevision !== this.panelClientRevisions.latest(panel)
        ) {
          return;
        }
        const state = document.snapshot();
        const source = state.dataSources.find(
          (candidate) =>
            candidate.name === message.source && candidate.type === "rhai",
        );
        if (!source || source.type !== "rhai") return;
        const contentRevision = document.contentRevision;
        try {
          const script = await document.session.textAttachment(source.script, state);
          await panel.webview.postMessage({
            type: "rhaiScript",
            clientRevision: message.clientRevision,
            contentRevision,
            requestId: message.requestId,
            source: message.source,
            script,
          });
        } catch (error) {
          await panel.webview.postMessage({
            type: "rhaiScript",
            clientRevision: message.clientRevision,
            contentRevision,
            requestId: message.requestId,
            source: message.source,
            issue: boundedMessage(error),
          });
        }
        break;
      }
      case "editRhaiScript": {
        if (
          typeof message.source !== "string" ||
          typeof message.logicalPath !== "string" ||
          typeof message.text !== "string" ||
          new TextEncoder().encode(message.text).length > 256 * 1024 ||
          typeof message.clientRevision !== "number" ||
          !Number.isSafeInteger(message.clientRevision) ||
          message.clientRevision <= 0
        ) {
          return;
        }
        const before = document.snapshot();
        const source = before.dataSources.find(
          (candidate) =>
            candidate.name === message.source && candidate.type === "rhai",
        );
        if (
          !source ||
          source.type !== "rhai" ||
          source.script !== message.logicalPath
        ) {
          return;
        }
        const after = await document.session.stateWithTextAttachmentEdit(
          before,
          message.logicalPath,
          message.text,
        );
        await this.applyEditorState(
          document,
          panel,
          message.clientRevision,
          after,
          `Edit Rhai script ${message.logicalPath}`,
        );
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

  private async applyEditorState(
    document: TanuMarkdownDocument,
    panel: vscode.WebviewPanel,
    clientRevision: number,
    after: EditorState,
    label: string,
  ): Promise<void> {
    if (document.session.editingLocked) {
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
    const applied = document.session.apply({
      type: "replaceEditorState",
      state: after,
    });
    if (applied.changed) {
      this.changeEmitter.fire({
        document,
        label,
        undo: async () => {
          if (document.session.editingLocked) {
            throw new Error("Cannot undo while an attachment operation is in progress.");
          }
          document.session.apply({ type: "replaceEditorState", state: before });
          await this.postModel(document);
        },
        redo: async () => {
          if (document.session.editingLocked) {
            throw new Error("Cannot redo while an attachment operation is in progress.");
          }
          document.session.apply({ type: "replaceEditorState", state: after });
          await this.postModel(document);
        },
      });
    }
    await panel.webview.postMessage({
      type: "editAck",
      clientRevision,
      contentRevision: document.contentRevision,
    });
  }

  private async postModel(document: TanuMarkdownDocument): Promise<void> {
    await publishLatestRevision(
      () => ({
        contentRevision: document.contentRevision,
        state: document.snapshot(),
      }),
      () => document.contentRevision,
      (state) => this.renderPreview(document, state),
      async ({ contentRevision, state }, previewHtml) => {
        const model = {
          type: "model",
          contentRevision,
          inspection: document.inspection,
          validationCurrent: document.isValidationCurrent,
          markdown: state.markdown,
          title: state.title,
          dataSourceRegistry: inspectDataSourceRegistry(
            document.inspection.manifest.extras,
          ),
          previewHtml,
          editingLocked: document.session.editingLocked,
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
      },
    );
  }

  private async renderPreview(
    document: TanuMarkdownDocument,
    state: EditorState,
  ): Promise<string> {
    return document.session.preview(state);
  }
}

function parseDataSources(value: unknown): DataSource[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sources: DataSource[] = [];
  for (const source of value) {
    if (
      typeof source !== "object" ||
      source === null ||
      !("name" in source) ||
      typeof source.name !== "string" ||
      !("type" in source)
    ) {
      return undefined;
    }
    if (source.type === "sqlite" && "query" in source && typeof source.query === "string") {
      sources.push({ name: source.name, type: "sqlite", query: source.query });
      continue;
    }
    if (
      source.type === "formula" &&
      "input" in source &&
      typeof source.input === "string" &&
      "program" in source &&
      typeof source.program === "string" &&
      "outputColumns" in source &&
      Array.isArray(source.outputColumns) &&
      source.outputColumns.every((column: unknown) => typeof column === "string")
    ) {
      sources.push({
        name: source.name,
        type: "formula",
        input: source.input,
        program: source.program,
        outputColumns: [...source.outputColumns],
      });
      continue;
    }
    if (
      source.type !== "rhai" ||
      !("script" in source) ||
      typeof source.script !== "string" ||
      !("inputs" in source) ||
      !Array.isArray(source.inputs) ||
      !("outputColumns" in source) ||
      !Array.isArray(source.outputColumns) ||
      !source.outputColumns.every((column: unknown) => typeof column === "string")
    ) {
      return undefined;
    }
    const inputs: Array<{ alias: string; source: string }> = [];
    for (const input of source.inputs) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("alias" in input) ||
        typeof input.alias !== "string" ||
        !("source" in input) ||
        typeof input.source !== "string"
      ) {
        return undefined;
      }
      inputs.push({ alias: input.alias, source: input.source });
    }
    inputs.sort((left, right) => left.alias.localeCompare(right.alias));
    sources.push({
      name: source.name,
      type: "rhai",
      script: source.script,
      inputs,
      outputColumns: [...source.outputColumns],
    });
  }
  return sources;
}

function filePath(uri: vscode.Uri): string {
  if (uri.scheme !== "file") {
    throw new Error(
      `Tanu Markdown currently supports local files only, not ${uri.scheme}: URIs.`,
    );
  }
  return uri.fsPath;
}

async function showError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await vscode.window.showErrorMessage(message);
}

function boundedMessage(error: unknown, maximumCharacters = 2_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maximumCharacters
    ? message
    : `${message.slice(0, maximumCharacters)}…`;
}

export function editorHtml(
  webview: vscode.Webview,
  webviewRootUri: vscode.Uri,
  webviewTemplate: string,
): string {
  const nonce = randomBytes(18).toString("base64");
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    "img-src data:",
  ].join("; ");
  const resourceRoot = webviewRootUri.toString().replace(/\/$/, "");
  const rewritten = webviewTemplate.replaceAll(
    "./_app/",
    `${resourceRoot}/_app/`,
  );
  if (!rewritten.includes("<head>")) {
    throw new Error("The bundled SvelteKit webview is missing its <head> element.");
  }
  return rewritten
    .replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">\n    <meta id="tmd-csp-nonce" name="csp-nonce" content="${nonce}">`,
    )
    .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
}
