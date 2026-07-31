import type { DocumentInspection } from "./types.js";

export interface EditorState {
  markdown: string;
  title: string;
}

export class TanuMarkdownModel {
  private contentRevisionValue = 0;

  constructor(private inspectionValue: DocumentInspection) {}

  get inspection(): DocumentInspection {
    return this.inspectionValue;
  }

  get contentRevision(): number {
    return this.contentRevisionValue;
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

  replaceInspection(inspection: DocumentInspection): void {
    this.inspectionValue = inspection;
    this.contentRevisionValue += 1;
  }

  applySavedInspection(inspection: DocumentInspection, savedRevision: number): void {
    if (this.contentRevisionValue === savedRevision) {
      this.replaceInspection(inspection);
      return;
    }

    const currentState = this.snapshot();
    this.inspectionValue = inspection;
    this.setState(currentState);
  }

  private setState(state: EditorState): void {
    this.inspectionValue.markdown = state.markdown;
    this.inspectionValue.manifest.title = state.title || null;
  }
}
