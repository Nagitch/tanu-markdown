import { spawn } from "node:child_process";
import type { DocumentInspection, DocumentUpdate, ValidationReport } from "./types.js";

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

  async preview(path: string, markdown: string): Promise<string> {
    const preview = await this.runJson<PreviewResponse>(
      ["preview", path, "--json-stdin"],
      { schema_version: 1, markdown },
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
