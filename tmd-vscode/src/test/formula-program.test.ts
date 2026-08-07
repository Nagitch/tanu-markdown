import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formulaExpressionForCell,
  setFormulaCellExpression,
  spreadsheetCellName,
  spreadsheetColumnName,
  translateFormulaExpression,
} from "../formula-program.js";

test("Formula columns use familiar A1 spreadsheet labels", () => {
  assert.equal(spreadsheetColumnName(0), "A");
  assert.equal(spreadsheetColumnName(25), "Z");
  assert.equal(spreadsheetColumnName(26), "AA");
  assert.equal(spreadsheetColumnName(127), "DX");
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
