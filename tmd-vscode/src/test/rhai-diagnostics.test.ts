import assert from "node:assert/strict";
import { test } from "node:test";
import { rhaiDiagnosticFromIssue } from "../rhai-diagnostics.js";

test("Rhai diagnostics retain line and position information", () => {
  const issue = "Syntax error: Expecting expression (line 7, position 13)";
  assert.deepEqual(rhaiDiagnosticFromIssue(issue), {
    message: issue,
    line: 7,
    column: 13,
  });
});

test("Rhai diagnostics accept compact runtime locations and locationless errors", () => {
  assert.deepEqual(rhaiDiagnosticFromIssue("failure at 4:9"), {
    message: "failure at 4:9",
    line: 4,
    column: 9,
  });
  assert.deepEqual(rhaiDiagnosticFromIssue("execution timed out"), {
    message: "execution timed out",
  });
});
