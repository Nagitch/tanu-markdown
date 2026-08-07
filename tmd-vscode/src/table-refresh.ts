import type { DataSourceTable, DataTableCell } from "./types.js";

export interface ChangedTableCell {
  row: number;
  column: number;
}

/** Whether two table snapshots can be refreshed without replacing the row source. */
export function tablesHaveSameShape(
  previous: DataSourceTable,
  next: DataSourceTable,
): boolean {
  return (
    previous.source === next.source &&
    stringArraysEqual(previous.columns, next.columns) &&
    previous.rows.length === next.rows.length &&
    previous.rows.every((row, index) => row.length === next.rows[index]?.length)
  );
}

/** Locate display cells whose typed values changed between compatible snapshots. */
export function changedTableCells(
  previous: DataSourceTable,
  next: DataSourceTable,
): ChangedTableCell[] {
  if (!tablesHaveSameShape(previous, next)) return [];
  const changed: ChangedTableCell[] = [];
  for (let row = 0; row < next.rows.length; row += 1) {
    for (let column = 0; column < next.rows[row].length; column += 1) {
      if (!tableCellsEqual(previous.rows[row][column], next.rows[row][column])) {
        changed.push({ row, column });
      }
    }
  }
  return changed;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function tableCellsEqual(
  left: DataTableCell | undefined,
  right: DataTableCell | undefined,
): boolean {
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === "null" || right.type === "null") return true;
  return left.value === right.value;
}
