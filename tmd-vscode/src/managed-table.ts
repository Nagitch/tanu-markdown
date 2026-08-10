import {
  insertFormulaColumns,
  insertFormulaRows,
  formulaExpressionForCell,
  rebaseFormulaExpression,
  setFormulaCellExpression,
  spreadsheetCellName,
  translateFormulaExpression,
} from "./formula-program.js";
import type {
  DataTableCell,
  ManagedCellConstraint,
  ManagedFormulaCell,
  ManagedFormulaDataSource,
  ManagedFormulaRow,
} from "./types.js";

export interface ManagedTableRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface NormalizationCandidate extends ManagedTableRange {
  duplicateRows: number;
  uniqueRows: number;
}

export function createManagedFormulaDataSource(
  name: string,
): ManagedFormulaDataSource {
  return {
    name,
    type: "formula",
    columns: [1, 2, 3].map((number) => ({
      id: `c${number}`,
      name: `Column ${number}`,
      constraint: "any",
    })),
    rows: [1, 2, 3].map((number) => ({
      id: `r${number}`,
      cells: [blankManagedCell(), blankManagedCell(), blankManagedCell()],
    })),
  };
}

export function blankManagedCell(): ManagedFormulaCell {
  return { content: { kind: "literal", value: { type: "null" } } };
}

export function effectiveCellConstraint(
  source: ManagedFormulaDataSource,
  row: number,
  column: number,
): ManagedCellConstraint {
  return (
    source.rows[row]?.cells[column]?.constraint ??
    source.columns[column]?.constraint ??
    "any"
  );
}

export function managedCellText(
  source: ManagedFormulaDataSource,
  row: number,
  column: number,
): string {
  const cell = source.rows[row]?.cells[column];
  if (!cell) return "";
  if (cell.content.kind === "formula") return `=${cell.content.expression}`;
  return dataCellText(cell.content.value);
}

export function parseManagedCellText(
  text: string,
  constraint: ManagedCellConstraint,
): ManagedFormulaCell["content"] {
  if (text.startsWith("=")) {
    const expression = text.slice(1).trim();
    if (expression === "" || expression.startsWith("=") || /[\r\n]/u.test(expression)) {
      throw new Error("Formula expressions must be a single RHS expression.");
    }
    return { kind: "formula", expression };
  }
  if (text === "") return { kind: "literal", value: { type: "null" } };
  if (constraint === "text") {
    return { kind: "literal", value: { type: "string", value: text } };
  }
  const trimmed = text.trim();
  if (trimmed === "" && constraint !== "any") {
    return { kind: "literal", value: { type: "null" } };
  }
  if (constraint === "boolean") {
    if (!/^(true|false)$/iu.test(trimmed)) {
      throw new Error("Boolean cells accept true or false.");
    }
    return {
      kind: "literal",
      value: { type: "boolean", value: trimmed.toLowerCase() === "true" },
    };
  }
  if (constraint === "number") {
    const number = parseManagedNumber(trimmed);
    if (!number) throw new Error("Number cells require a finite number.");
    return { kind: "literal", value: number };
  }
  if (/^(true|false)$/iu.test(trimmed)) {
    return {
      kind: "literal",
      value: { type: "boolean", value: trimmed.toLowerCase() === "true" },
    };
  }
  const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(trimmed)
    ? parseManagedNumber(trimmed)
    : undefined;
  return {
    kind: "literal",
    value: number ?? { type: "string", value: text },
  };
}

export function managedLiteralConstraintIssue(
  cell: ManagedFormulaCell,
  constraint: ManagedCellConstraint,
): string | undefined {
  if (cell.content.kind === "formula" || cell.content.value.type === "null" || constraint === "any") {
    return undefined;
  }
  const type = cell.content.value.type;
  if (constraint === "text" && type !== "string") return "requires Text";
  if (constraint === "number" && type !== "integer" && type !== "real") {
    return "requires a Number";
  }
  if (constraint === "boolean" && type !== "boolean") return "requires true or false";
  return undefined;
}

export function renameManagedColumn(
  source: ManagedFormulaDataSource,
  column: number,
  name: string,
): void {
  const target = source.columns[column];
  if (!target) throw new Error("The selected managed column no longer exists.");
  if (name.length === 0 || new TextEncoder().encode(name).length > 256) {
    throw new Error("Column names require 1-256 UTF-8 bytes.");
  }
  if (source.columns.some((candidate, index) => index !== column && candidate.name === name)) {
    throw new Error("Managed Formula column names must be unique.");
  }
  const previousName = target.name;
  target.name = name;
  for (const row of source.rows) {
    for (const cell of row.cells) {
      if (cell.content.kind === "formula") {
        cell.content.expression = rewriteNamedColumnReference(
          cell.content.expression,
          previousName,
          name,
        );
      }
    }
  }
}

export function renameManagedReferencedColumn(
  sources: readonly ManagedFormulaDataSource[],
  targetSourceName: string,
  previousName: string,
  nextName: string,
): void {
  for (const source of sources) {
    const referenceColumns = new Set(
      source.columns
        .filter((column) => column.reference?.source === targetSourceName)
        .map((column) => column.name),
    );
    if (referenceColumns.size === 0) continue;
    for (const row of source.rows) {
      for (const cell of row.cells) {
        if (cell.content.kind !== "formula") continue;
        cell.content.expression = rewriteRefTargetColumn(
          cell.content.expression,
          referenceColumns,
          previousName,
          nextName,
        );
      }
    }
  }
}

export function setManagedCellText(
  source: ManagedFormulaDataSource,
  row: number,
  column: number,
  text: string,
): DataTableCell | undefined {
  const cell = source.rows[row]?.cells[column];
  if (!cell) throw new Error("The selected managed cell no longer exists.");
  cell.content = parseManagedCellText(
    text,
    effectiveCellConstraint(source, row, column),
  );
  return cell.content.kind === "literal" ? { ...cell.content.value } : undefined;
}

export function insertManagedRow(
  source: ManagedFormulaDataSource,
  index: number,
): void {
  const program = insertFormulaRows(managedFormulaProgram(source), index);
  const templateCells = source.columns.map((_, column) =>
    managedColumnTemplateCell(source, column),
  );
  source.rows.splice(index, 0, {
    id: nextStableId(source.rows.map((row) => row.id), "r"),
    cells: templateCells.map(cloneManagedCell),
  });
  applyManagedFormulaProgram(source, program);
  for (const [column, template] of templateCells.entries()) {
    if (template.content.kind === "formula") {
      source.rows[index].cells[column] = cloneManagedCell(template);
    }
  }
}

export function duplicateManagedRow(
  source: ManagedFormulaDataSource,
  origin: number,
  destination = source.rows.length,
): void {
  const original = source.rows[origin];
  if (!original) throw new Error("Select a row to duplicate.");
  const row = cloneManagedRow(original);
  row.id = nextStableId(source.rows.map((candidate) => candidate.id), "r");
  for (const cell of row.cells) {
    if (cell.content.kind === "formula") {
      cell.content.expression = translateFormulaExpression(
        cell.content.expression,
        destination - origin,
        0,
      );
    }
  }
  source.rows.splice(destination, 0, row);
}

export function insertManagedColumn(
  source: ManagedFormulaDataSource,
  index: number,
): void {
  index = Math.min(index, managedVisibleColumnCount(source));
  const program = insertFormulaColumns(managedFormulaProgram(source), index);
  source.columns.splice(index, 0, {
    id: nextStableId(source.columns.map((column) => column.id), "c"),
    name: uniqueManagedColumnName(source, "Column"),
    constraint: "any",
  });
  for (const row of source.rows) row.cells.splice(index, 0, blankManagedCell());
  applyManagedFormulaProgram(source, program);
}

export function duplicateManagedColumn(
  source: ManagedFormulaDataSource,
  origin: number,
  destination = source.columns.length,
): void {
  destination = Math.min(destination, managedVisibleColumnCount(source));
  const original = source.columns[origin];
  if (!original) throw new Error("Select a column to duplicate.");
  source.columns.splice(destination, 0, {
    ...original,
    id: nextStableId(source.columns.map((column) => column.id), "c"),
    name: uniqueManagedColumnName(source, `${original.name} copy`),
    ...(original.reference ? { reference: { ...original.reference } } : {}),
  });
  for (const row of source.rows) {
    const cloned = cloneManagedCell(row.cells[origin] ?? blankManagedCell());
    if (cloned.content.kind === "formula") {
      cloned.content.expression = translateFormulaExpression(
        cloned.content.expression,
        0,
        destination - origin,
      );
    }
    row.cells.splice(destination, 0, cloned);
  }
}

export function managedVisibleColumnCount(source: ManagedFormulaDataSource): number {
  const firstHidden = source.columns.findIndex((column) => column.hidden === true);
  return firstHidden < 0 ? source.columns.length : firstHidden;
}

function managedColumnTemplateCell(
  source: ManagedFormulaDataSource,
  column: number,
): ManagedFormulaCell {
  const expressions = source.rows.map((row) => {
    const content = row.cells[column]?.content;
    return content?.kind === "formula" ? content.expression : undefined;
  });
  const [first] = expressions;
  return first !== undefined && expressions.every((expression) => expression === first)
    ? { content: { kind: "formula", expression: first } }
    : blankManagedCell();
}

export function extractManagedRange(
  source: ManagedFormulaDataSource,
  range: ManagedTableRange,
  name: string,
): ManagedFormulaDataSource {
  const normalized = normalizeRange(source, range);
  forEachCell(normalized, (row, column) => {
    const content = source.rows[row]?.cells[column]?.content;
    if (
      content?.kind === "formula" &&
      !formulaIsSelfContained(source, content.expression, normalized)
    ) {
      throw new Error(
        `Cell ${spreadsheetCellName(row, column)} refers outside the selection. Select a self-contained range or convert it to literals first.`,
      );
    }
  });
  return {
    name,
    type: "formula",
    columns: source.columns
      .slice(normalized.left, normalized.right + 1)
      .map((column, index) => ({
        ...column,
        id: `c${index + 1}`,
        ...(column.reference ? { reference: { ...column.reference } } : {}),
      })),
    rows: source.rows
      .slice(normalized.top, normalized.bottom + 1)
      .map((row, rowIndex) => ({
        id: `r${rowIndex + 1}`,
        cells: row.cells
          .slice(normalized.left, normalized.right + 1)
          .map((cell) => {
            const clone = cloneManagedCell(cell);
            if (clone.content.kind === "formula") {
              clone.content.expression = rebaseFormulaExpression(
                clone.content.expression,
                -normalized.top,
                -normalized.left,
              );
            }
            return clone;
          }),
      })),
  };
}

export function findNormalizationCandidate(
  source: ManagedFormulaDataSource,
): NormalizationCandidate | undefined {
  if (
    source.rows.length < 2 ||
    source.columns.length < 3 ||
    source.rows.some((row) =>
      row.cells.some((cell) => cell.content.kind !== "literal"),
    )
  ) {
    return undefined;
  }
  let best: NormalizationCandidate | undefined;
  for (let left = 0; left < source.columns.length; left += 1) {
    for (
      let right = left + 1;
      right < Math.min(source.columns.length, left + 4);
      right += 1
    ) {
      if (right - left + 1 === source.columns.length) continue;
      const selectedRows = source.rows.map((row) =>
        row.cells.slice(left, right + 1),
      );
      if (
        selectedRows.every((cells) =>
          cells.every(
            (cell) =>
              cell.content.kind === "literal" &&
              cell.content.value.type === "null",
          ),
        )
      ) {
        continue;
      }
      const keys = new Set(selectedRows.map(literalTupleKey));
      const duplicateRows = source.rows.length - keys.size;
      if (duplicateRows === 0 || keys.size < 2) continue;
      const candidate = {
        top: 0,
        bottom: source.rows.length - 1,
        left,
        right,
        duplicateRows,
        uniqueRows: keys.size,
      };
      const score = duplicateRows * (right - left + 1);
      const bestScore = best
        ? best.duplicateRows * (best.right - best.left + 1)
        : -1;
      if (score > bestScore) best = candidate;
    }
  }
  return best;
}

export function normalizeManagedColumns(
  source: ManagedFormulaDataSource,
  candidate: NormalizationCandidate,
  targetName: string,
): { source: ManagedFormulaDataSource; target: ManagedFormulaDataSource } {
  const updated = cloneManagedFormulaSource(source);
  if (updated.columns.length >= 128) {
    throw new Error("Normalization requires room for one internal reference column.");
  }
  if (
    updated.rows.some((row) =>
      row.cells.some((cell) => cell.content.kind !== "literal"),
    )
  ) {
    throw new Error("Normalization is available only while the managed table contains literals.");
  }
  const selectedColumns = updated.columns.slice(candidate.left, candidate.right + 1);
  const targetIdColumnId = `c${selectedColumns.length + 1}`;
  const selectedNames = new Set(selectedColumns.map((column) => column.name));
  let targetIdColumnName = "ID";
  let targetIdSuffix = 2;
  while (selectedNames.has(targetIdColumnName)) {
    targetIdColumnName = `ID ${targetIdSuffix}`;
    targetIdSuffix += 1;
  }
  const tupleIds = new Map<string, string>();
  const targetRows: ManagedFormulaRow[] = [];
  for (const row of updated.rows) {
    const selectedCells = row.cells.slice(candidate.left, candidate.right + 1);
    const key = literalTupleKey(selectedCells);
    if (!tupleIds.has(key)) {
      const id = `${targetName}-${tupleIds.size + 1}`;
      tupleIds.set(key, id);
      targetRows.push({
        id: `r${targetRows.length + 1}`,
        cells: [
          ...selectedCells.map(cloneManagedCell),
          { content: { kind: "literal", value: { type: "string", value: id } } },
        ],
      });
    }
  }
  if (
    updated.rows.length * (updated.columns.length + 1) > 10_000 ||
    targetRows.length * (selectedColumns.length + 1) > 10_000
  ) {
    throw new Error("Normalization would exceed the 10,000-cell managed table limit.");
  }
  const referenceColumn = {
    id: nextStableId(updated.columns.map((column) => column.id), "c"),
    name: uniqueManagedColumnName(updated, `${targetName}_ref`),
    constraint: "text" as const,
    hidden: true,
    reference: { source: targetName, columnId: targetIdColumnId },
  };
  for (let column = candidate.left; column <= candidate.right; column += 1) {
    delete updated.columns[column]?.reference;
  }
  updated.columns.push(referenceColumn);
  for (const row of updated.rows) {
    const selectedCells = row.cells.slice(candidate.left, candidate.right + 1);
    const id = tupleIds.get(literalTupleKey(selectedCells));
    for (const [offset, selectedCell] of selectedCells.entries()) {
      const targetColumn = selectedColumns[offset];
      if (!targetColumn) continue;
      row.cells[candidate.left + offset] = {
        content: {
          kind: "formula",
          expression: `REF([@${referenceColumn.name}], ${JSON.stringify(targetColumn.name)})`,
        },
        ...(selectedCell.constraint ? { constraint: selectedCell.constraint } : {}),
      };
    }
    row.cells.push({
      content: {
        kind: "literal",
        value: { type: "string", value: id ?? "" },
      },
    });
  }
  return {
    source: updated,
    target: {
      name: targetName,
      type: "formula",
      columns: [
        ...selectedColumns.map((column, index) => ({
          ...column,
          id: `c${index + 1}`,
          ...(column.reference ? { reference: { ...column.reference } } : {}),
        })),
        {
          id: targetIdColumnId,
          name: targetIdColumnName,
          constraint: "text",
          hidden: true,
        },
      ],
      rows: targetRows,
    },
  };
}

export function cloneManagedFormulaSource(
  source: ManagedFormulaDataSource,
): ManagedFormulaDataSource {
  return {
    ...source,
    columns: source.columns.map((column) => ({
      ...column,
      ...(column.reference ? { reference: { ...column.reference } } : {}),
    })),
    rows: source.rows.map(cloneManagedRow),
  };
}

function managedFormulaProgram(source: ManagedFormulaDataSource): string {
  let program = "";
  for (const [rowIndex, row] of source.rows.entries()) {
    for (const [columnIndex, cell] of row.cells.entries()) {
      if (cell.content.kind === "formula") {
        program = setFormulaCellExpression(
          program,
          rowIndex,
          columnIndex,
          cell.content.expression,
        );
      }
    }
  }
  return program;
}

function applyManagedFormulaProgram(
  source: ManagedFormulaDataSource,
  program: string,
): void {
  for (const [rowIndex, row] of source.rows.entries()) {
    for (const [columnIndex, cell] of row.cells.entries()) {
      const expression = formulaExpressionForCell(program, rowIndex, columnIndex);
      if (expression !== undefined) {
        cell.content = { kind: "formula", expression };
      } else if (cell.content.kind === "formula") {
        cell.content = { kind: "literal", value: { type: "null" } };
      }
    }
  }
}

function formulaIsSelfContained(
  source: ManagedFormulaDataSource,
  expression: string,
  range: ManagedTableRange,
): boolean {
  let index = 0;
  let inString = false;
  let escaped = false;
  while (index < expression.length) {
    const character = expression[index] ?? "";
    if (inString) {
      if (character === '"' && !escaped) inString = false;
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (character === "/" && expression[index + 1] === "/") break;
    if (character === "[") {
      const end = expression.indexOf("]", index + 1);
      if (end < 0) return false;
      const rawName = expression.slice(index + 1, end);
      const currentRow = rawName.startsWith("@");
      const name = currentRow ? rawName.slice(1) : rawName;
      const column = source.columns.findIndex((candidate) => candidate.name === name);
      if (column < range.left || column > range.right) return false;
      if (
        !currentRow &&
        (range.top !== 0 || range.bottom !== source.rows.length - 1)
      ) {
        return false;
      }
      index = end + 1;
      continue;
    }
    const previous = expression[index - 1];
    const header = /^HEADER\s*\(\s*([A-Za-z]+)\s*\)/iu.exec(
      expression.slice(index),
    );
    if (header && !isFormulaReferenceIdentifierCharacter(previous)) {
      const column = spreadsheetColumnIndex(header[1] ?? "");
      if (column < range.left || column > range.right) return false;
      index += header[0].length;
      continue;
    }
    const match = /^(\$?)([A-Za-z]+)(\$?)([1-9][0-9]*)/u.exec(
      expression.slice(index),
    );
    const next = match ? expression[index + match[0].length] : undefined;
    if (
      match &&
      !isFormulaReferenceIdentifierCharacter(previous) &&
      !isFormulaReferenceIdentifierCharacter(next)
    ) {
      const column = spreadsheetColumnIndex(match[2] ?? "");
      const row = Number(match[4]) - 1;
      if (
        column < range.left ||
        column > range.right ||
        row < range.top ||
        row > range.bottom
      ) {
        return false;
      }
      index += match[0].length;
      continue;
    }
    index += 1;
  }
  return true;
}

function rewriteNamedColumnReference(
  expression: string,
  previousName: string,
  nextName: string,
): string {
  let result = "";
  let index = 0;
  let inString = false;
  let escaped = false;
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
    if (character === "/" && expression[index + 1] === "/") {
      result += expression.slice(index);
      break;
    }
    if (character === "[") {
      const end = expression.indexOf("]", index + 1);
      if (end < 0) {
        result += expression.slice(index);
        break;
      }
      const rawName = expression.slice(index + 1, end);
      const currentRow = rawName.startsWith("@");
      const name = currentRow ? rawName.slice(1) : rawName;
      result +=
        name === previousName
          ? `[${currentRow ? "@" : ""}${nextName}]`
          : expression.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

function rewriteRefTargetColumn(
  expression: string,
  referenceColumns: ReadonlySet<string>,
  previousName: string,
  nextName: string,
): string {
  let result = "";
  let index = 0;
  let inString = false;
  let escaped = false;
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
    if (character === "/" && expression[index + 1] === "/") {
      result += expression.slice(index);
      break;
    }
    const previous = expression[index - 1];
    const ref = /^REF\s*\(\s*\[@([^\]]+)\]\s*,\s*/iu.exec(
      expression.slice(index),
    );
    if (
      ref &&
      !isFormulaReferenceIdentifierCharacter(previous) &&
      referenceColumns.has(ref[1] ?? "")
    ) {
      const stringStart = index + ref[0].length;
      const stringEnd = jsonStringEnd(expression, stringStart);
      if (stringEnd !== undefined) {
        const encodedName = expression.slice(stringStart, stringEnd);
        let decodedName: unknown;
        try {
          decodedName = JSON.parse(encodedName);
        } catch {
          decodedName = undefined;
        }
        const closing = /^\s*\)/u.exec(expression.slice(stringEnd));
        if (decodedName === previousName && closing) {
          result += `${ref[0]}${JSON.stringify(nextName)}`;
          index = stringEnd;
          continue;
        }
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

function jsonStringEnd(expression: string, start: number): number | undefined {
  if (expression[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === '"' && !escaped) return index + 1;
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return undefined;
}

function isFormulaReferenceIdentifierCharacter(
  character: string | undefined,
): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}

function spreadsheetColumnIndex(name: string): number {
  let value = 0;
  for (const character of name.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

function normalizeRange(
  source: ManagedFormulaDataSource,
  range: ManagedTableRange,
): ManagedTableRange {
  return {
    top: Math.max(0, Math.min(range.top, range.bottom)),
    bottom: Math.min(source.rows.length - 1, Math.max(range.top, range.bottom)),
    left: Math.max(0, Math.min(range.left, range.right)),
    right: Math.min(source.columns.length - 1, Math.max(range.left, range.right)),
  };
}

function forEachCell(
  range: ManagedTableRange,
  callback: (row: number, column: number) => void,
): void {
  for (let row = range.top; row <= range.bottom; row += 1) {
    for (let column = range.left; column <= range.right; column += 1) callback(row, column);
  }
}

function parseManagedNumber(value: string): DataTableCell | undefined {
  if (/^-?\d+$/u.test(value)) {
    const integer = BigInt(value);
    if (integer < -(2n ** 63n) || integer > 2n ** 63n - 1n) {
      throw new Error("Integer cells must fit in a signed 64-bit value.");
    }
    return { type: "integer", value: integer.toString() };
  }
  if (!/^-?(?:\d+\.\d*|\.\d+|\d+)(?:e[+-]?\d+)?$/iu.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? { type: "real", value: number } : undefined;
}

function dataCellText(cell: DataTableCell): string {
  if (cell.type === "null") return "";
  return cell.type === "integer" ? cell.value : String(cell.value);
}

function literalTupleKey(cells: readonly ManagedFormulaCell[]): string {
  return JSON.stringify(
    cells.map((cell) =>
      cell.content.kind === "literal" ? cell.content.value : { type: "formula" },
    ),
  );
}

function cloneManagedRow(row: ManagedFormulaRow): ManagedFormulaRow {
  return { ...row, cells: row.cells.map(cloneManagedCell) };
}

function cloneManagedCell(cell: ManagedFormulaCell): ManagedFormulaCell {
  return {
    ...cell,
    content:
      cell.content.kind === "formula"
        ? { ...cell.content }
        : { kind: "literal", value: { ...cell.content.value } },
  };
}

function nextStableId(values: readonly string[], prefix: string): string {
  const used = new Set(values);
  let number = 1;
  while (used.has(`${prefix}${number}`)) number += 1;
  return `${prefix}${number}`;
}

function uniqueManagedColumnName(
  source: ManagedFormulaDataSource,
  base: string,
): string {
  const names = new Set(source.columns.map((column) => column.name));
  if (!names.has(base)) return base;
  let number = 2;
  while (names.has(`${base} ${number}`)) number += 1;
  return `${base} ${number}`;
}
