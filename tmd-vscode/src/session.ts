import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TmdCliClient } from "./cli.js";
import {
  extrasWithDataSources,
  sameDataSources,
} from "./data-sources.js";
import {
  persistLatestEditorState,
  persistRetainedDocument,
  sameDatabaseCellEdits,
  TanuMarkdownModel,
  type EditorState,
} from "./model.js";
import { renderPreviewFallback } from "./preview.js";
import { SerialTaskQueue } from "./queue.js";
import type {
  DataSourceTable,
  DocumentInspection,
  DocumentUpdate,
  TextAttachmentEdit,
  TextAttachmentView,
  ValidationReport,
} from "./types.js";

export type TmdCliClientFactory = () => TmdCliClient;

export interface ReplaceEditorStateOperation {
  readonly type: "replaceEditorState";
  readonly state: EditorState;
}

export type TmdSessionOperation = ReplaceEditorStateOperation;

export interface AppliedSessionOperation {
  readonly before: EditorState;
  readonly after: EditorState;
  readonly changed: boolean;
  readonly contentRevision: number;
}

/**
 * Authoritative local editing session shared by all editor surfaces for one
 * opened TMD resource.
 *
 * The session owns revisions, retained container bytes, serialization and all
 * calls into the Rust CLI. VS Code providers are host adapters only: they map
 * editor lifecycle and messages to this API and never parse or mutate a TMD
 * container themselves.
 */
export class LocalTmdSession {
  private readonly model: TanuMarkdownModel;
  private readonly operations = new SerialTaskQueue<LocalTmdSession>();
  private persistedBytesValue: Uint8Array;
  private diskBytesValue: Uint8Array | undefined;
  private editingLockCount = 0;
  private readonly persistedTextAttachments = new Map<string, string>();

  private constructor(
    readonly documentPath: string,
    inspection: DocumentInspection,
    persistedBytes: Uint8Array,
    diskBytes: Uint8Array | undefined,
    private readonly clientFactory: TmdCliClientFactory,
  ) {
    this.model = new TanuMarkdownModel(inspection);
    this.persistedBytesValue = persistedBytes;
    this.diskBytesValue = diskBytes;
  }

  static async open(
    documentPath: string,
    retainedSourcePath: string,
    diskBytes: Uint8Array | undefined,
    clientFactory: TmdCliClientFactory,
  ): Promise<LocalTmdSession> {
    ensureTmdPath(documentPath);
    ensureTmdPath(retainedSourcePath);
    const persistedBytes =
      retainedSourcePath === documentPath && diskBytes !== undefined
        ? diskBytes
        : await fs.readFile(retainedSourcePath);
    const inspection = await inspectRetainedBytes(
      clientFactory(),
      retainedSourcePath,
      persistedBytes,
    );
    return LocalTmdSession.create(
      documentPath,
      inspection,
      persistedBytes,
      diskBytes,
      clientFactory,
    );
  }

  /** Construct a session from an already inspected retained snapshot. */
  static create(
    documentPath: string,
    inspection: DocumentInspection,
    persistedBytes: Uint8Array,
    diskBytes: Uint8Array | undefined,
    clientFactory: TmdCliClientFactory,
  ): LocalTmdSession {
    ensureTmdPath(documentPath);
    return new LocalTmdSession(
      documentPath,
      inspection,
      persistedBytes,
      diskBytes,
      clientFactory,
    );
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

  get editingLocked(): boolean {
    return this.editingLockCount > 0;
  }

  get persistedBytes(): Uint8Array {
    return this.persistedBytesValue;
  }

  snapshot(): EditorState {
    return this.model.snapshot();
  }

  apply(operation: TmdSessionOperation): AppliedSessionOperation {
    if (this.editingLocked) {
      throw new Error("The TMD session is temporarily locked by another operation.");
    }
    const before = this.snapshot();
    const after = operation.state;
    const changed = !sameEditorStates(before, after);
    if (changed) this.model.applyState(after);
    return {
      before,
      after,
      changed,
      contentRevision: this.contentRevision,
    };
  }

  /**
   * Prevent surface edits around a container operation. The returned release
   * function is idempotent and overlapping locks remain active independently.
   */
  acquireEditingLock(): () => void {
    this.editingLockCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.editingLockCount -= 1;
    };
  }

  async save(): Promise<void> {
    await this.operations.run(this, async () => {
      const state = this.snapshot();
      const savedRevision = this.contentRevision;
      const client = this.clientFactory();
      await this.saveRetainedState(client, documentUpdate(this, state));
      const { inspection, persistedBytes } = await readAndInspectDocument(
        client,
        this.documentPath,
      );
      this.replacePersistedBytes(persistedBytes);
      this.model.applyPersistedInspection(inspection, savedRevision);
    });
  }

  async saveAs(destination: string): Promise<void> {
    ensureTmdPath(destination);
    await this.operations.run(this, async () => {
      const client = this.clientFactory();
      let expectedDestinationState = diskState(await readOptionalFile(destination));
      const maxPublishAttempts = 3;
      for (
        let publishAttempt = 0;
        publishAttempt < maxPublishAttempts;
        publishAttempt += 1
      ) {
        const stagingDirectory = await fs.mkdtemp(
          path.join(path.dirname(destination), ".tmd-save-"),
        );
        const sourcePath = path.join(stagingDirectory, "source.tmd");
        let stagedRevision = this.contentRevision;
        try {
          await fs.writeFile(sourcePath, this.persistedBytes, { flag: "wx" });
          await persistLatestEditorState(this, async (state) => {
            await client.update(sourcePath, documentUpdate(this, state));
          });
          stagedRevision = this.contentRevision;
          const publishedState = diskState(await fs.readFile(sourcePath));
          await client.publish(sourcePath, destination, expectedDestinationState);
          expectedDestinationState = publishedState;
        } finally {
          await fs.rm(stagingDirectory, { force: true, recursive: true });
        }
        if (this.contentRevision === stagedRevision) return;
      }
      throw new Error(
        "The document kept changing while it was being saved; pause editing and retry.",
      );
    });
  }

  async revert(): Promise<void> {
    await this.operations.run(this, async () => {
      const revertedRevision = this.contentRevision;
      const { inspection, persistedBytes } = await readAndInspectDocument(
        this.clientFactory(),
        this.documentPath,
      );
      this.replacePersistedBytes(persistedBytes);
      if (!this.model.replaceInspectionIfCurrent(inspection, revertedRevision)) {
        throw new Error(
          "The document changed while revert was loading; edits were preserved and revert was cancelled.",
        );
      }
    });
  }

  async backup(destination: string): Promise<void> {
    await this.operations.run(this, async () => {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const client = this.clientFactory();
      await persistRetainedDocument(
        this,
        async (bytes) => fs.writeFile(destination, bytes),
        async (state) => {
          await client.update(destination, documentUpdate(this, state));
        },
      );
    });
  }

  async validate(): Promise<ValidationReport> {
    return this.operations.run(this, async () => {
      const validatedRevision = this.contentRevision;
      this.requirePersistedRevision("validate");
      const report = await this.clientFactory().validate(this.documentPath);
      if (!this.model.applyValidation(report, validatedRevision)) {
        throw new Error(
          "The document changed while validation was running; save and validate again.",
        );
      }
      return report;
    });
  }

  async addAttachment(source: string, logicalPath: string): Promise<void> {
    await this.operations.run(this, async () => {
      this.requirePersistedRevision("add the attachment");
      const persistedRevision = this.contentRevision;
      await this.clientFactory().addAttachment(
        this.documentPath,
        source,
        logicalPath,
      );
      await this.reloadAfterExternalChange(persistedRevision);
    });
  }

  async removeAttachment(logicalPath: string): Promise<void> {
    await this.operations.run(this, async () => {
      this.requirePersistedRevision("remove the attachment");
      const persistedRevision = this.contentRevision;
      await this.clientFactory().removeAttachment(this.documentPath, logicalPath);
      await this.reloadAfterExternalChange(persistedRevision);
    });
  }

  async exportHtml(
    output: string,
    selfContained: boolean,
    expectedOutputState: string,
  ): Promise<void> {
    await this.operations.run(this, async () => {
      this.requirePersistedRevision("export");
      await this.clientFactory().exportHtml(
        this.documentPath,
        output,
        selfContained,
        expectedOutputState,
      );
    });
  }

  async preview(state: EditorState = this.snapshot()): Promise<string> {
    try {
      return await previewRetainedBytes(
        this.clientFactory(),
        this.documentPath,
        this.persistedBytes,
        state.markdown,
        extrasWithDataSources(
          this.inspection.manifest.extras,
          state.dataSources,
        ),
        state.textAttachmentEdits,
        state.databaseEdits,
      );
    } catch (error) {
      return renderPreviewFallback(state.markdown, error);
    }
  }

  async dataSourceTable(
    source: string,
    state: EditorState = this.snapshot(),
  ): Promise<DataSourceTable> {
    return dataSourceTableFromRetainedBytes(
      this.clientFactory(),
      this.documentPath,
      this.persistedBytes,
      source,
      extrasWithDataSources(
        this.inspection.manifest.extras,
        state.dataSources,
      ),
      state.textAttachmentEdits,
      state.databaseEdits,
    );
  }

  async textAttachment(
    logicalPath: string,
    state: EditorState = this.snapshot(),
  ): Promise<TextAttachmentView> {
    const edit = state.textAttachmentEdits.find(
      (candidate) => candidate.logicalPath === logicalPath,
    );
    if (edit) return { ...edit };
    return {
      logicalPath,
      text: await this.persistedTextAttachment(logicalPath),
    };
  }

  async stateWithTextAttachmentEdit(
    state: EditorState,
    logicalPath: string,
    text: string,
  ): Promise<EditorState> {
    const persistedText = await this.persistedTextAttachment(logicalPath);
    const textAttachmentEdits = state.textAttachmentEdits
      .filter((edit) => edit.logicalPath !== logicalPath)
      .map((edit) => ({ ...edit }));
    if (text !== persistedText) {
      textAttachmentEdits.push({ logicalPath, text });
      textAttachmentEdits.sort((left, right) =>
        left.logicalPath.localeCompare(right.logicalPath),
      );
    }
    return { ...state, textAttachmentEdits };
  }

  private async reloadAfterExternalChange(persistedRevision: number): Promise<void> {
    const { inspection, persistedBytes } = await readAndInspectDocument(
      this.clientFactory(),
      this.documentPath,
    );
    this.replacePersistedBytes(persistedBytes);
    this.model.applyPersistedInspection(inspection, persistedRevision);
  }

  private async saveRetainedState(
    client: TmdCliClient,
    update: DocumentUpdate,
  ): Promise<void> {
    const stagingPath = path.join(
      path.dirname(this.documentPath),
      `.tmd-save-${randomBytes(16).toString("hex")}.tmd`,
    );
    let stagingCreated = false;
    try {
      await fs.writeFile(stagingPath, this.persistedBytes, { flag: "wx" });
      stagingCreated = true;
      await client.update(stagingPath, update);
      const publishedBytes = await fs.readFile(stagingPath);
      try {
        await client.publish(
          stagingPath,
          this.documentPath,
          diskState(this.diskBytesValue),
        );
      } catch (error) {
        const currentBytes = await readOptionalFile(this.documentPath);
        if (diskState(currentBytes) !== diskState(publishedBytes)) throw error;
      }
      this.replacePersistedBytes(publishedBytes);
    } finally {
      if (stagingCreated) await fs.rm(stagingPath, { force: true });
    }
  }

  private replacePersistedBytes(bytes: Uint8Array): void {
    this.persistedBytesValue = bytes;
    this.diskBytesValue = bytes;
    this.persistedTextAttachments.clear();
  }

  private async persistedTextAttachment(logicalPath: string): Promise<string> {
    const cached = this.persistedTextAttachments.get(logicalPath);
    if (cached !== undefined) return cached;
    const attachment = await textAttachmentFromRetainedBytes(
      this.clientFactory(),
      this.documentPath,
      this.persistedBytes,
      logicalPath,
    );
    this.persistedTextAttachments.set(logicalPath, attachment.text);
    return attachment.text;
  }

  private requirePersistedRevision(operation: string): void {
    if (!this.isCurrentRevisionPersisted) {
      throw new Error(
        `The latest editor revision has not reached disk; save and ${operation} again.`,
      );
    }
  }
}

export async function readOptionalFile(
  filePath: string,
): Promise<Uint8Array | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function diskState(bytes: Uint8Array | undefined): string {
  return bytes
    ? createHash("sha256").update(bytes).digest("hex")
    : "missing";
}

function documentUpdate(
  session: LocalTmdSession,
  state: EditorState,
): DocumentUpdate {
  return {
    schema_version: 1,
    markdown: state.markdown,
    title: state.title,
    extras: extrasWithDataSources(
      session.inspection.manifest.extras,
      state.dataSources,
    ),
    text_attachments: state.textAttachmentEdits.map((edit) => ({
      logical_path: edit.logicalPath,
      text: edit.text,
    })),
    database_edits: state.databaseEdits.map((edit) => ({
      source: edit.source,
      key: { ...edit.key },
      column: edit.column,
      value: { ...edit.value },
    })),
  };
}

function sameEditorStates(left: EditorState, right: EditorState): boolean {
  return (
    sameDataSources(left.dataSources, right.dataSources) &&
    sameDatabaseCellEdits(left.databaseEdits, right.databaseEdits) &&
    left.markdown === right.markdown &&
    sameTextAttachmentEdits(
      left.textAttachmentEdits,
      right.textAttachmentEdits,
    ) &&
    left.title === right.title
  );
}

function sameTextAttachmentEdits(
  left: readonly TextAttachmentEdit[],
  right: readonly TextAttachmentEdit[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (edit, index) =>
        edit.logicalPath === right[index]?.logicalPath &&
        edit.text === right[index]?.text,
    )
  );
}

async function inspectRetainedBytes(
  client: TmdCliClient,
  sourcePath: string,
  bytes: Uint8Array,
): Promise<DocumentInspection> {
  ensureTmdPath(sourcePath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tmd-open-"));
  const snapshotPath = path.join(directory, "snapshot.tmd");
  try {
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return await client.inspect(snapshotPath);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

async function previewRetainedBytes(
  client: TmdCliClient,
  sourcePath: string,
  bytes: Uint8Array,
  markdown: string,
  extras: DocumentInspection["manifest"]["extras"],
  textAttachments: readonly TextAttachmentEdit[],
  databaseEdits: EditorState["databaseEdits"],
): Promise<string> {
  ensureTmdPath(sourcePath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tmd-preview-"));
  const snapshotPath = path.join(directory, "snapshot.tmd");
  try {
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return await client.preview(
      snapshotPath,
      markdown,
      extras,
      textAttachments,
      databaseEdits,
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

async function dataSourceTableFromRetainedBytes(
  client: TmdCliClient,
  sourcePath: string,
  bytes: Uint8Array,
  source: string,
  extras: DocumentInspection["manifest"]["extras"],
  textAttachments: readonly TextAttachmentEdit[],
  databaseEdits: EditorState["databaseEdits"],
): Promise<DataSourceTable> {
  ensureTmdPath(sourcePath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tmd-data-source-"));
  const snapshotPath = path.join(directory, "snapshot.tmd");
  try {
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return await client.dataSource(
      snapshotPath,
      source,
      extras,
      textAttachments,
      databaseEdits,
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

async function textAttachmentFromRetainedBytes(
  client: TmdCliClient,
  sourcePath: string,
  bytes: Uint8Array,
  logicalPath: string,
): Promise<TextAttachmentView> {
  ensureTmdPath(sourcePath);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tmd-text-attachment-"));
  const snapshotPath = path.join(directory, "snapshot.tmd");
  try {
    await fs.writeFile(snapshotPath, bytes, { flag: "wx" });
    return await client.textAttachment(snapshotPath, logicalPath);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

async function readAndInspectDocument(
  client: TmdCliClient,
  sourcePath: string,
): Promise<{ inspection: DocumentInspection; persistedBytes: Uint8Array }> {
  const persistedBytes = await fs.readFile(sourcePath);
  const inspection = await inspectRetainedBytes(client, sourcePath, persistedBytes);
  return { inspection, persistedBytes };
}

function ensureTmdPath(filePath: string): void {
  if (path.extname(filePath).toLowerCase() !== ".tmd") {
    throw new Error("TMD documents must use the .tmd extension.");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
