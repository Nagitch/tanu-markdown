import assert from "node:assert/strict";
import { test } from "node:test";
import { TanuMarkdownModel } from "../model.js";
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

test("save response preserves edits made while the update was pending", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const savedRevision = model.contentRevision;

  model.applyState({ markdown: "newer edit", title: "Newer title" });
  model.applySavedInspection(
    inspection("saved snapshot", "Saved title", 2),
    savedRevision,
  );

  assert.deepEqual(model.snapshot(), {
    markdown: "newer edit",
    title: "Newer title",
  });
  assert.equal(model.inspection.database_user_version, 2);
});

test("save response replaces state when no newer edit exists", () => {
  const model = new TanuMarkdownModel(inspection("initial", "Initial", 0));
  const savedRevision = model.contentRevision;

  model.applySavedInspection(
    inspection("saved snapshot", "Saved title", 1),
    savedRevision,
  );

  assert.deepEqual(model.snapshot(), {
    markdown: "saved snapshot",
    title: "Saved title",
  });
});
