export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DataViewRenderKind = "scalar" | "table" | "list" | "code";

export interface QueryFormulaDataSource {
  name: string;
  type: "formula";
  query: string;
  edit?: SqliteEditDefinition;
}

export interface SqliteEditDefinition {
  table: string;
  keySourceColumn: string;
  keyTableColumn: string;
  columns: Array<{
    sourceColumn: string;
    tableColumn: string;
  }>;
}

export interface RhaiDataSourceInput {
  alias: string;
  source: string;
}

export interface RhaiDataSource {
  name: string;
  type: "rhai";
  script: string;
  inputs: RhaiDataSourceInput[];
  outputColumns: string[];
}

export interface ComputedFormulaDataSource {
  name: string;
  type: "formula";
  input: string;
  program: string;
  outputColumns: string[];
}

export type ManagedCellConstraint = "any" | "text" | "number" | "boolean";

export interface ManagedFormulaColumn {
  id: string;
  name: string;
  constraint: ManagedCellConstraint;
  /** Storage-only column omitted from evaluated table output. Hidden columns form a trailing suffix. */
  hidden?: boolean;
  reference?: {
    source: string;
    columnId: string;
  };
}

export type ManagedFormulaCellContent =
  | { kind: "literal"; value: DataTableCell }
  | { kind: "formula"; expression: string };

export interface ManagedFormulaCell {
  content: ManagedFormulaCellContent;
  /** An explicit cell constraint. Omit to inherit the column constraint. */
  constraint?: ManagedCellConstraint;
}

export interface ManagedFormulaRow {
  id: string;
  cells: ManagedFormulaCell[];
}

export interface ManagedFormulaDataSource {
  name: string;
  type: "formula";
  columns: ManagedFormulaColumn[];
  rows: ManagedFormulaRow[];
}

export type FormulaDataSource =
  | QueryFormulaDataSource
  | ComputedFormulaDataSource
  | ManagedFormulaDataSource;

export type DataSource = FormulaDataSource | RhaiDataSource;

export type DataTableCell =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "integer"; value: string }
  | { type: "real"; value: number }
  | { type: "string"; value: string };

export interface DataSourceTable {
  source: string;
  kind: "table";
  columns: string[];
  rows: DataTableCell[][];
  /** Shape of the query input before computed Formula rows/columns are added. */
  inputRowCount?: number;
  inputColumnCount?: number;
  editable?: DataSourceTableEditInfo;
}

export interface DataSourceTableEditInfo {
  inputSource: string;
  keyColumn: string;
  editableColumns: string[];
  rowKeys: DataTableCell[];
  inputRows: DataTableCell[][];
}

export interface DatabaseCellEdit {
  source: string;
  key: DataTableCell;
  column: string;
  value: DataTableCell;
}

export interface TextAttachmentEdit {
  logicalPath: string;
  text: string;
}

export interface TextAttachmentView extends TextAttachmentEdit {}

export interface DataSourceRegistryView {
  editable: boolean;
  schemaVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  sources: DataSource[];
  issue?: string;
  rawRegistry?: string;
}

export interface AttachmentMetadata {
  id: string;
  logical_path: string;
  mime: string;
  length: number;
  sha256?: string | null;
  title?: string | null;
  alt?: string | null;
}

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  attachment_references: Array<{
    logical_path: string;
    resolved: boolean;
  }>;
  data_view_references?: Array<{
    source: string;
    render: DataViewRenderKind;
    resolved: boolean;
  }>;
  database_user_version: number;
}

export interface DocumentInspection {
  schema_version: 1;
  format: "tmd";
  markdown: string;
  manifest: {
    title?: string | null;
    authors: string[];
    tags: string[];
    db_schema_version?: number | null;
    extras: JsonValue;
    [key: string]: unknown;
  };
  attachments: AttachmentMetadata[];
  database_user_version: number;
  database: {
    user_version: number;
    objects: Array<{
      type: string;
      name: string;
      sql?: string | null;
    }>;
  };
  validation: ValidationReport;
}

export interface DocumentUpdate {
  schema_version: 1;
  markdown: string;
  title: string;
  extras: JsonValue;
  text_attachments?: Array<{
    logical_path: string;
    text: string;
  }>;
  database_edits?: Array<{
    source: string;
    key: DataTableCell;
    column: string;
    value: DataTableCell;
  }>;
}
