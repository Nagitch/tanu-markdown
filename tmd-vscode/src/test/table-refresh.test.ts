import assert from "node:assert/strict";
import { test } from "node:test";
import type { DataSourceTable } from "../types.js";
import { changedTableCells, tablesHaveSameShape } from "../table-refresh.js";

function table(rows: DataSourceTable["rows"]): DataSourceTable {
  return {
    source: "sales-formula",
    kind: "table",
    columns: ["item", "amount", "double"],
    rows,
  };
}

test("compatible Formula table snapshots report only changed cells", () => {
  const previous = table([
    [
      { type: "string", value: "Tea" },
      { type: "integer", value: "1200" },
      { type: "integer", value: "2400" },
    ],
  ]);
  const next = table([
    [
      { type: "string", value: "Tea" },
      { type: "integer", value: "1500" },
      { type: "integer", value: "3000" },
    ],
  ]);

  assert.equal(tablesHaveSameShape(previous, next), true);
  assert.deepEqual(changedTableCells(previous, next), [
    { row: 0, column: 1 },
    { row: 0, column: 2 },
  ]);
});

test("table shape changes require a full row-source replacement", () => {
  const previous = table([[{ type: "string", value: "Tea" }]]);
  const next = {
    ...table([[{ type: "string", value: "Tea" }]]),
    columns: ["item", "amount"],
  };

  assert.equal(tablesHaveSameShape(previous, next), false);
  assert.deepEqual(changedTableCells(previous, next), []);
});
