import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalTmdSession } from "../session.js";
import type { DocumentInspection } from "../types.js";

function inspection(): DocumentInspection {
  return {
    schema_version: 1,
    format: "tmd",
    markdown: "initial",
    manifest: {
      title: "Initial",
      authors: [],
      tags: [],
      extras: null,
    },
    attachments: [],
    database_user_version: 0,
    database: {
      user_version: 0,
      objects: [],
    },
    validation: {
      valid: true,
      issues: [],
      attachment_references: [],
      database_user_version: 0,
    },
  };
}

function session(): LocalTmdSession {
  const bytes = new Uint8Array([1, 2, 3]);
  return LocalTmdSession.create(
    "/tmp/session.tmd",
    inspection(),
    bytes,
    bytes,
    () => {
      throw new Error("pure session operations must not invoke the CLI");
    },
  );
}

test("shared session operations own editor state and content revisions", () => {
  const current = session();
  const operation = {
    type: "replaceEditorState" as const,
    state: {
      dataSources: [],
      markdown: "edited",
      textAttachmentEdits: [],
      title: "Edited",
    },
  };

  const applied = current.apply(operation);

  assert.equal(applied.changed, true);
  assert.equal(applied.contentRevision, 1);
  assert.deepEqual(current.snapshot(), operation.state);
  assert.equal(current.isCurrentRevisionPersisted, false);
  assert.equal(current.apply(operation).changed, false);
  assert.equal(current.contentRevision, 1);
});

test("overlapping session locks release independently and reject edits", () => {
  const current = session();
  const releaseFirst = current.acquireEditingLock();
  const releaseSecond = current.acquireEditingLock();

  assert.equal(current.editingLocked, true);
  assert.throws(
    () =>
      current.apply({
        type: "replaceEditorState",
        state: current.snapshot(),
      }),
    /temporarily locked/,
  );

  releaseFirst();
  releaseFirst();
  assert.equal(current.editingLocked, true);
  releaseSecond();
  assert.equal(current.editingLocked, false);
});
