import type {
  DataSource,
  DataSourceRegistryView,
  DocumentInspection,
} from "./types.js";

/** Messages emitted by the bundled editor web app. */
export type EditorRequest =
  | { type: "ready" }
  | {
      type: "edit";
      clientRevision: number;
      markdown: string;
      title: string;
    }
  | {
      type: "editDataSources";
      clientRevision: number;
      dataSources: DataSource[];
    }
  | {
      type: "preview";
      clientRevision: number;
      markdown: string;
    }
  | { type: "validate" }
  | { type: "addAttachment" }
  | { type: "removeAttachment"; logicalPath: string }
  | { type: "exportHtml" };

export interface EditorModelMessage {
  type: "model";
  acknowledgedClientRevision: number;
  contentRevision: number;
  inspection: DocumentInspection;
  validationCurrent: boolean;
  markdown: string;
  title: string;
  dataSourceRegistry: DataSourceRegistryView;
  previewHtml: string;
  editingLocked: boolean;
}

export interface EditorAcknowledgementMessage {
  type: "editAck";
  clientRevision: number;
  contentRevision: number;
}

export interface EditorPreviewMessage {
  type: "preview";
  clientRevision: number;
  contentRevision: number;
  previewHtml: string;
}

/** Messages emitted by the VS Code host bridge to an editor surface. */
export type EditorHostMessage =
  | EditorModelMessage
  | EditorAcknowledgementMessage
  | EditorPreviewMessage;

export function isEditorRequest(value: unknown): value is EditorRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  return [
    "ready",
    "edit",
    "editDataSources",
    "preview",
    "validate",
    "addAttachment",
    "removeAttachment",
    "exportHtml",
  ].includes(value.type);
}
