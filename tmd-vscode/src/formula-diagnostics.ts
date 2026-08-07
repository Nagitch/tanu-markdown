export interface FormulaSourceDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

/** Extract a Formula program source location from a bounded CLI diagnostic. */
export function formulaDiagnosticFromIssue(
  issue: string,
): FormulaSourceDiagnostic {
  const lineAndPosition = issue.match(
    /(?:\(|\b)line\s+(\d+),\s*(?:position|column)\s+(\d+)\)?/i,
  );
  if (lineAndPosition) {
    return {
      message: issue,
      line: Number(lineAndPosition[1]),
      column: Number(lineAndPosition[2]),
    };
  }
  const compactLocation = issue.match(/(?:at|line)\s+(\d+):(\d+)/i);
  return compactLocation
    ? {
        message: issue,
        line: Number(compactLocation[1]),
        column: Number(compactLocation[2]),
      }
    : { message: issue };
}

/** Map a one-based Unicode-scalar source column to a CodeMirror UTF-16 offset. */
export function formulaUtf16Offset(lineText: string, column: number): number {
  if (!Number.isSafeInteger(column) || column <= 1) return 0;
  return [...lineText].slice(0, column - 1).join("").length;
}
