import assert from "node:assert/strict";
import { test } from "node:test";
import {
  persistLatestEditorState,
  TanuMarkdownModel,
} from "../model.js";
import type { DocumentInspection } from "../types.js";

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

test("persisted inspection preserves edits made while an operation was pending", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const savedRevision = model.contentRevision;

  model.applyState({ markdown: "newer edit", title: "Newer title" });
  model.applyPersistedInspection(
    inspection("saved snapshot", "Saved title", 2),
    savedRevision,
  );

  assert.deepEqual(model.snapshot(), {
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
    markdown: "saved snapshot",
    title: "Saved title",
  });
  assert.equal(model.persistedRevision, model.contentRevision);
  assert.equal(model.isCurrentRevisionPersisted, true);
  assert.equal(model.isValidationCurrent, true);
});

test("inspection replacement is rejected after a newer edit", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const revertedRevision = model.contentRevision;
  model.applyState({ markdown: "typed during revert", title: "Current" });

  assert.equal(
    model.replaceInspectionIfCurrent(
      inspection("disk state", "Disk", 1),
      revertedRevision,
    ),
    false,
  );
  assert.deepEqual(model.snapshot(), {
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

  model.applyState({ markdown: "newer edit", title: "Newer title" });

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
  const persistedStates: Array<{ markdown: string; title: string }> = [];

  await persistLatestEditorState(model, async (state) => {
    persistedStates.push(state);
    if (persistedStates.length === 1) {
      model.applyState({ markdown: "second", title: "Second" });
    }
  });

  assert.deepEqual(persistedStates, [
    { markdown: "first", title: "First" },
    { markdown: "second", title: "Second" },
  ]);
});

test("Save As fails safely when edits never become stable", async () => {
  const model = new TanuMarkdownModel(inspection("0", "Initial", 0));

  await assert.rejects(
    persistLatestEditorState(
      model,
      async () => {
        const next = model.contentRevision + 1;
        model.applyState({ markdown: String(next), title: `Revision ${next}` });
      },
      2,
    ),
    /kept changing/,
  );
});
