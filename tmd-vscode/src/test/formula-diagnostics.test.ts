import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formulaDiagnosticFromIssue,
  formulaUtf16Offset,
} from "../formula-diagnostics.js";

test("Formula diagnostics retain program line and column", () => {
  assert.deepEqual(
    formulaDiagnosticFromIssue(
      "Formula source `totals` cell `C1` failed (line 2, column 6): #REF! bad cell",
    ),
    {
      message:
        "Formula source `totals` cell `C1` failed (line 2, column 6): #REF! bad cell",
      line: 2,
      column: 6,
    },
  );
});

test("Formula diagnostics accept compact and locationless errors", () => {
  assert.equal(formulaDiagnosticFromIssue("failed at 4:9").line, 4);
  assert.deepEqual(formulaDiagnosticFromIssue("formula unavailable"), {
    message: "formula unavailable",
  });
});

test("Formula diagnostic columns map Unicode scalars to CodeMirror offsets", () => {
  assert.equal(formulaUtf16Offset("😀)", 2), 2);
  assert.equal(formulaUtf16Offset("β)", 2), 1);
  assert.equal(formulaUtf16Offset("short", 99), 5);
});
