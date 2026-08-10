import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formulaExpressionForCell,
  insertFormulaColumns,
  insertFormulaRows,
  setFormulaCellExpression,
  spreadsheetCellName,
  spreadsheetColumnName,
  translateFormulaExpression,
  rebaseFormulaExpression,
} from "../formula-program.js";

test("Formula columns use familiar A1 spreadsheet labels", () => {
  assert.equal(spreadsheetColumnName(0), "A");
  assert.equal(spreadsheetColumnName(25), "Z");
  assert.equal(spreadsheetColumnName(26), "AA");
  assert.equal(spreadsheetColumnName(127), "DX");
});

test("Formula extraction rebases absolute coordinates and HEADER references", () => {
  assert.equal(
    rebaseFormulaExpression('$B$2 + c3 + HEADER(B) + "A1" + [@Input]', -1, -1),
    '$A$1 + B2 + HEADER(A) + "A1" + [@Input]',
  );
});

test("Formula programs expose and replace individual cell assignments", () => {
  const program = "A1 = 1\nB1 = SUM(A1:A3)\n";
  assert.equal(formulaExpressionForCell(program, 0, 1), "SUM(A1:A3)");
  assert.equal(
    setFormulaCellExpression(program, 0, 1, "=A1 * 2"),
    "A1 = 1\nB1 = A1 * 2\n",
  );
  assert.equal(setFormulaCellExpression(program, 0, 0, undefined), "B1 = SUM(A1:A3)\n");
  assert.equal(spreadsheetCellName(2, 27), "AB3");
});

test("Formula fill shifts relative references and preserves absolute references", () => {
  assert.equal(
    translateFormulaExpression('SUM(A1:$B2) + $C$3 + "A1" + [A1]', 2, 1),
    'SUM(B3:$B4) + $C$3 + "A1" + [A1]',
  );
  assert.equal(translateFormulaExpression("A1 // keep B2", 1, 1), "B2 // keep B2");
  assert.equal(
    translateFormulaExpression('A1 + "escaped \\"B2"', 1, 1),
    'B2 + "escaped \\"B2"',
  );
  assert.throws(() => translateFormulaExpression("A1", 0, -1), /before A1/);
});

test("Formula columns reject invalid indexes", () => {
  assert.throws(() => spreadsheetColumnName(-1));
  assert.throws(() => spreadsheetColumnName(1.5));
});

test("Formula row insertion shifts targets and structural references", () => {
  assert.equal(
    insertFormulaRows('A1 = B2\nB2 = SUM($A$1:B2) + "A1" + [A1]\n', 1),
    'A1 = B3\nB3 = SUM($A$1:B3) + "A1" + [A1]\n',
  );
});

test("Formula column insertion shifts targets and structural references", () => {
  assert.equal(
    insertFormulaColumns("A1 = B1\nB2 = SUM(A1:$B$2) // C3\n", 1),
    "A1 = C1\nC2 = SUM(A1:$C$2) // C3\n",
  );
  assert.throws(() => insertFormulaColumns("A1 = 1", -1));
});
