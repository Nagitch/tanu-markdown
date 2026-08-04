import {
  extrasWithDataSources,
  inspectDataSourceRegistry,
  sameDataSources,
} from "./data-sources.js";
import type {
  DataSource,
  DocumentInspection,
  ValidationReport,
} from "./types.js";

export interface EditorState {
  dataSources: DataSource[];
  markdown: string;
  title: string;
}

export class TanuMarkdownModel {
  private contentRevisionValue = 0;
  private persistedRevisionValue = 0;
  private validationRevisionValue = 0;
  private persistedStateValue: EditorState;

  constructor(private inspectionValue: DocumentInspection) {
    this.persistedStateValue = this.snapshot();
  }

  get inspection(): DocumentInspection {
    return this.inspectionValue;
  }

  get contentRevision(): number {
    return this.contentRevisionValue;
  }

  get persistedRevision(): number {
    return this.persistedRevisionValue;
  }

  get isCurrentRevisionPersisted(): boolean {
    return this.persistedRevisionValue === this.contentRevisionValue;
  }

  get isValidationCurrent(): boolean {
    return this.validationRevisionValue === this.contentRevisionValue;
  }

  snapshot(): EditorState {
    return {
      dataSources: inspectDataSourceRegistry(this.inspectionValue.manifest.extras).sources,
      markdown: this.inspectionValue.markdown,
      title: this.inspectionValue.manifest.title ?? "",
    };
  }

  applyState(state: EditorState): void {
    this.setState(state);
    this.contentRevisionValue += 1;
    if (sameEditorState(state, this.persistedStateValue)) {
      this.persistedRevisionValue = this.contentRevisionValue;
    }
  }

  replaceInspectionIfCurrent(
    inspection: DocumentInspection,
    expectedRevision: number,
  ): boolean {
    if (this.contentRevisionValue !== expectedRevision) {
      return false;
    }
    this.inspectionValue = inspection;
    this.contentRevisionValue += 1;
    this.persistedRevisionValue = this.contentRevisionValue;
    this.validationRevisionValue = this.contentRevisionValue;
    this.persistedStateValue = this.snapshot();
    return true;
  }

  applyPersistedInspection(
    inspection: DocumentInspection,
    persistedRevision: number,
  ): void {
    if (this.replaceInspectionIfCurrent(inspection, persistedRevision)) {
      return;
    }

    const currentState = this.snapshot();
    this.inspectionValue = inspection;
    this.persistedStateValue = this.snapshot();
    this.setState(currentState);
    const currentMatchesPersisted = sameEditorState(
      currentState,
      this.persistedStateValue,
    );
    this.persistedRevisionValue = currentMatchesPersisted
      ? this.contentRevisionValue
      : persistedRevision;
    this.validationRevisionValue = currentMatchesPersisted
      ? this.contentRevisionValue
      : persistedRevision;
  }

  applyValidation(report: ValidationReport, validatedRevision: number): boolean {
    if (this.contentRevisionValue !== validatedRevision) {
      return false;
    }
    this.inspectionValue.validation = report;
    this.validationRevisionValue = validatedRevision;
    return true;
  }

  private setState(state: EditorState): void {
    this.inspectionValue.manifest.extras = extrasWithDataSources(
      this.inspectionValue.manifest.extras,
      state.dataSources,
    );
    this.inspectionValue.markdown = state.markdown;
    this.inspectionValue.manifest.title = state.title || null;
  }
}

function sameEditorState(left: EditorState, right: EditorState): boolean {
  return (
    sameDataSources(left.dataSources, right.dataSources) &&
    left.markdown === right.markdown &&
    left.title === right.title
  );
}

export interface RevisionedEditorState {
  readonly contentRevision: number;
  snapshot(): EditorState;
}

export interface RetainedEditorState extends RevisionedEditorState {
  readonly persistedBytes: Uint8Array;
}

export async function persistRetainedDocument(
  source: RetainedEditorState,
  writeBase: (bytes: Uint8Array) => Promise<void>,
  persist: (state: EditorState) => Promise<void>,
): Promise<void> {
  await writeBase(source.persistedBytes);
  await persistLatestEditorState(source, persist);
}

export async function persistLatestEditorState(
  source: RevisionedEditorState,
  persist: (state: EditorState) => Promise<void>,
  maxAttempts = 3,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = source.snapshot();
    const revision = source.contentRevision;
    await persist(state);
    if (source.contentRevision === revision) {
      return;
    }
  }
  throw new Error(
    "The document kept changing while it was being saved; pause editing and retry.",
  );
}
