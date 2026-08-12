import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createManagedFormulaDataSource,
  applyReferenceGroupSelection,
  directRefExpression,
  duplicateManagedColumn,
  duplicateManagedRow,
  extractManagedRange,
  findNormalizationCandidate,
  insertManagedColumn,
  insertManagedRow,
  managedCellText,
  managedLiteralConstraintIssue,
  normalizeManagedColumns,
  parseManagedCellText,
  renameManagedColumn,
  renameManagedReferenceIdentity,
  renameManagedReferencedColumn,
  renameManagedReferencedSource,
  releaseManagedReferenceGroup,
  setManagedCellText,
} from "../managed-table.js";

test("new Formula tables start as unconstrained 3 by 3 sheets", () => {
  const source = createManagedFormulaDataSource("sheet");
  assert.equal(source.columns.length, 3);
  assert.equal(source.rows.length, 3);
  assert.deepEqual(source.columns.map((column) => column.constraint), [
    "any",
    "any",
    "any",
  ]);
  assert.equal(source.rows.every((row) => row.cells.every((cell) => cell.content.kind === "literal")), true);
  assert.equal(findNormalizationCandidate(source), undefined);
  insertManagedRow(source, 1);
  insertManagedColumn(source, 1);
  assert.equal(source.rows.length, 4);
  assert.equal(source.columns.length, 4);
});

test("renaming a managed column preserves named Formula references", () => {
  const source = createManagedFormulaDataSource("sheet");
  source.rows[0].cells[1].content = {
    kind: "formula",
    expression: '[@Column 1] + LEN("[Column 1]") // [Column 1]',
  };
  renameManagedColumn(source, 0, "Input");
  assert.equal(
    managedCellText(source, 0, 1),
    '=[@Input] + LEN("[Column 1]") // [Column 1]',
  );
  assert.throws(() => renameManagedColumn(source, 0, "Column 2"), /unique/);
});

test("renaming a referenced column updates only related REF target arguments", () => {
  const target = createManagedFormulaDataSource("places");
  target.columns[0].name = "City";
  const source = createManagedFormulaDataSource("orders");
  source.rows[0].cells[0].content = {
    kind: "formula",
    expression:
      'REF("places", "places-1", "City") + REF("other", "other-1", "City") + "REF(\\"places\\", \\"places-1\\", \\"City\\")" // REF("places", "places-1", "City")',
  };
  renameManagedColumn(target, 0, "Locality");
  renameManagedReferencedColumn([source, target], "places", "City", "Locality");
  assert.equal(
    managedCellText(source, 0, 0),
    '=REF("places", "places-1", "Locality") + REF("other", "other-1", "City") + "REF(\\"places\\", \\"places-1\\", \\"City\\")" // REF("places", "places-1", "City")',
  );
  renameManagedReferenceIdentity([source], "places", "places-1", "places-9");
  assert.equal(
    managedCellText(source, 0, 0),
    '=REF("places", "places-9", "Locality") + REF("other", "other-1", "City") + "REF(\\"places\\", \\"places-1\\", \\"City\\")" // REF("places", "places-1", "City")',
  );
});

test("renaming referenced sources and columns preserves scalar identity expressions", () => {
  const target = createManagedFormulaDataSource("places");
  target.columns[0].name = "City";
  const source = createManagedFormulaDataSource("orders");
  source.rows[0].cells[0].content = {
    kind: "formula",
    expression: 'REF("places", CONCAT("place-", A1), "City")',
  };
  renameManagedReferencedColumn([source, target], "places", "City", "Locality");
  assert.equal(
    managedCellText(source, 0, 0),
    '=REF("places", CONCAT("place-", A1), "Locality")',
  );
  renameManagedReferencedSource([source, target], "places", "locations");
  assert.equal(
    managedCellText(source, 0, 0),
    '=REF("locations", CONCAT("place-", A1), "Locality")',
  );
});

test("Any inference stays loose while explicit constraints are strict", () => {
  assert.deepEqual(parseManagedCellText("true", "any"), {
    kind: "literal",
    value: { type: "boolean", value: true },
  });
  assert.deepEqual(parseManagedCellText("42", "any"), {
    kind: "literal",
    value: { type: "integer", value: "42" },
  });
  assert.deepEqual(parseManagedCellText("0042", "any"), {
    kind: "literal",
    value: { type: "string", value: "0042" },
  });
  assert.deepEqual(parseManagedCellText("42", "text"), {
    kind: "literal",
    value: { type: "string", value: "42" },
  });
  assert.deepEqual(parseManagedCellText("0042", "number"), {
    kind: "literal",
    value: { type: "integer", value: "42" },
  });
  assert.deepEqual(parseManagedCellText("   ", "number"), {
    kind: "literal",
    value: { type: "null" },
  });
  assert.throws(() => parseManagedCellText("0x10", "number"), /finite number/);
  assert.throws(() => parseManagedCellText("maybe", "boolean"), /true or false/);
  assert.deepEqual(parseManagedCellText("=A1 * 2", "number"), {
    kind: "formula",
    expression: "A1 * 2",
  });
  assert.equal(
    managedLiteralConstraintIssue(
      { content: { kind: "literal", value: { type: "string", value: "42" } } },
      "number",
    ),
    "requires a Number",
  );
});

test("managed row and column insertion rewrites Formula references", () => {
  const source = createManagedFormulaDataSource("sheet");
  source.rows[0].cells[0].content = { kind: "formula", expression: "B2" };
  source.rows[1].cells[1].content = { kind: "formula", expression: "A1" };
  insertManagedRow(source, 1);
  assert.equal(managedCellText(source, 0, 0), "=B3");
  assert.equal(managedCellText(source, 2, 1), "=A1");
  insertManagedColumn(source, 1);
  assert.equal(managedCellText(source, 0, 0), "=C3");
  assert.equal(managedCellText(source, 2, 2), "=A1");
});

test("duplicating a managed column translates relative Formula references", () => {
  const source = createManagedFormulaDataSource("sheet");
  source.rows[0].cells[0].content = { kind: "formula", expression: "B1" };
  duplicateManagedColumn(source, 0);
  assert.equal(managedCellText(source, 0, 3), "=E1");
});

test("range extraction translates self-contained Formula cells", () => {
  const source = createManagedFormulaDataSource("sheet");
  source.columns[1].name = "Input";
  source.columns[2].name = "Result";
  source.rows[1].cells[1].content = { kind: "literal", value: { type: "integer", value: "4" } };
  source.rows[1].cells[2].content = { kind: "formula", expression: "$B$2 * 2 + [@Input] + HEADER(B)" };
  const extracted = extractManagedRange(
    source,
    { top: 1, bottom: 1, left: 1, right: 2 },
    "extract",
  );
  assert.equal(managedCellText(extracted, 0, 1), "=$A$1 * 2 + [@Input] + HEADER(A)");
  assert.throws(
    () => extractManagedRange(source, { top: 1, bottom: 1, left: 2, right: 2 }, "bad"),
    /outside the selection/,
  );

  source.rows[1].cells[2].content = { kind: "formula", expression: "[@Column 1]" };
  assert.throws(
    () => extractManagedRange(source, { top: 1, bottom: 1, left: 1, right: 2 }, "bad-name"),
    /outside the selection/,
  );

  source.rows[1].cells[2].content = { kind: "formula", expression: "SUM([Input])" };
  assert.throws(
    () => extractManagedRange(source, { top: 1, bottom: 1, left: 1, right: 2 }, "partial-column"),
    /outside the selection/,
  );
});

test("literal duplicates are offered and normalized into a referenced table", () => {
  const source = createManagedFormulaDataSource("orders");
  source.columns = [
    { id: "c1", name: "Order", constraint: "text" },
    { id: "c2", name: "City", constraint: "text" },
    { id: "c3", name: "Country", constraint: "text" },
  ];
  const values = [
    ["1", "Tokyo", "JP"],
    ["2", "Tokyo", "JP"],
    ["3", "Osaka", "JP"],
  ];
  source.rows = values.map((row, rowIndex) => ({
    id: `r${rowIndex + 1}`,
    cells: row.map((value) => ({
      content: { kind: "literal" as const, value: { type: "string" as const, value } },
    })),
  }));
  const candidate = findNormalizationCandidate(source);
  assert.deepEqual(candidate, {
    top: 0,
    bottom: 2,
    left: 1,
    right: 2,
    duplicateRows: 1,
    uniqueRows: 2,
  });
  if (!candidate) throw new Error("missing candidate");
  const result = normalizeManagedColumns(source, candidate, "places");
  assert.deepEqual(result.source.columns.map((column) => column.name), [
    "Order",
    "City",
    "Country",
  ]);
  assert.deepEqual(result.source.referenceGroups, [{
    id: "ref1",
    source: "places",
    rowIds: ["r1", "r2", "r3"],
    columns: [
      { columnId: "c2", targetColumnId: "c1" },
      { columnId: "c3", targetColumnId: "c2" },
    ],
  }]);
  assert.equal(
    managedCellText(result.source, 0, 1),
    '=REF("places", "places-1", "City")',
  );
  assert.equal(
    managedCellText(result.source, 0, 2),
    '=REF("places", "places-1", "Country")',
  );
  assert.equal(result.target.rows.length, 2);
  assert.deepEqual(result.target.columns.map((column) => column.name), [
    "City",
    "Country",
    "ID",
  ]);
  assert.equal(result.target.columns[2].identity, true);

  applyReferenceGroupSelection(result.source, result.target, "ref1", 0, 1);
  assert.equal(
    managedCellText(result.source, 0, 1),
    '=REF("places", "places-2", "City")',
  );
  assert.equal(
    managedCellText(result.source, 0, 2),
    '=REF("places", "places-2", "Country")',
  );
  const preservedFormula = managedCellText(result.source, 0, 1);
  assert.throws(
    () => setManagedCellText(result.source, 0, 1, '=REF("places", "places-2", "City") + "!"'),
    /protected by reference group/,
  );
  assert.equal(releaseManagedReferenceGroup(result.source, "ref1"), true);
  assert.equal(managedCellText(result.source, 0, 1), preservedFormula);
  setManagedCellText(
    result.source,
    0,
    1,
    '=REF("places", "places-2", "City") + "!"',
  );
  assert.equal(
    managedCellText(result.source, 0, 1),
    '=REF("places", "places-2", "City") + "!"',
  );

  const normalizedAgain = normalizeManagedColumns(source, candidate, "places-2");
  insertManagedRow(normalizedAgain.source, 1);
  assert.equal(normalizedAgain.source.referenceGroups?.[0]?.rowIds.includes("r4"), true);

  insertManagedRow(result.target, 1);
  assert.equal(managedCellText(result.target, 1, 2), "places-3");
  duplicateManagedRow(result.target, 0);
  assert.equal(managedCellText(result.target, 3, 2), "places-4");
  assert.equal(
    new Set(result.target.rows.map((row) => row.cells[2]?.content.kind === "literal"
      ? row.cells[2].content.value.type === "string"
        ? row.cells[2].content.value.value
        : undefined
      : undefined)).size,
    result.target.rows.length,
  );
});

test("normalization keeps the generated identity column name unique", () => {
  const source = createManagedFormulaDataSource("records");
  source.columns = [
    { id: "c1", name: "Name", constraint: "any" },
    { id: "c2", name: "ID", constraint: "any" },
    { id: "c3", name: "Group", constraint: "any" },
  ];
  source.rows = ["A", "B", "A"].map((value, index) => ({
    id: `r${index + 1}`,
    cells: [
      { content: { kind: "literal" as const, value: { type: "string" as const, value: String(index) } } },
      { content: { kind: "literal" as const, value: { type: "string" as const, value } } },
      { content: { kind: "literal" as const, value: { type: "string" as const, value: "shared" } } },
    ],
  }));
  const candidate = findNormalizationCandidate(source);
  assert.ok(candidate);
  const result = normalizeManagedColumns(source, candidate, "groups");
  assert.equal(result.target.columns[2].name, "ID 2");
});

test("reference selection uses evaluated Formula identity values", () => {
  assert.equal(
    directRefExpression("places", { type: "real", value: 1 }, "City"),
    'REF("places", 1.0, "City")',
  );
  const source = createManagedFormulaDataSource("contacts");
  source.columns = [
    { id: "c1", name: "Name", constraint: "text" },
    { id: "c2", name: "City", constraint: "text" },
    { id: "c3", name: "Country", constraint: "text" },
  ];
  source.rows = ["Tokyo", "Osaka", "Tokyo"].map((city, index) => ({
    id: `r${index + 1}`,
    cells: [
      { content: { kind: "literal" as const, value: { type: "string" as const, value: `Person ${index + 1}` } } },
      { content: { kind: "literal" as const, value: { type: "string" as const, value: city } } },
      { content: { kind: "literal" as const, value: { type: "string" as const, value: "JP" } } },
    ],
  }));
  const candidate = findNormalizationCandidate(source);
  assert.ok(candidate);
  const result = normalizeManagedColumns(source, candidate, "places");
  const identityColumn = result.target.columns.findIndex((column) => column.identity);
  result.target.rows[1].cells[identityColumn].content = {
    kind: "formula",
    expression: '"computed-place"',
  };
  const evaluatedTarget = {
    source: "places",
    kind: "table" as const,
    columns: result.target.columns.map((column) => column.name),
    rows: result.target.rows.map((row, index) => row.cells.map((cell, column) =>
      column === identityColumn && index === 1
        ? { type: "string" as const, value: "computed-place" }
        : cell.content.kind === "literal"
          ? { ...cell.content.value }
          : { type: "null" as const },
    )),
  };

  applyReferenceGroupSelection(
    result.source,
    result.target,
    result.source.referenceGroups?.[0]?.id ?? "",
    0,
    1,
    evaluatedTarget,
  );
  assert.equal(
    managedCellText(result.source, 0, 1),
    '=REF("places", "computed-place", "City")',
  );
});
