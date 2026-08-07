export interface RhaiSourceDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

/** Extract the source location used by Rhai syntax and runtime diagnostics. */
export function rhaiDiagnosticFromIssue(issue: string): RhaiSourceDiagnostic {
  const lineAndPosition = issue.match(
    /\(line\s+(\d+),\s*position\s+(\d+)\)/i,
  );
  if (lineAndPosition) {
    return {
      message: issue,
      line: Number(lineAndPosition[1]),
      column: Number(lineAndPosition[2]),
    };
  }
  const lineAndColumn = issue.match(/(?:at|line)\s+(\d+):(\d+)/i);
  return lineAndColumn
    ? {
        message: issue,
        line: Number(lineAndColumn[1]),
        column: Number(lineAndColumn[2]),
      }
    : { message: issue };
}
