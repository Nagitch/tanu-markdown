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
  assert.match(registry.sources[0]?.query ?? "", /WHERE id = 1/);
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
  assert.match(registry.issue ?? "", /schema_version 2/);
  assert.match(registry.rawRegistry ?? "", /profile\.json/);
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
