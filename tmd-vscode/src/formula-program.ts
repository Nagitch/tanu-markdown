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

/** Rebase every coordinate in an expression when moving it to another sheet origin. */
export function rebaseFormulaExpression(
  expression: string,
  rowDelta: number,
  columnDelta: number,
): string {
  if (!Number.isSafeInteger(rowDelta) || !Number.isSafeInteger(columnDelta)) {
    throw new Error("Formula rebase offsets must be safe integers.");
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
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
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
      const previous = expression[index - 1];
      const header = /^HEADER\s*\(\s*([A-Za-z]+)\s*\)/iu.exec(
        expression.slice(index),
      );
      if (header && !isReferenceIdentifierCharacter(previous)) {
        const column = spreadsheetColumnIndex(header[1] ?? "") + columnDelta;
        if (column < 0) {
          throw new Error("Formula extraction would move a HEADER reference before column A.");
        }
        result += `HEADER(${spreadsheetColumnName(column)})`;
        index += header[0].length;
        continue;
      }
      const cell = /^(\$?)([A-Za-z]+)(\$?)([1-9][0-9]*)/u.exec(
        expression.slice(index),
      );
      const next = cell ? expression[index + cell[0].length] : undefined;
      if (
        cell &&
        !isReferenceIdentifierCharacter(previous) &&
        !isReferenceIdentifierCharacter(next)
      ) {
        const column = spreadsheetColumnIndex(cell[2] ?? "") + columnDelta;
        const row = Number(cell[4]) - 1 + rowDelta;
        if (column < 0 || row < 0) {
          throw new Error("Formula extraction would move a reference before A1.");
        }
        result += `${cell[1] ?? ""}${spreadsheetColumnName(column)}${cell[3] ?? ""}${row + 1}`;
        index += cell[0].length;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

/** Insert rows into a Formula program, shifting targets and references below them. */
export function insertFormulaRows(
  program: string,
  row: number,
  count = 1,
): string {
  requireInsertion(row, count, "row");
  return rewriteFormulaProgram(program, (cellRow, cellColumn) => ({
    row: cellRow >= row ? cellRow + count : cellRow,
    column: cellColumn,
  }));
}

/** Insert columns into a Formula program, shifting targets and references to their right. */
export function insertFormulaColumns(
  program: string,
  column: number,
  count = 1,
): string {
  requireInsertion(column, count, "column");
  return rewriteFormulaProgram(program, (cellRow, cellColumn) => ({
    row: cellRow,
    column: cellColumn >= column ? cellColumn + count : cellColumn,
  }));
}

function rewriteFormulaProgram(
  program: string,
  mapCell: (row: number, column: number) => { row: number; column: number },
): string {
  const lineEnding = program.includes("\r\n") ? "\r\n" : "\n";
  const trailingLineEnding = program.endsWith("\n");
  const lines = program === "" ? [] : program.split(/\r?\n/u);
  if (trailingLineEnding) lines.pop();
  const rewritten = lines.map((line) => {
    const assignment = parseAssignmentLine(line);
    if (!assignment) return line;
    const target = parseCellName(assignment.target);
    if (!target) return line;
    const mapped = mapCell(target.row, target.column);
    return `${spreadsheetCellName(mapped.row, mapped.column)} = ${rewriteFormulaReferences(
      assignment.expression,
      mapCell,
    )}`;
  });
  const result = rewritten.join(lineEnding);
  return trailingLineEnding && result !== "" ? `${result}${lineEnding}` : result;
}

function rewriteFormulaReferences(
  expression: string,
  mapCell: (row: number, column: number) => { row: number; column: number },
): string {
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
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
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
      const previous = expression[index - 1];
      const header = /^HEADER\s*\(\s*([A-Za-z]+)\s*\)/iu.exec(
        expression.slice(index),
      );
      if (header && !isReferenceIdentifierCharacter(previous)) {
        const originalColumn = spreadsheetColumnIndex(header[1] ?? "");
        const mapped = mapCell(0, originalColumn);
        result += `HEADER(${spreadsheetColumnName(mapped.column)})`;
        index += header[0].length;
        continue;
      }
      const match = /^(\$?)([A-Za-z]+)(\$?)([1-9][0-9]*)/u.exec(
        expression.slice(index),
      );
      const next = match ? expression[index + match[0].length] : undefined;
      if (
        match &&
        !isReferenceIdentifierCharacter(previous) &&
        !isReferenceIdentifierCharacter(next)
      ) {
        const mapped = mapCell(
          Number(match[4]) - 1,
          spreadsheetColumnIndex(match[2] ?? ""),
        );
        result += `${match[1] ?? ""}${spreadsheetColumnName(mapped.column)}${match[3] ?? ""}${mapped.row + 1}`;
        index += match[0].length;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

function parseCellName(
  name: string,
): { row: number; column: number } | undefined {
  const match = /^([A-Z]+)([1-9][0-9]*)$/u.exec(name);
  return match
    ? {
        row: Number(match[2]) - 1,
        column: spreadsheetColumnIndex(match[1] ?? ""),
      }
    : undefined;
}

function requireInsertion(index: number, count: number, kind: string): void {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(count) ||
    count <= 0
  ) {
    throw new Error(`Formula ${kind} insertions require nonnegative safe indexes and positive counts.`);
  }
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
