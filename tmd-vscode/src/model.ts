import type { DocumentInspection, ValidationReport } from "./types.js";

export interface EditorState {
  markdown: string;
  title: string;
}

export class TanuMarkdownModel {
  private contentRevisionValue = 0;
  private persistedRevisionValue = 0;
  private validationRevisionValue = 0;

  constructor(private inspectionValue: DocumentInspection) {}

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
      markdown: this.inspectionValue.markdown,
      title: this.inspectionValue.manifest.title ?? "",
    };
  }

  applyState(state: EditorState): void {
    this.setState(state);
    this.contentRevisionValue += 1;
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
    this.setState(currentState);
    this.persistedRevisionValue = persistedRevision;
    this.validationRevisionValue = persistedRevision;
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
    this.inspectionValue.markdown = state.markdown;
    this.inspectionValue.manifest.title = state.title || null;
  }
}

export interface RevisionedEditorState {
  readonly contentRevision: number;
  snapshot(): EditorState;
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
