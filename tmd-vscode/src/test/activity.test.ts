import assert from "node:assert/strict";
import { test } from "node:test";
import { findActiveDocument } from "../activity.js";

test("active document is cleared when every custom editor panel is inactive", () => {
  const hiddenDocument = { name: "hidden.tmd" };
  const panels = new Map([[hiddenDocument, new Set([{ active: false }])]]);

  assert.equal(findActiveDocument(panels), undefined);
});

test("active document follows the active custom editor panel", () => {
  const hiddenDocument = { name: "hidden.tmd" };
  const visibleDocument = { name: "visible.tmd" };
  const panels = new Map([
    [hiddenDocument, new Set([{ active: false }])],
    [visibleDocument, new Set([{ active: true }])],
  ]);

  assert.equal(findActiveDocument(panels), visibleDocument);
});
