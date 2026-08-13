import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extrasWithDataSources,
  inspectDataSourceRegistry,
  isManagedFormulaDataSource,
  sameDataSources,
  validateDataSources,
} from "../data-sources.js";
import { createManagedFormulaDataSource } from "../managed-table.js";

test("legacy registries expose SQLite queries as ordered Formula tables", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 1,
      sources: {
        "sample-notes": {
          type: "sqlite",
          query: "SELECT id, body FROM sample_notes ORDER BY id",
        },
        "first-note": {
          type: "sqlite",
          query: "SELECT body FROM sample_notes WHERE id = 1",
        },
      },
    },
  });

  assert.equal(registry.editable, true);
  assert.deepEqual(
    registry.sources.map((source) => source.name),
    ["first-note", "sample-notes"],
  );
  const first = registry.sources[0];
  assert.equal(first?.type, "formula");
  assert.match(first && "query" in first ? first.query : "", /WHERE id = 1/);
});

test("schema-version-2 registries expose SQLite and Rhai table sources", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 2,
      sources: {
        sales: {
          type: "sqlite",
          query: "SELECT category, amount_cents FROM sales ORDER BY id",
        },
        "category-summary": {
          type: "rhai",
          script: "views/category-summary.rhai",
          inputs: { rows: "sales" },
          output: {
            type: "table",
            columns: ["category", "total_cents"],
          },
        },
      },
    },
  });

  assert.equal(registry.editable, true);
  assert.equal(registry.schemaVersion, 2);
  assert.deepEqual(registry.sources, [
    {
      name: "category-summary",
      type: "rhai",
      script: "views/category-summary.rhai",
      inputs: [{ alias: "rows", source: "sales" }],
      outputColumns: ["category", "total_cents"],
    },
    {
      name: "sales",
      type: "formula",
      query: "SELECT category, amount_cents FROM sales ORDER BY id",
    },
  ]);
});

test("schema-version-3 registries expose Formula sources and retain Rhai", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 3,
      sources: {
        sales: {
          type: "sqlite",
          query: "SELECT category, amount_cents FROM sales ORDER BY id",
        },
        summary: {
          type: "formula",
          input: "sales",
          program: "C1 = SUM(B1:B3)",
          output: {
            type: "table",
            columns: ["category", "amount_cents", "total_cents"],
          },
        },
        projected: {
          type: "rhai",
          script: "views/projected.rhai",
          inputs: { rows: "sales" },
          output: { type: "table", columns: ["category"] },
        },
      },
    },
  });

  assert.equal(registry.editable, true);
  assert.equal(registry.schemaVersion, 3);
  assert.deepEqual(registry.sources, [
    {
      name: "projected",
      type: "rhai",
      script: "views/projected.rhai",
      inputs: [{ alias: "rows", source: "sales" }],
      outputColumns: ["category"],
    },
    {
      name: "sales",
      type: "formula",
      query: "SELECT category, amount_cents FROM sales ORDER BY id",
    },
    {
      name: "summary",
      type: "formula",
      input: "sales",
      program: "C1 = SUM(B1:B3)",
      outputColumns: ["category", "amount_cents", "total_cents"],
    },
  ]);
});

test("source edits migrate an explicit SQLite edit contract to Formula schema 8", () => {
  const sources = [
    {
      name: "sales",
      type: "formula" as const,
      query: "SELECT id, category, amount_cents FROM sales ORDER BY id",
      edit: {
        table: "sales",
        keySourceColumn: "id",
        keyTableColumn: "id",
        columns: [
          { sourceColumn: "category", tableColumn: "category" },
          { sourceColumn: "amount_cents", tableColumn: "amount_cents" },
        ],
      },
    },
  ];
  const extras = extrasWithDataSources(null, sources);
  assert.deepEqual(extras, {
    tmd_data_sources: {
      schema_version: 8,
      sources: {
        sales: {
          type: "formula",
          query: "SELECT id, category, amount_cents FROM sales ORDER BY id",
          edit: {
            table: "sales",
            key: { source_column: "id", table_column: "id" },
            columns: {
              amount_cents: "amount_cents",
              category: "category",
            },
          },
        },
      },
    },
  });
  assert.deepEqual(inspectDataSourceRegistry(extras).sources, [
    {
      ...sources[0],
      edit: {
        ...sources[0]?.edit,
        columns: [
          { sourceColumn: "amount_cents", tableColumn: "amount_cents" },
          { sourceColumn: "category", tableColumn: "category" },
        ],
      },
    },
  ]);
});

test("editing sources preserves unrelated manifest extras", () => {
  const extras = extrasWithDataSources(
    { application: { theme: "dark" } },
    [
      {
        name: "count",
        type: "formula",
        query: "SELECT count(*) FROM sample_notes",
      },
    ],
  );

  assert.deepEqual(extras, {
    application: { theme: "dark" },
    tmd_data_sources: {
      schema_version: 8,
      sources: {
        count: {
          type: "formula",
          query: "SELECT count(*) FROM sample_notes",
        },
      },
    },
  });
});

test("source names that resemble object properties remain ordinary definitions", () => {
  const extras = extrasWithDataSources(null, [
    {
      name: "__proto__",
      type: "formula",
      query: "SELECT 1 AS value",
    },
  ]);

  const registry = inspectDataSourceRegistry(extras);
  assert.equal(registry.editable, true);
  assert.deepEqual(registry.sources, [
    {
      name: "__proto__",
      type: "formula",
      query: "SELECT 1 AS value",
    },
  ]);
});

test("editing Rhai sources writes schema version 8 and preserves output order", () => {
  const extras = extrasWithDataSources(
    { application: { retained: true } },
    [
      {
        name: "sales",
        type: "formula",
        query: "SELECT category, amount_cents FROM sales ORDER BY id",
      },
      {
        name: "summary",
        type: "rhai",
        script: "views/summary.rhai",
        inputs: [{ alias: "rows", source: "sales" }],
        outputColumns: ["category", "total_cents"],
      },
    ],
  );

  assert.deepEqual(extras, {
    application: { retained: true },
    tmd_data_sources: {
      schema_version: 8,
      sources: {
        sales: {
          type: "formula",
          query: "SELECT category, amount_cents FROM sales ORDER BY id",
        },
        summary: {
          type: "rhai",
          script: "views/summary.rhai",
          inputs: { rows: "sales" },
          output: {
            type: "table",
            columns: ["category", "total_cents"],
          },
        },
      },
    },
  });
});

test("editing Formula sources upgrades the registry to version 8 and round trips", () => {
  const extras = extrasWithDataSources(
    { application: { retained: true } },
    [
      {
        name: "sales",
        type: "formula",
        query: "SELECT category, amount_cents FROM sales ORDER BY id",
      },
      {
        name: "summary",
        type: "formula",
        input: "sales",
        program: "C1 = SUM(B1:B3)",
        outputColumns: ["category", "amount_cents", "total_cents"],
      },
    ],
  );

  assert.deepEqual(extras, {
    application: { retained: true },
    tmd_data_sources: {
      schema_version: 8,
      sources: {
        sales: {
          type: "formula",
          query: "SELECT category, amount_cents FROM sales ORDER BY id",
        },
        summary: {
          type: "formula",
          input: "sales",
          program: "C1 = SUM(B1:B3)",
          output: {
            type: "table",
            columns: ["category", "amount_cents", "total_cents"],
          },
        },
      },
    },
  });
  assert.deepEqual(inspectDataSourceRegistry(extras).sources, [
    {
      name: "sales",
      type: "formula",
      query: "SELECT category, amount_cents FROM sales ORDER BY id",
    },
    {
      name: "summary",
      type: "formula",
      input: "sales",
      program: "C1 = SUM(B1:B3)",
      outputColumns: ["category", "amount_cents", "total_cents"],
    },
  ]);
});

test("unsupported registries remain visible and read-only", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 2,
      sources: {
        profile: { type: "json", attachment: "profile.json" },
      },
    },
  });

  assert.equal(registry.editable, false);
  assert.match(registry.issue ?? "", /unsupported type `json`/);
  assert.match(registry.rawRegistry ?? "", /profile\.json/);
});

test("unknown registry versions remain visible and read-only", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: { schema_version: 9, sources: {} },
  });

  assert.equal(registry.editable, false);
  assert.match(registry.issue ?? "", /expected 1 through 8/);
});

test("Formula sources require schema version 3", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 2,
      sources: {
        sales: { type: "sqlite", query: "SELECT amount FROM sales" },
        summary: {
          type: "formula",
          input: "sales",
          program: "B1 = SUM(A1:A3)",
          output: { type: "table", columns: ["amount", "total"] },
        },
      },
    },
  });

  assert.equal(registry.editable, false);
  assert.match(registry.issue ?? "", /requires schema_version 3/);
});

test("schema version 5 accepts Formula query sources and rejects SQLite tags", () => {
  const formula = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 5,
      sources: {
        sales: { type: "formula", query: "SELECT amount FROM sales" },
      },
    },
  });
  assert.equal(formula.editable, true);
  assert.deepEqual(formula.sources, [
    {
      name: "sales",
      type: "formula",
      query: "SELECT amount FROM sales",
    },
  ]);

  const sqlite = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 5,
      sources: {
        sales: { type: "sqlite", query: "SELECT amount FROM sales" },
      },
    },
  });
  assert.equal(sqlite.editable, false);
  assert.match(sqlite.issue ?? "", /removed SQLite type/);
});

test("schema version 6 managed Formula tables upgrade to version 8", () => {
  const sources = [
    {
      name: "sheet",
      type: "formula" as const,
      columns: [
        { id: "c1", name: "Item", constraint: "text" as const },
        { id: "c2", name: "Amount", constraint: "any" as const },
        { id: "c3", name: "Category", constraint: "text" as const },
      ],
      rows: [
        {
          id: "r1",
          cells: [
            { content: { kind: "literal" as const, value: { type: "string" as const, value: "Tea" } } },
            {
              constraint: "number" as const,
              content: { kind: "formula" as const, expression: "D1 * 2" },
            },
            { content: { kind: "literal" as const, value: { type: "string" as const, value: "categories-1" } } },
          ],
        },
      ],
    },
  ];
  const extras = extrasWithDataSources(null, sources);
  assert.equal(
    (extras as { tmd_data_sources: { schema_version: number } }).tmd_data_sources.schema_version,
    8,
  );
  assert.deepEqual(
    inspectDataSourceRegistry(extras).sources,
    [...sources].sort((left, right) => left.name.localeCompare(right.name)),
  );
});

test("Rhai inputs may read managed Formula tables", () => {
  const sheet = {
    name: "sheet",
    type: "formula" as const,
    columns: [{ id: "c1", name: "Value", constraint: "any" as const }],
    rows: [{ id: "r1", cells: [{ content: { kind: "literal" as const, value: { type: "integer" as const, value: "1" } } }] }],
  };
  assert.doesNotThrow(() =>
    validateDataSources([
      sheet,
      {
        name: "view",
        type: "rhai",
        script: "views/view.rhai",
        inputs: [{ alias: "rows", source: "sheet" }],
        outputColumns: ["Value"],
      },
    ]),
  );
});

test("managed Formula tables require schema 6 through 8 and exact cell shapes", () => {
  const definition = {
    type: "formula",
    columns: [{ id: "c1", name: "Value", constraint: "any" }],
    rows: [
      {
        id: "r1",
        cells: [
          {
            content: {
              kind: "literal",
              value: { type: "integer", value: "1" },
            },
          },
        ],
      },
    ],
  };
  assert.equal(
    inspectDataSourceRegistry({
      tmd_data_sources: {
        schema_version: 6,
        sources: {
          sheet: {
            ...definition,
            rows: [{
              ...definition.rows[0],
              cells: [{
                content: {
                  ...definition.rows[0].cells[0].content,
                  unexpected: true,
                },
              }],
            }],
          },
        },
      },
    }).editable,
    false,
  );
  assert.match(
    inspectDataSourceRegistry({
      tmd_data_sources: { schema_version: 5, sources: { sheet: definition } },
    }).issue ?? "",
    /requires schema_version 6/,
  );

  const leadingEquals = {
    ...definition,
    rows: [{
      ...definition.rows[0],
      cells: [{ content: { kind: "formula", expression: " =1" } }],
    }],
  };
  assert.match(
    inspectDataSourceRegistry({
      tmd_data_sources: { schema_version: 6, sources: { sheet: leadingEquals } },
    }).issue ?? "",
    /without a leading '='/,
  );

  const hidden = {
    ...definition,
    columns: [{ ...definition.columns[0], hidden: true }],
  };
  assert.match(
    inspectDataSourceRegistry({
      tmd_data_sources: { schema_version: 6, sources: { sheet: hidden } },
    }).issue ?? "",
    /not an editable managed Formula table/,
  );

  const validHiddenSuffix = {
    ...definition,
    columns: [
      definition.columns[0],
      { id: "c2", name: "Storage", constraint: "text", hidden: true },
    ],
    rows: [{
      ...definition.rows[0],
      cells: [
        definition.rows[0].cells[0],
        { content: { kind: "literal", value: { type: "string", value: "key-1" } } },
      ],
    }],
  };
  const parsed = inspectDataSourceRegistry({
    tmd_data_sources: { schema_version: 7, sources: { sheet: validHiddenSuffix } },
  });
  assert.equal(parsed.editable, true);
  assert.equal(
    parsed.sources[0]?.type === "formula" && "columns" in parsed.sources[0]
      ? parsed.sources[0].columns[1]?.hidden
      : undefined,
    undefined,
  );

  const invalidHiddenOrder = createManagedFormulaDataSource("invalid");
  invalidHiddenOrder.columns[0].hidden = true;
  assert.throws(
    () => validateDataSources([invalidHiddenOrder]),
    /removed hidden-column/,
  );
});

test("schema 7 normalization keys migrate to visible identity reference groups", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 7,
      sources: {
        places: {
          type: "formula",
          columns: [
            { id: "city", name: "City", constraint: "text" },
            { id: "id", name: "ID", constraint: "any", hidden: true },
          ],
          rows: [
            {
              id: "p1",
              cells: [
                { content: { kind: "literal", value: { type: "string", value: "Tokyo" } } },
                { content: { kind: "literal", value: { type: "integer", value: "1" } } },
              ],
            },
            {
              id: "p2",
              cells: [
                { content: { kind: "literal", value: { type: "string", value: "Kyoto" } } },
                { content: { kind: "literal", value: { type: "string", value: "1" } } },
              ],
            },
            {
              id: "p3",
              cells: [
                { content: { kind: "literal", value: { type: "string", value: "Unused" } } },
                { content: { kind: "literal", value: { type: "null" } } },
              ],
            },
          ],
        },
        contacts: {
          type: "formula",
          columns: [
            { id: "city", name: "City", constraint: "text" },
            {
              id: "place-ref",
              name: "place_ref",
              constraint: "text",
              hidden: true,
              reference: { source: "places", column_id: "id" },
            },
          ],
          rows: [
            {
              id: "r1",
              cells: [
                { content: { kind: "formula", expression: 'REF([@place_ref], "City")' } },
                { content: { kind: "literal", value: { type: "integer", value: "1" } } },
              ],
            },
            {
              id: "r2",
              cells: [
                { content: { kind: "formula", expression: 'REF([@place_ref], "City")' } },
                { content: { kind: "literal", value: { type: "string", value: "1" } } },
              ],
            },
            {
              id: "r3",
              cells: [
                { content: { kind: "formula", expression: 'REF([@place_ref], "City")' } },
                { content: { kind: "literal", value: { type: "null" } } },
              ],
            },
          ],
        },
      },
    },
  });
  assert.equal(registry.editable, true);
  const contacts = registry.sources.find((source) => source.name === "contacts");
  const places = registry.sources.find((source) => source.name === "places");
  assert.ok(contacts && isManagedFormulaDataSource(contacts));
  assert.ok(places && isManagedFormulaDataSource(places));
  assert.deepEqual(contacts.columns.map((column) => column.name), ["City"]);
  assert.equal(
    contacts.rows[0]?.cells[0]?.content.kind === "formula"
      ? contacts.rows[0].cells[0].content.expression
      : undefined,
    'REF("places", "integer:1", "City")',
  );
  assert.equal(contacts.referenceGroups?.[0]?.source, "places");
  assert.deepEqual(contacts.referenceGroups?.[0]?.rowIds, ["r1", "r2", "r3"]);
  assert.equal(
    contacts.rows[1]?.cells[0]?.content.kind === "formula"
      ? contacts.rows[1].cells[0].content.expression
      : undefined,
    'REF("places", "1", "City")',
  );
  assert.deepEqual(contacts.rows[2]?.cells[0]?.content, {
    kind: "literal",
    value: { type: "null" },
  });
  assert.equal(places.columns[1]?.identity, true);
  assert.equal(places.columns[1]?.constraint, "text");
  assert.equal(places.columns[1]?.hidden, undefined);
  assert.deepEqual(
    places.rows.map((row) => row.cells[1]?.content),
    [
      { kind: "literal", value: { type: "string", value: "integer:1" } },
      { kind: "literal", value: { type: "string", value: "1" } },
      { kind: "literal", value: { type: "string", value: "places-1" } },
    ],
  );

  const protectedCell = contacts.rows[0]?.cells[0];
  assert.ok(protectedCell?.content.kind === "formula");
  const validExpression = protectedCell.content.expression;
  protectedCell.content.expression = `${validExpression} + "!"`;
  assert.throws(
    () => validateDataSources(registry.sources),
    /mapped direct three-argument REF/,
  );
  protectedCell.content.expression = validExpression;
  const unselectedCell = contacts.rows[2]?.cells[0];
  assert.ok(unselectedCell);
  unselectedCell.content = {
    kind: "formula",
    expression: 'REF("places", "places-1", "City")',
  };
  assert.doesNotThrow(() => validateDataSources(registry.sources));
});

test("schema 7 migration preserves visible reference columns as ordinary data", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 7,
      sources: {
        target: {
          type: "formula",
          columns: [
            { id: "value", name: "Value", constraint: "text" },
            { id: "id", name: "ID", constraint: "text", hidden: true },
          ],
          rows: [{
            id: "t1",
            cells: [
              { content: { kind: "literal", value: { type: "string", value: "Tokyo" } } },
              { content: { kind: "literal", value: { type: "string", value: "target-1" } } },
            ],
          }],
        },
        source: {
          type: "formula",
          columns: [
            { id: "value", name: "Value", constraint: "text" },
            {
              id: "foreign-key",
              name: "Foreign Key",
              constraint: "text",
              reference: { source: "target", column_id: "id" },
            },
          ],
          rows: [{
            id: "s1",
            cells: [
              { content: { kind: "formula", expression: 'REF([@Foreign Key], "Value")' } },
              { content: { kind: "literal", value: { type: "string", value: "target-1" } } },
            ],
          }],
        },
      },
    },
  });
  assert.equal(registry.editable, true);
  const source = registry.sources.find((candidate) => candidate.name === "source");
  assert.ok(source && isManagedFormulaDataSource(source));
  assert.deepEqual(source.columns.map((column) => column.name), [
    "Value",
    "Foreign Key",
  ]);
  assert.equal(source.columns[1]?.reference, undefined);
  assert.equal(
    source.rows[0]?.cells[1]?.content.kind === "literal"
      ? source.rows[0].cells[1].content.value.type
      : undefined,
    "string",
  );
});

test("schema 7 migration keeps hidden keys used by ordinary formulas", () => {
  const registry = inspectDataSourceRegistry({
    tmd_data_sources: {
      schema_version: 7,
      sources: {
        target: {
          type: "formula",
          columns: [
            { id: "value", name: "Value", constraint: "text" },
            { id: "id", name: "ID", constraint: "text", hidden: true },
          ],
          rows: [{
            id: "t1",
            cells: [
              { content: { kind: "literal", value: { type: "string", value: "Tokyo" } } },
              { content: { kind: "literal", value: { type: "string", value: "target-1" } } },
            ],
          }],
        },
        source: {
          type: "formula",
          columns: [
            { id: "value", name: "Value", constraint: "text" },
            { id: "note", name: "Note", constraint: "text" },
            {
              id: "foreign-key",
              name: "Foreign Key",
              constraint: "text",
              hidden: true,
              reference: { source: "target", column_id: "id" },
            },
          ],
          rows: [{
            id: "s1",
            cells: [
              { content: { kind: "formula", expression: 'REF([@Foreign Key], "Value")' } },
              { content: { kind: "formula", expression: '[@Foreign Key] + "!"' } },
              { content: { kind: "literal", value: { type: "string", value: "target-1" } } },
            ],
          }],
        },
      },
    },
  });
  assert.equal(registry.editable, true);
  const source = registry.sources.find((candidate) => candidate.name === "source");
  assert.ok(source && isManagedFormulaDataSource(source));
  assert.deepEqual(source.columns.map((column) => column.name), [
    "Value",
    "Note",
    "Foreign Key",
  ]);
  assert.equal(source.columns[2]?.hidden, undefined);
  assert.equal(source.columns[2]?.reference, undefined);
  assert.equal(
    source.rows[0]?.cells[1]?.content.kind === "formula"
      ? source.rows[0].cells[1].content.expression
      : undefined,
    '[@Foreign Key] + "!"',
  );
});

test("source edits reject duplicate and invalid names", () => {
  assert.throws(
    () =>
      validateDataSources([
        { name: "duplicate", type: "formula", query: "SELECT 1" },
        { name: "duplicate", type: "formula", query: "SELECT 2" },
      ]),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validateDataSources([
        { name: "invalid name", type: "formula", query: "SELECT 1" },
      ]),
    /Invalid source name/,
  );
});

test("Rhai inputs must resolve directly to a supported Formula table", () => {
  assert.throws(
    () =>
      validateDataSources([
        {
          name: "first-view",
          type: "rhai",
          script: "views/first.rhai",
          inputs: [{ alias: "rows", source: "second-view" }],
          outputColumns: ["value"],
        },
        {
          name: "second-view",
          type: "rhai",
          script: "views/second.rhai",
          inputs: [{ alias: "rows", source: "first-view" }],
          outputColumns: ["value"],
        },
      ]),
    /must reference a managed or query Formula table/,
  );
});

test("computed Formula input must resolve directly to a Formula query source", () => {
  assert.throws(
    () =>
      validateDataSources([
        {
          name: "summary",
          type: "formula",
          input: "missing",
          program: "A1 = SUM(A1:A3)",
          outputColumns: ["total"],
        },
      ]),
    /references undefined source `missing`/,
  );
  assert.throws(
    () =>
      validateDataSources([
        { name: "sales", type: "formula", query: "SELECT amount FROM sales" },
        {
          name: "projected",
          type: "rhai",
          script: "views/projected.rhai",
          inputs: [{ alias: "rows", source: "sales" }],
          outputColumns: ["amount"],
        },
        {
          name: "summary",
          type: "formula",
          input: "projected",
          program: "A1 = SUM(A1:A3)",
          outputColumns: ["total"],
        },
      ]),
    /must reference a Formula query source/,
  );
});

test("Formula programs and output columns use bounded registry values", () => {
  assert.throws(
    () =>
      validateDataSources([
        { name: "sales", type: "formula", query: "SELECT amount FROM sales" },
        {
          name: "summary",
          type: "formula",
          input: "sales",
          program: "x".repeat(256 * 1024 + 1),
          outputColumns: ["total"],
        },
      ]),
    /program exceeds 262144 bytes/,
  );
  assert.throws(
    () =>
      validateDataSources([
        { name: "sales", type: "formula", query: "SELECT amount FROM sales" },
        {
          name: "summary",
          type: "formula",
          input: "sales",
          program: "A1 = SUM(A1:A3)",
          outputColumns: ["total", "total"],
        },
      ]),
    /repeats output column `total`/,
  );
});

test("Formula program changes participate in data-source equality", () => {
  const initial = [
    { name: "sales", type: "formula" as const, query: "SELECT amount FROM sales" },
    {
      name: "summary",
      type: "formula" as const,
      input: "sales",
      program: "A1 = SUM(A1:A3)",
      outputColumns: ["total"],
    },
  ];
  assert.equal(sameDataSources(initial, initial.map((source) => ({ ...source }))), true);
  const edited = initial.map((source) =>
    source.type === "formula" && "program" in source
      ? { ...source, program: "A1 = A1" }
      : { ...source },
  );
  assert.equal(
    sameDataSources(initial, edited),
    false,
  );
});
