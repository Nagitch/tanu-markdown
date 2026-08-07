import { spawn } from "node:child_process";
import type {
  DataSourceTable,
  DataTableCell,
  DatabaseCellEdit,
  DocumentInspection,
  DocumentUpdate,
  JsonValue,
  TextAttachmentEdit,
  TextAttachmentView,
  ValidationReport,
} from "./types.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export type CliErrorKind =
  | "command"
  | "incompatible-schema"
  | "invalid-output"
  | "missing-executable"
  | "output-limit"
  | "start-failed"
  | "timeout";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly kind: CliErrorKind = "command",
  ) {
    super(message);
    this.name = "CliError";
  }
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PreviewResponse {
  schema_version: number;
  preview_html: string;
}

interface DataSourceResponse {
  schema_version: number;
  source: string;
  kind: "table";
  columns: string[];
  rows: DataTableCell[][];
  editable?: unknown;
}

interface TextAttachmentResponse {
  schema_version: number;
  logical_path: string;
  text: string;
}

export class TmdCliClient {
  constructor(
    private readonly executable: string,
    private readonly timeoutMs: number,
    private readonly prefixArguments: readonly string[] = [],
  ) {}

  async inspect(path: string): Promise<DocumentInspection> {
    const inspection = await this.runJson<DocumentInspection>(["inspect", path, "--json"]);
    return this.assertInspectionSchema(inspection);
  }

  async update(path: string, update: DocumentUpdate): Promise<DocumentInspection> {
    const inspection = await this.runJson<DocumentInspection>(
      ["update", path, "--json-stdin"],
      update,
    );
    return this.assertInspectionSchema(inspection);
  }

  async preview(
    path: string,
    markdown: string,
    extras: JsonValue,
    textAttachments: readonly TextAttachmentEdit[] = [],
    databaseEdits: readonly DatabaseCellEdit[] = [],
  ): Promise<string> {
    const preview = await this.runJson<PreviewResponse>(
      ["preview", path, "--json-stdin"],
      {
        schema_version: 1,
        markdown,
        extras,
        text_attachments: textAttachmentUpdates(textAttachments),
        database_edits: databaseEditUpdates(databaseEdits),
      },
    );
    if (preview.schema_version !== 1) {
      throw new CliError(
        `Unsupported TMD CLI preview schema_version ${String(preview.schema_version)}; expected 1.`,
        0,
        JSON.stringify(preview),
        "",
        "incompatible-schema",
      );
    }
    if (typeof preview.preview_html !== "string") {
      throw new CliError(
        "The TMD CLI preview response did not contain preview_html.",
        0,
        JSON.stringify(preview),
        "",
        "invalid-output",
      );
    }
    return preview.preview_html;
  }

  async dataSource(
    path: string,
    source: string,
    extras: JsonValue,
    textAttachments: readonly TextAttachmentEdit[] = [],
    databaseEdits: readonly DatabaseCellEdit[] = [],
  ): Promise<DataSourceTable> {
    const response = await this.runJson<DataSourceResponse>(
      ["data-source", path, "--json-stdin"],
      {
        schema_version: 1,
        source,
        extras,
        text_attachments: textAttachmentUpdates(textAttachments),
        database_edits: databaseEditUpdates(databaseEdits),
      },
    );
    if (response.schema_version !== 1) {
      throw new CliError(
        `Unsupported TMD CLI data-source schema_version ${String(response.schema_version)}; expected 1.`,
        0,
        JSON.stringify(response),
        "",
        "incompatible-schema",
      );
    }
    const editable = parseDataSourceTableEditInfo(response.editable);
    const table: DataSourceTable = {
      source: response.source,
      kind: response.kind,
      columns: response.columns,
      rows: response.rows,
      ...(editable ? { editable } : {}),
    };
    if (!isDataSourceTable(table) || response.source !== source) {
      throw new CliError(
        "The TMD CLI returned an invalid tabular data-source response.",
        0,
        JSON.stringify(response),
        "",
        "invalid-output",
      );
    }
    return table;
  }

  async textAttachment(
    path: string,
    logicalPath: string,
  ): Promise<TextAttachmentView> {
    const response = await this.runJson<TextAttachmentResponse>([
      "attachment",
      "text",
      path,
      "--path",
      logicalPath,
      "--json",
    ]);
    if (response.schema_version !== 1) {
      throw new CliError(
        `Unsupported TMD CLI text-attachment schema_version ${String(response.schema_version)}; expected 1.`,
        0,
        JSON.stringify(response),
        "",
        "incompatible-schema",
      );
    }
    if (
      response.logical_path !== logicalPath ||
      typeof response.text !== "string"
    ) {
      throw new CliError(
        "The TMD CLI returned an invalid text-attachment response.",
        0,
        JSON.stringify(response),
        "",
        "invalid-output",
      );
    }
    return { logicalPath: response.logical_path, text: response.text };
  }

  async validate(path: string): Promise<ValidationReport> {
    const result = await this.execute(["validate", path, "--json"], undefined, true);
    const parsed = this.parseJson<ValidationReport & { schema_version?: number }>(
      result.stdout,
      "validation",
    );
    if (parsed.schema_version !== 1) {
      throw new CliError(
        `Unsupported TMD CLI validation schema_version ${String(parsed.schema_version)}; expected 1.`,
        result.exitCode,
        result.stdout,
        result.stderr,
        "incompatible-schema",
      );
    }
    if (result.exitCode !== 0 && parsed.valid) {
      throw this.commandError(["validate", path, "--json"], result);
    }
    return parsed;
  }

  async newDocument(path: string, title?: string): Promise<void> {
    const arguments_ = ["new", path];
    if (title) {
      arguments_.push("--title", title);
    }
    await this.execute(arguments_);
  }

  async publish(
    input: string,
    output: string,
    expectedOutputState?: string,
  ): Promise<void> {
    const arguments_ = ["publish", input, output];
    if (expectedOutputState !== undefined) {
      arguments_.push("--expected-output-state", expectedOutputState);
    }
    await this.execute(arguments_);
  }

  async addAttachment(
    document: string,
    source: string,
    logicalPath: string,
    mime?: string,
  ): Promise<void> {
    const arguments_ = ["attachment", "add", document, source, "--path", logicalPath];
    if (mime) {
      arguments_.push("--mime", mime);
    }
    await this.execute(arguments_);
  }

  async removeAttachment(document: string, logicalPath: string): Promise<void> {
    await this.execute(["attachment", "remove", document, "--path", logicalPath]);
  }

  async exportHtml(
    document: string,
    output: string,
    selfContained: boolean,
    expectedOutputState?: string,
  ): Promise<void> {
    const arguments_ = ["export-html", document, output];
    if (selfContained) {
      arguments_.push("--self-contained");
    }
    if (expectedOutputState !== undefined) {
      arguments_.push("--expected-output-state", expectedOutputState);
    }
    await this.execute(arguments_);
  }

  private async runJson<T>(arguments_: string[], input?: unknown): Promise<T> {
    const stdin = input === undefined ? undefined : JSON.stringify(input);
    const result = await this.execute(arguments_, stdin);
    return this.parseJson<T>(result.stdout, arguments_[0] ?? "command");
  }

  private parseJson<T>(stdout: string, operation: string): T {
    try {
      return JSON.parse(stdout) as T;
    } catch (error) {
      throw new CliError(
        `The TMD CLI returned invalid JSON for ${operation}: ${error instanceof Error ? error.message : String(error)}`,
        0,
        stdout,
        "",
        "invalid-output",
      );
    }
  }

  private assertInspectionSchema(inspection: DocumentInspection): DocumentInspection {
    if (inspection.schema_version !== 1) {
      throw new CliError(
        `Unsupported TMD CLI inspection schema_version ${String(inspection.schema_version)}; expected 1.`,
        0,
        JSON.stringify(inspection),
        "",
        "incompatible-schema",
      );
    }
    return inspection;
  }

  private execute(
    arguments_: string[],
    stdin?: string,
    allowNonZero = false,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const completeArguments = [...this.prefixArguments, ...arguments_];
      const child = spawn(this.executable, completeArguments, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminationError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const rejectOnce = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const terminateAfterClose = (error: Error) => {
        if (terminationError || settled) {
          return;
        }
        terminationError = error;
        child.kill();
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      };
      const timer = setTimeout(() => {
        terminateAfterClose(
          new CliError(
            `TMD CLI timed out after ${this.timeoutMs} ms. Increase tanuMarkdown.timeoutMs if the document is unusually large.`,
            null,
            stdout,
            stderr,
            "timeout",
          ),
        );
      }, this.timeoutMs);

      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (terminationError) {
          return;
        }
        const hint =
          error.code === "ENOENT"
            ? ` Install a compatible TMD CLI or configure tanuMarkdown.cliPath.`
            : "";
        terminationError = new CliError(
          `Could not start TMD CLI \`${this.executable}\`: ${error.message}.${hint}`,
          null,
          stdout,
          stderr,
          error.code === "ENOENT" ? "missing-executable" : "start-failed",
        );
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_BYTES) {
          terminateAfterClose(
            new CliError(
              "TMD CLI output exceeded the 16 MiB safety limit.",
              null,
              stdout,
              stderr,
              "output-limit",
            ),
          );
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > MAX_OUTPUT_BYTES) {
          terminateAfterClose(
            new CliError(
              "TMD CLI error output exceeded the 16 MiB safety limit.",
              null,
              stdout,
              stderr,
              "output-limit",
            ),
          );
        }
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        if (settled) {
          return;
        }
        if (terminationError) {
          rejectOnce(terminationError);
          return;
        }
        settled = true;
        const result = { exitCode: exitCode ?? -1, stdout, stderr };
        if (result.exitCode !== 0 && !allowNonZero) {
          reject(this.commandError(arguments_, result));
        } else {
          resolve(result);
        }
      });

      if (stdin !== undefined) {
        child.stdin.end(stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  private commandError(arguments_: string[], result: ProcessResult): CliError {
    const detail = result.stderr.trim() || result.stdout.trim() || "no diagnostic output";
    return new CliError(
      `TMD CLI command \`${arguments_[0] ?? "unknown"}\` failed (exit ${result.exitCode}): ${detail}`,
      result.exitCode,
      result.stdout,
      result.stderr,
    );
  }
}

function textAttachmentUpdates(
  edits: readonly TextAttachmentEdit[],
): Array<{ logical_path: string; text: string }> {
  return edits.map((edit) => ({
    logical_path: edit.logicalPath,
    text: edit.text,
  }));
}

function databaseEditUpdates(
  edits: readonly DatabaseCellEdit[],
): DatabaseCellEdit[] {
  return edits.map((edit) => ({
    source: edit.source,
    key: { ...edit.key },
    column: edit.column,
    value: { ...edit.value },
  }));
}

function parseDataSourceTableEditInfo(
  value: unknown,
): DataSourceTable["editable"] {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "object" ||
    !("input_source" in value) ||
    typeof value.input_source !== "string" ||
    !("key_column" in value) ||
    typeof value.key_column !== "string" ||
    !("editable_columns" in value) ||
    !Array.isArray(value.editable_columns) ||
    !value.editable_columns.every((column) => typeof column === "string") ||
    !("row_keys" in value) ||
    !Array.isArray(value.row_keys) ||
    !value.row_keys.every(isDataTableCell) ||
    !("input_rows" in value) ||
    !Array.isArray(value.input_rows) ||
    !value.input_rows.every(
      (row) => Array.isArray(row) && row.every(isDataTableCell),
    ) ||
    value.row_keys.length !== value.input_rows.length
  ) {
    throw new CliError(
      "The TMD CLI returned invalid editable table metadata.",
      0,
      JSON.stringify(value),
      "",
      "invalid-output",
    );
  }
  const inputWidth = value.input_rows[0]?.length;
  if (
    inputWidth !== undefined &&
    !value.input_rows.every((row) => row.length === inputWidth)
  ) {
    throw new CliError(
      "The TMD CLI returned inconsistent editable input rows.",
      0,
      JSON.stringify(value),
      "",
      "invalid-output",
    );
  }
  return {
    inputSource: value.input_source,
    keyColumn: value.key_column,
    editableColumns: [...value.editable_columns],
    rowKeys: value.row_keys.map((cell) => ({ ...cell })),
    inputRows: value.input_rows.map((row) =>
      row.map((cell) => ({ ...cell })),
    ),
  };
}

function isDataSourceTable(value: unknown): value is DataSourceTable {
  if (
    typeof value !== "object" ||
    value === null ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("kind" in value) ||
    value.kind !== "table" ||
    !("columns" in value) ||
    !Array.isArray(value.columns) ||
    !value.columns.every((column) => typeof column === "string") ||
    !("rows" in value) ||
    !Array.isArray(value.rows)
  ) {
    return false;
  }
  const columnCount = value.columns.length;
  return value.rows.every(
    (row) =>
      Array.isArray(row) &&
      row.length === columnCount &&
      row.every(isDataTableCell),
  );
}

function isDataTableCell(value: unknown): value is DataTableCell {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  if (value.type === "null") return true;
  if (!("value" in value)) return false;
  switch (value.type) {
    case "boolean":
      return typeof value.value === "boolean";
    case "integer":
      return typeof value.value === "string" && /^-?\d+$/.test(value.value);
    case "real":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "string":
      return typeof value.value === "string";
    default:
      return false;
  }
}
