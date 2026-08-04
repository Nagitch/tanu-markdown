export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DataViewRenderKind = "scalar" | "table" | "list" | "code";

export interface SqliteDataSource {
  name: string;
  type: "sqlite";
  query: string;
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

export type DataSource = SqliteDataSource | RhaiDataSource;

export interface DataSourceRegistryView {
  editable: boolean;
  schemaVersion?: 1 | 2;
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
}
