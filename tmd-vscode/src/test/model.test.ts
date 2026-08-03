import assert from "node:assert/strict";
import { test } from "node:test";
import {
  persistRetainedDocument,
  persistLatestEditorState,
  TanuMarkdownModel,
  type EditorState,
} from "../model.js";
import type { DataSource, DocumentInspection } from "../types.js";

function inspection(
  markdown: string,
  title: string,
  databaseUserVersion: number,
): DocumentInspection {
  return {
    schema_version: 1,
    format: "tmd",
    markdown,
    manifest: {
      title,
      authors: [],
      tags: [],
      extras: null,
    },
    attachments: [],
    database_user_version: databaseUserVersion,
    database: {
      user_version: databaseUserVersion,
      objects: [],
    },
    validation: {
      valid: true,
      issues: [],
      attachment_references: [],
      database_user_version: databaseUserVersion,
    },
  };
}

function state(
  markdown: string,
  title: string,
  dataSources: DataSource[] = [],
): EditorState {
  return { dataSources, markdown, title };
}

test("persisted inspection preserves edits made while an operation was pending", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const savedRevision = model.contentRevision;

  model.applyState(state("newer edit", "Newer title"));
  model.applyPersistedInspection(
    inspection("saved snapshot", "Saved title", 2),
    savedRevision,
  );

  assert.deepEqual(model.snapshot(), {
    dataSources: [],
    markdown: "newer edit",
    title: "Newer title",
  });
  assert.equal(model.inspection.database_user_version, 2);
  assert.equal(model.persistedRevision, savedRevision);
  assert.notEqual(model.persistedRevision, model.contentRevision);
  assert.equal(model.isCurrentRevisionPersisted, false);
  assert.equal(model.isValidationCurrent, false);
});

test("save response replaces state when no newer edit exists", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const savedRevision = model.contentRevision;

  model.applyPersistedInspection(
    inspection("saved snapshot", "Saved title", 1),
    savedRevision,
  );

  assert.deepEqual(model.snapshot(), {
    dataSources: [],
    markdown: "saved snapshot",
    title: "Saved title",
  });
  assert.equal(model.persistedRevision, model.contentRevision);
  assert.equal(model.isCurrentRevisionPersisted, true);
  assert.equal(model.isValidationCurrent, true);
});

test("undo and redo restore the persisted save point", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const initial = model.snapshot();

  model.applyState(state("saved edit", "Saved title"));
  const savedRevision = model.contentRevision;
  model.applyPersistedInspection(
    inspection("saved edit", "Saved title", 0),
    savedRevision,
  );
  const saved = model.snapshot();
  assert.equal(model.isCurrentRevisionPersisted, true);

  model.applyState(initial);
  assert.equal(model.isCurrentRevisionPersisted, false);

  model.applyState(saved);
  assert.equal(model.isCurrentRevisionPersisted, true);
});

test("undoing the first edit restores the initially persisted state", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const initial = model.snapshot();

  model.applyState(state("unsaved edit", "Unsaved title"));
  assert.equal(model.isCurrentRevisionPersisted, false);

  model.applyState(initial);
  assert.equal(model.isCurrentRevisionPersisted, true);
});

test("SQLite source edits participate in document dirty state and undo", () => {
  const document = inspection("initial", "Initial", 0);
  document.manifest.extras = {
    application: { retained: true },
    tmd_data_sources: {
      schema_version: 1,
      sources: {
        existing: { type: "sqlite", query: "SELECT 1" },
      },
    },
  };
  const model = new TanuMarkdownModel(document);
  const initial = model.snapshot();
  const edited = state("initial", "Initial", [
    { name: "renamed", type: "sqlite", query: "SELECT 2" },
  ]);

  model.applyState(edited);
  assert.equal(model.isCurrentRevisionPersisted, false);
  assert.deepEqual(model.snapshot().dataSources, edited.dataSources);
  assert.deepEqual(model.inspection.manifest.extras, {
    application: { retained: true },
    tmd_data_sources: {
      schema_version: 1,
      sources: {
        renamed: { type: "sqlite", query: "SELECT 2" },
      },
    },
  });

  model.applyState(initial);
  assert.equal(model.isCurrentRevisionPersisted, true);
  assert.deepEqual(model.snapshot().dataSources, initial.dataSources);
});

test("Rhai source edits preserve schema version 2 and ordered output columns", () => {
  const document = inspection("{{tmd-table:summary}}", "Summary", 0);
  document.manifest.extras = {
    tmd_data_sources: {
      schema_version: 2,
      sources: {
        sales: { type: "sqlite", query: "SELECT category, amount FROM sales" },
        summary: {
          type: "rhai",
          script: "views/summary.rhai",
          inputs: { rows: "sales" },
          output: { type: "table", columns: ["category", "total"] },
        },
      },
    },
  };
  const model = new TanuMarkdownModel(document);
  const edited = model.snapshot();
  const summary = edited.dataSources.find((source) => source.name === "summary");
  assert.equal(summary?.type, "rhai");
  if (summary?.type !== "rhai") throw new Error("missing Rhai source");
  summary.outputColumns = ["total", "category"];

  model.applyState(edited);

  assert.equal(model.isCurrentRevisionPersisted, false);
  assert.deepEqual(model.inspection.manifest.extras, {
    tmd_data_sources: {
      schema_version: 2,
      sources: {
        sales: { type: "sqlite", query: "SELECT category, amount FROM sales" },
        summary: {
          type: "rhai",
          script: "views/summary.rhai",
          inputs: { rows: "sales" },
          output: { type: "table", columns: ["total", "category"] },
        },
      },
    },
  });
});

test("inspection replacement is rejected after a newer edit", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const revertedRevision = model.contentRevision;
  model.applyState(state("typed during revert", "Current"));

  assert.equal(
    model.replaceInspectionIfCurrent(
      inspection("disk state", "Disk", 1),
      revertedRevision,
    ),
    false,
  );
  assert.deepEqual(model.snapshot(), {
    dataSources: [],
    markdown: "typed during revert",
    title: "Current",
  });
  assert.equal(model.isCurrentRevisionPersisted, false);
});

test("validation results are discarded after a newer edit", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const validatedRevision = model.contentRevision;
  const staleReport = {
    valid: false,
    issues: [
      {
        severity: "error" as const,
        code: "stale",
        message: "stale validation result",
      },
    ],
    attachment_references: [],
    database_user_version: 0,
  };

  model.applyState(state("newer edit", "Newer title"));

  assert.equal(model.applyValidation(staleReport, validatedRevision), false);
  assert.equal(model.inspection.validation.valid, true);
  assert.deepEqual(model.inspection.validation.issues, []);
  assert.equal(model.isValidationCurrent, false);
});

test("validation results apply to the revision they checked", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const report = {
    valid: false,
    issues: [
      {
        severity: "error" as const,
        code: "current",
        message: "current validation result",
      },
    ],
    attachment_references: [],
    database_user_version: 0,
  };

  assert.equal(model.applyValidation(report, model.contentRevision), true);
  assert.equal(model.inspection.validation, report);
  assert.equal(model.isValidationCurrent, true);
});

test("Save As retries until the destination contains the latest edit", async () => {
  const model = new TanuMarkdownModel(inspection("first", "First", 0));
  const persistedStates: EditorState[] = [];

  await persistLatestEditorState(model, async (snapshot) => {
    persistedStates.push(snapshot);
    if (persistedStates.length === 1) {
      model.applyState(state("second", "Second"));
    }
  });

  assert.deepEqual(persistedStates, [
    state("first", "First"),
    state("second", "Second"),
  ]);
});

test("Save As fails safely when edits never become stable", async () => {
  const model = new TanuMarkdownModel(inspection("0", "Initial", 0));

  await assert.rejects(
    persistLatestEditorState(
      model,
      async () => {
        const next = model.contentRevision + 1;
        model.applyState(state(String(next), `Revision ${next}`));
      },
      2,
    ),
    /kept changing/,
  );
});

test("document copies are constructed from retained bytes without rereading their source", async () => {
  const persistedBytes = Uint8Array.from([0x54, 0x4d, 0x44]);
  const written: number[][] = [];
  const updates: EditorState[] = [];
  const source = {
    contentRevision: 3,
    persistedBytes,
    snapshot() {
      return state("# Unsaved\n", "Recovered");
    },
  };

  await persistRetainedDocument(
    source,
    async (bytes) => {
      written.push([...bytes]);
    },
    async (state) => {
      updates.push(state);
    },
  );

  assert.deepEqual(written, [[0x54, 0x4d, 0x44]]);
  assert.deepEqual(updates, [
    state("# Unsaved\n", "Recovered"),
  ]);
});
