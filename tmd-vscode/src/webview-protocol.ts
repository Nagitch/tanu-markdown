import type {
  DataSource,
  DataSourceRegistryView,
  DataSourceTable,
  DatabaseCellEdit,
  DocumentInspection,
  TextAttachmentView,
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
      type: "editSpreadsheet";
      clientRevision: number;
      source: string;
      formulaProgram: string;
      databaseEdits: DatabaseCellEdit[];
    }
  | {
      type: "preview";
      clientRevision: number;
      markdown: string;
    }
  | {
      type: "dataSourceTable";
      clientRevision: number;
      requestId: number;
      source: string;
    }
  | {
      type: "rhaiScript";
      clientRevision: number;
      requestId: number;
      source: string;
    }
  | {
      type: "editRhaiScript";
      clientRevision: number;
      source: string;
      logicalPath: string;
      text: string;
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

export interface EditorDataSourceTableMessage {
  type: "dataSourceTable";
  clientRevision: number;
  contentRevision: number;
  requestId: number;
  source: string;
  table?: DataSourceTable;
  issue?: string;
}

export interface EditorRhaiScriptMessage {
  type: "rhaiScript";
  clientRevision: number;
  contentRevision: number;
  requestId: number;
  source: string;
  script?: TextAttachmentView;
  issue?: string;
}

/** Messages emitted by the VS Code host bridge to an editor surface. */
export type EditorHostMessage =
  | EditorModelMessage
  | EditorAcknowledgementMessage
  | EditorPreviewMessage
  | EditorDataSourceTableMessage
  | EditorRhaiScriptMessage;

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
    "editSpreadsheet",
    "preview",
    "dataSourceTable",
    "rhaiScript",
    "editRhaiScript",
    "validate",
    "addAttachment",
    "removeAttachment",
    "exportHtml",
  ].includes(value.type);
}
