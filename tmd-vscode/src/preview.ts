import { CliError } from "./cli.js";
import { renderSafeMarkdownFallback } from "./markdown.js";

const MAX_DIAGNOSTIC_CHARACTERS = 2_000;

/** Render a visible, safe fallback when the CLI-backed preview cannot run. */
export function renderPreviewFallback(markdown: string, error: unknown): string {
  return renderSafeMarkdownFallback(
    markdown,
    previewFailureReason(error),
    boundedDiagnostic(error),
  );
}

function previewFailureReason(error: unknown): string {
  if (!(error instanceof CliError)) {
    return "The TMD CLI preview failed unexpectedly.";
  }

  switch (error.kind) {
    case "missing-executable":
      return "The TMD CLI executable could not be found.";
    case "incompatible-schema":
      return "The selected TMD CLI uses an incompatible preview schema and must be updated.";
    case "timeout":
      return "The TMD CLI preview timed out.";
    case "command":
      return unsupportedPreviewCommand(error)
        ? "The selected TMD CLI does not support dynamic preview and must be updated."
        : "The TMD CLI could not render this dynamic preview.";
    case "invalid-output":
      return "The selected TMD CLI returned an invalid preview response and may be outdated.";
    case "output-limit":
      return "The TMD CLI preview exceeded its output safety limit.";
    case "start-failed":
      return "The selected TMD CLI could not be started.";
  }
}

function unsupportedPreviewCommand(error: CliError): boolean {
  const output = `${error.message}\n${error.stderr}\n${error.stdout}`.toLowerCase();
  return (
    output.includes("unrecognized subcommand") ||
    output.includes("unknown subcommand") ||
    output.includes("unknown command")
  );
}

function boundedDiagnostic(error: unknown): string {
  const diagnostic = error instanceof Error ? error.message : String(error);
  if (diagnostic.length <= MAX_DIAGNOSTIC_CHARACTERS) {
    return diagnostic;
  }
  return `${diagnostic.slice(0, MAX_DIAGNOSTIC_CHARACTERS)}…`;
}
