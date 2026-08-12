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
  DataSourceTable,
  ManagedCellConstraint,
  ManagedFormulaCell,
  ManagedFormulaDataSource,
  ManagedFormulaReferenceGroup,
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
    for (const row of source.rows) {
      for (const cell of row.cells) {
        if (cell.content.kind !== "formula") continue;
        cell.content.expression = rewriteDirectRefCalls(
          cell.content.expression,
          (reference) =>
            reference.source === targetSourceName &&
            reference.targetColumn === previousName
              ? { ...reference, targetColumn: nextName }
              : reference,
        );
      }
    }
  }
}

export function renameManagedReferencedSource(
  sources: readonly ManagedFormulaDataSource[],
  previousName: string,
  nextName: string,
): void {
  for (const source of sources) {
    for (const group of source.referenceGroups ?? []) {
      if (group.source === previousName) group.source = nextName;
    }
    for (const row of source.rows) {
      for (const cell of row.cells) {
        if (cell.content.kind !== "formula") continue;
        cell.content.expression = rewriteDirectRefCalls(
          cell.content.expression,
          (reference) =>
            reference.source === previousName
              ? { ...reference, source: nextName }
              : reference,
        );
      }
    }
  }
}

export function renameManagedReferenceIdentity(
  sources: readonly ManagedFormulaDataSource[],
  targetSourceName: string,
  previousIdentity: string,
  nextIdentity: string,
): void {
  for (const source of sources) {
    for (const row of source.rows) {
      for (const cell of row.cells) {
        if (cell.content.kind !== "formula") continue;
        cell.content.expression = rewriteDirectRefCalls(
          cell.content.expression,
          (reference) => {
            const identity = parseFormulaStringArgument(
              reference.identityExpression.trim(),
            );
            return reference.source === targetSourceName &&
              identity === previousIdentity
              ? {
                  ...reference,
                  identityExpression: JSON.stringify(nextIdentity),
                }
              : reference;
          },
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
  const group = managedReferenceGroupAt(source, row, column);
  if (group) {
    throw new Error(
      `This cell is protected by reference group ${group.id}. Choose a referenced row or release the group first.`,
    );
  }
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
  const previousRows = source.rows.map((row) => row.id);
  const program = insertFormulaRows(managedFormulaProgram(source), index);
  const templateCells = source.columns.map((_, column) =>
    managedColumnTemplateCell(source, column),
  );
  source.rows.splice(index, 0, {
    id: nextStableId(source.rows.map((row) => row.id), "r"),
    cells: templateCells.map(cloneManagedCell),
  });
  const insertedRowId = source.rows[index]?.id;
  if (insertedRowId) {
    for (const group of source.referenceGroups ?? []) {
      const before = previousRows[index - 1];
      const after = previousRows[index];
      if (
        (before !== undefined && group.rowIds.includes(before)) ||
        (after !== undefined && group.rowIds.includes(after))
      ) {
        group.rowIds.splice(index, 0, insertedRowId);
      }
    }
  }
  applyManagedFormulaProgram(source, program);
  for (const [column, template] of templateCells.entries()) {
    if (template.content.kind === "formula") {
      source.rows[index].cells[column] = cloneManagedCell(template);
    }
  }
  assignGeneratedManagedIdentity(source, index);
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
  assignGeneratedManagedIdentity(source, destination, row);
  source.rows.splice(destination, 0, row);
  for (const group of source.referenceGroups ?? []) {
    if (!group.rowIds.includes(original.id)) continue;
    const groupIndex = Math.min(destination, group.rowIds.length);
    group.rowIds.splice(groupIndex, 0, row.id);
  }
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
  const { identity: _identity, ...duplicatedColumn } = original;
  source.columns.splice(destination, 0, {
    ...duplicatedColumn,
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
  return source.columns.length;
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
      if (source.columns.slice(left, right + 1).some((column) => column.identity)) {
        continue;
      }
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
    updated.rows.length * updated.columns.length > 10_000 ||
    targetRows.length * (selectedColumns.length + 1) > 10_000
  ) {
    throw new Error("Normalization would exceed the 10,000-cell managed table limit.");
  }
  const groupColumns: ManagedFormulaReferenceGroup["columns"] = [];
  for (const [offset, column] of selectedColumns.entries()) {
    groupColumns.push({
      columnId: column.id,
      targetColumnId: `c${offset + 1}`,
    });
  }
  for (const row of updated.rows) {
    const selectedCells = row.cells.slice(candidate.left, candidate.right + 1);
    const id = tupleIds.get(literalTupleKey(selectedCells));
    for (const [offset, selectedCell] of selectedCells.entries()) {
      const targetColumn = selectedColumns[offset];
      if (!targetColumn) continue;
      row.cells[candidate.left + offset] = {
        content: {
          kind: "formula",
          expression: directRefExpression(targetName, id ?? "", targetColumn.name),
        },
        ...(selectedCell.constraint ? { constraint: selectedCell.constraint } : {}),
      };
    }
  }
  const referenceGroups = updated.referenceGroups ?? [];
  referenceGroups.push({
    id: nextStableId(referenceGroups.map((group) => group.id), "ref"),
    source: targetName,
    rowIds: updated.rows.map((row) => row.id),
    columns: groupColumns,
  });
  updated.referenceGroups = referenceGroups;
  return {
    source: updated,
    target: {
      name: targetName,
      type: "formula",
      columns: [
        ...selectedColumns.map((column, index) => {
          const { identity: _identity, hidden: _hidden, reference: _reference, ...copy } = column;
          return { ...copy, id: `c${index + 1}` };
        }),
        {
          id: targetIdColumnId,
          name: targetIdColumnName,
          constraint: "text",
          identity: true,
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
    ...(source.referenceGroups
      ? {
          referenceGroups: source.referenceGroups.map((group) => ({
            ...group,
            rowIds: [...group.rowIds],
            columns: group.columns.map((column) => ({ ...column })),
          })),
        }
      : {}),
  };
}

export function directRefExpression(
  source: string,
  identity: string | DataTableCell,
  targetColumn: string,
): string {
  return `REF(${JSON.stringify(source)}, ${directRefIdentityExpression(identity)}, ${JSON.stringify(targetColumn)})`;
}

export function parseDirectRefExpression(expression: string):
  | { source: string; identity: DataTableCell; targetColumn: string }
  | undefined {
  const string = String.raw`"(?:\\.|[^"\\])*"`;
  const scalar = String.raw`(?:${string}|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?)`;
  const match = new RegExp(`^\\s*REF\\s*\\(\\s*(${string})\\s*,\\s*(${scalar})\\s*,\\s*(${string})\\s*\\)\\s*$`, "iu")
    .exec(expression);
  if (!match) return undefined;
  try {
    const identity = parseDirectRefIdentityExpression(match[2] ?? "");
    if (!identity) return undefined;
    return {
      source: JSON.parse(match[1] ?? ""),
      identity,
      targetColumn: JSON.parse(match[3] ?? ""),
    };
  } catch {
    return undefined;
  }
}

function directRefIdentityExpression(identity: string | DataTableCell): string {
  const value = typeof identity === "string"
    ? { type: "string" as const, value: identity }
    : identity;
  switch (value.type) {
    case "null":
      return "null";
    case "boolean":
      return String(value.value);
    case "integer":
      return String(value.value);
    case "real":
      return Number.isInteger(value.value)
        ? `${Object.is(value.value, -0) ? "-0" : String(value.value)}.0`
        : String(value.value);
    case "string":
      return JSON.stringify(value.value);
  }
}

function parseDirectRefIdentityExpression(expression: string): DataTableCell | undefined {
  if (expression.startsWith('"')) {
    const value: unknown = JSON.parse(expression);
    return typeof value === "string" ? { type: "string", value } : undefined;
  }
  if (/^null$/iu.test(expression)) return { type: "null" };
  if (/^(?:true|false)$/iu.test(expression)) {
    return { type: "boolean", value: /^true$/iu.test(expression) };
  }
  if (/^-?(?:0|[1-9]\d*)$/u.test(expression)) {
    return { type: "integer", value: expression };
  }
  const value = Number(expression);
  return Number.isFinite(value) ? { type: "real", value } : undefined;
}

function rewriteDirectRefCalls(
  expression: string,
  rewrite: (reference: {
    source: string;
    identityExpression: string;
    targetColumn: string;
  }) => { source: string; identityExpression: string; targetColumn: string },
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
    const call = !isFormulaReferenceIdentifierCharacter(expression[index - 1])
      ? parseDirectRefCall(expression, index)
      : undefined;
    if (call) {
      try {
        const next = rewrite({
          source: call.source,
          identityExpression: rewriteDirectRefCalls(
            call.identityExpression,
            rewrite,
          ),
          targetColumn: call.targetColumn,
        });
        result += `REF(${JSON.stringify(next.source)}, ${next.identityExpression.trim()}, ${JSON.stringify(next.targetColumn)})`;
        index = call.end;
        continue;
      } catch {
        // Preserve malformed expressions and let the Formula parser diagnose them.
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

function parseDirectRefCall(
  expression: string,
  start: number,
):
  | {
      end: number;
      source: string;
      identityExpression: string;
      targetColumn: string;
    }
  | undefined {
  if (expression.slice(start, start + 3).toUpperCase() !== "REF") return undefined;
  if (isFormulaReferenceIdentifierCharacter(expression[start + 3])) return undefined;
  let cursor = start + 3;
  while (/\s/u.test(expression[cursor] ?? "")) cursor += 1;
  if (expression[cursor] !== "(") return undefined;
  const arguments_: string[] = [];
  let argumentStart = cursor + 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (cursor = argumentStart; cursor < expression.length; cursor += 1) {
    const character = expression[cursor] ?? "";
    if (inString) {
      if (character === '"' && !escaped) inString = false;
      if (character === "\\" && !escaped) escaped = true;
      else escaped = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if ((character === "," || character === ")") && depth === 0) {
      arguments_.push(expression.slice(argumentStart, cursor).trim());
      if (character === ")") {
        if (arguments_.length !== 3) return undefined;
        const source = parseFormulaStringArgument(arguments_[0] ?? "");
        const targetColumn = parseFormulaStringArgument(arguments_[2] ?? "");
        if (source === undefined || targetColumn === undefined || !arguments_[1]) {
          return undefined;
        }
        return {
          end: cursor + 1,
          source,
          identityExpression: arguments_[1],
          targetColumn,
        };
      }
      if (arguments_.length >= 3) return undefined;
      argumentStart = cursor + 1;
    }
  }
  return undefined;
}

function parseFormulaStringArgument(argument: string): string | undefined {
  try {
    const value: unknown = JSON.parse(argument);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function managedReferenceGroupAt(
  source: ManagedFormulaDataSource,
  row: number,
  column: number,
): ManagedFormulaReferenceGroup | undefined {
  const rowId = source.rows[row]?.id;
  const columnId = source.columns[column]?.id;
  if (!rowId || !columnId) return undefined;
  return source.referenceGroups?.find(
    (group) =>
      group.rowIds.includes(rowId) &&
      group.columns.some((mapping) => mapping.columnId === columnId),
  );
}

export function referenceGroupSelection(
  source: ManagedFormulaDataSource,
  group: ManagedFormulaReferenceGroup,
  row: number,
): DataTableCell | undefined {
  const mapping = group.columns[0];
  const column = mapping
    ? source.columns.findIndex((candidate) => candidate.id === mapping.columnId)
    : -1;
  const content = column >= 0 ? source.rows[row]?.cells[column]?.content : undefined;
  if (content?.kind !== "formula") return undefined;
  const reference = parseDirectRefExpression(content.expression);
  return reference?.source === group.source ? reference.identity : undefined;
}

export function applyReferenceGroupSelection(
  source: ManagedFormulaDataSource,
  target: ManagedFormulaDataSource,
  groupId: string,
  row: number,
  targetRow: number,
  evaluatedTarget?: DataSourceTable,
): void {
  const group = source.referenceGroups?.find((candidate) => candidate.id === groupId);
  if (!group || group.source !== target.name) {
    throw new Error("The selected reference group no longer exists.");
  }
  const identityColumn = target.columns.findIndex((column) => column.identity === true);
  const evaluatedIdentity = identityColumn >= 0
    ? evaluatedTarget?.rows[targetRow]?.[identityColumn]
    : undefined;
  const storedIdentity = identityColumn >= 0
    ? target.rows[targetRow]?.cells[identityColumn]?.content
    : undefined;
  const identity = evaluatedIdentity ??
    (storedIdentity?.kind === "literal" ? storedIdentity.value : undefined);
  if (!identity || identity.type === "null") {
    throw new Error(`Reference target ${target.name} requires an evaluated identity value.`);
  }
  for (const mapping of group.columns) {
    const sourceColumn = source.columns.findIndex(
      (column) => column.id === mapping.columnId,
    );
    const targetColumn = target.columns.find(
      (column) => column.id === mapping.targetColumnId,
    );
    const cell = sourceColumn >= 0 ? source.rows[row]?.cells[sourceColumn] : undefined;
    if (!cell || !targetColumn) {
      throw new Error("The reference group column mapping is no longer valid.");
    }
    cell.content = {
      kind: "formula",
      expression: directRefExpression(
        target.name,
        identity,
        targetColumn.name,
      ),
    };
  }
}

export function releaseManagedReferenceGroup(
  source: ManagedFormulaDataSource,
  groupId: string,
): boolean {
  const groups = source.referenceGroups ?? [];
  const next = groups.filter((group) => group.id !== groupId);
  if (next.length === groups.length) return false;
  if (next.length === 0) delete source.referenceGroups;
  else source.referenceGroups = next;
  return true;
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

function assignGeneratedManagedIdentity(
  source: ManagedFormulaDataSource,
  rowIndex: number,
  detachedRow?: ManagedFormulaRow,
): void {
  const identityColumn = source.columns.findIndex(
    (column) => column.identity === true,
  );
  const row = detachedRow ?? source.rows[rowIndex];
  const identityCell = row?.cells[identityColumn];
  if (identityColumn < 0 || !identityCell) return;
  const used = new Set(
    source.rows.flatMap((candidate) => {
      if (candidate === row) return [];
      const content = candidate.cells[identityColumn]?.content;
      return content?.kind === "literal" && content.value.type === "string"
        ? [content.value.value]
        : [];
    }),
  );
  let number = 1;
  while (used.has(`${source.name}-${number}`)) number += 1;
  identityCell.content = {
    kind: "literal",
    value: { type: "string", value: `${source.name}-${number}` },
  };
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
