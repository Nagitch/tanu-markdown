/** Convert a zero-based column index to its spreadsheet label. */
export function spreadsheetColumnName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Formula column indexes must be nonnegative safe integers.");
  }
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

/** Convert zero-based row and column indexes to an A1 cell reference. */
export function spreadsheetCellName(row: number, column: number): string {
  if (!Number.isSafeInteger(row) || row < 0) {
    throw new Error("Formula row indexes must be nonnegative safe integers.");
  }
  return `${spreadsheetColumnName(column)}${row + 1}`;
}

/** Return the expression assigned to a cell, without the assignment target. */
export function formulaExpressionForCell(
  program: string,
  row: number,
  column: number,
): string | undefined {
  const target = spreadsheetCellName(row, column);
  for (const line of program.split(/\r?\n/u)) {
    const assignment = parseAssignmentLine(line);
    if (assignment?.target === target) return assignment.expression;
  }
  return undefined;
}

/** Add, replace, or remove one cell assignment while preserving other lines. */
export function setFormulaCellExpression(
  program: string,
  row: number,
  column: number,
  expression: string | undefined,
): string {
  const target = spreadsheetCellName(row, column);
  const lineEnding = program.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingLineEnding = program.endsWith("\n");
  const lines = program === "" ? [] : program.split(/\r?\n/u);
  if (hadTrailingLineEnding) lines.pop();
  const index = lines.findIndex(
    (line) => parseAssignmentLine(line)?.target === target,
  );
  const normalizedExpression = expression?.trim().replace(/^=/u, "").trim();
  if (!normalizedExpression) {
    if (index >= 0) lines.splice(index, 1);
  } else {
    const assignment = `${target} = ${normalizedExpression}`;
    if (index >= 0) lines[index] = assignment;
    else lines.push(assignment);
  }
  const result = lines.join(lineEnding);
  return hadTrailingLineEnding && result !== "" ? `${result}${lineEnding}` : result;
}

/** Shift relative A1 references as a Formula cell is filled to another cell. */
export function translateFormulaExpression(
  expression: string,
  rowDelta: number,
  columnDelta: number,
): string {
  if (!Number.isSafeInteger(rowDelta) || !Number.isSafeInteger(columnDelta)) {
    throw new Error("Formula fill offsets must be safe integers.");
  }
  let result = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  let bracketDepth = 0;
  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (inString) {
      result += character;
      if (character === '"' && !escaped) inString = false;
      if (character === "\\" && !escaped) {
        escaped = true;
      } else {
        escaped = false;
      }
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      index += 1;
      continue;
    }
    if (
      character === "/" &&
      expression[index + 1] === "/" &&
      bracketDepth === 0
    ) {
      result += expression.slice(index);
      break;
    }
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (bracketDepth === 0) {
      const match = /^(\$?)([A-Za-z]+)(\$?)([1-9][0-9]*)/u.exec(
        expression.slice(index),
      );
      const previous = expression[index - 1];
      const next = match ? expression[index + match[0].length] : undefined;
      if (
        match &&
        !isReferenceIdentifierCharacter(previous) &&
        !isReferenceIdentifierCharacter(next)
      ) {
        const originalColumn = spreadsheetColumnIndex(match[2] ?? "");
        const originalRow = Number(match[4]) - 1;
        const column =
          match[1] === "$" ? originalColumn : originalColumn + columnDelta;
        const row = match[3] === "$" ? originalRow : originalRow + rowDelta;
        if (column < 0 || row < 0) {
          throw new Error("Formula fill would move a relative reference before A1.");
        }
        result += `${match[1] ?? ""}${spreadsheetColumnName(column)}${match[3] ?? ""}${row + 1}`;
        index += match[0].length;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

function parseAssignmentLine(
  line: string,
): { target: string; expression: string } | undefined {
  const match = /^\s*\$?([A-Za-z]+)\$?([1-9][0-9]*)\s*=\s*(.*?)\s*$/u.exec(
    line,
  );
  if (!match) return undefined;
  return {
    target: `${match[1]?.toUpperCase()}${match[2]}`,
    expression: match[3] ?? "",
  };
}

function spreadsheetColumnIndex(label: string): number {
  let value = 0;
  for (const character of label.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

function isReferenceIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}
