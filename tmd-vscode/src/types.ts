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
}
