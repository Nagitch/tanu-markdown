import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extrasWithDataSources,
  inspectDataSourceRegistry,
  validateDataSources,
} from "../data-sources.js";

test("data-source registry exposes ordered SQLite source content", () => {
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
  assert.equal(first?.type, "sqlite");
  assert.match(first?.type === "sqlite" ? first.query : "", /WHERE id = 1/);
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
      type: "sqlite",
      query: "SELECT category, amount_cents FROM sales ORDER BY id",
    },
  ]);
});

test("editing sources preserves unrelated manifest extras", () => {
  const extras = extrasWithDataSources(
    { application: { theme: "dark" } },
    [
      {
        name: "count",
        type: "sqlite",
        query: "SELECT count(*) FROM sample_notes",
      },
    ],
  );

  assert.deepEqual(extras, {
    application: { theme: "dark" },
    tmd_data_sources: {
      schema_version: 1,
      sources: {
        count: {
          type: "sqlite",
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
      type: "sqlite",
      query: "SELECT 1 AS value",
    },
  ]);

  const registry = inspectDataSourceRegistry(extras);
  assert.equal(registry.editable, true);
  assert.deepEqual(registry.sources, [
    {
      name: "__proto__",
      type: "sqlite",
      query: "SELECT 1 AS value",
    },
  ]);
});

test("editing Rhai sources writes schema version 2 and preserves output order", () => {
  const extras = extrasWithDataSources(
    { application: { retained: true } },
    [
      {
        name: "sales",
        type: "sqlite",
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
      schema_version: 2,
      sources: {
        sales: {
          type: "sqlite",
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
    tmd_data_sources: { schema_version: 3, sources: {} },
  });

  assert.equal(registry.editable, false);
  assert.match(registry.issue ?? "", /expected 1 or 2/);
});

test("source edits reject duplicate and invalid names", () => {
  assert.throws(
    () =>
      validateDataSources([
        { name: "duplicate", type: "sqlite", query: "SELECT 1" },
        { name: "duplicate", type: "sqlite", query: "SELECT 2" },
      ]),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validateDataSources([
        { name: "invalid name", type: "sqlite", query: "SELECT 1" },
      ]),
    /Invalid source name/,
  );
});

test("Rhai inputs must resolve directly to SQLite sources", () => {
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
    /must reference a SQLite source/,
  );
});
