import assert from "node:assert/strict";
import { test } from "node:test";
import { spreadsheetColumnName } from "../formula-program.js";

test("Formula columns use familiar A1 spreadsheet labels", () => {
  assert.equal(spreadsheetColumnName(0), "A");
  assert.equal(spreadsheetColumnName(25), "Z");
  assert.equal(spreadsheetColumnName(26), "AA");
  assert.equal(spreadsheetColumnName(127), "DX");
});

test("Formula columns reject invalid indexes", () => {
  assert.throws(() => spreadsheetColumnName(-1));
  assert.throws(() => spreadsheetColumnName(1.5));
});
