import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorClientState, PREVIEW_DEBOUNCE_MS } from "../input.js";

test("editor revisions do not begin before the authoritative model arrives", () => {
  const state = new EditorClientState();

  assert.equal(state.initialized, false);
  assert.equal(state.nextEditRevision(), undefined);
  assert.equal(
    state.acceptAuthoritativeState({
      clientRevision: 0,
      contentRevision: 0,
    }),
    true,
  );
  assert.equal(state.initialized, true);
  assert.equal(state.nextEditRevision(), 1);
});

test("stale models cannot overwrite a pending or acknowledged local edit", () => {
  const state = new EditorClientState();
  assert.equal(
    state.acceptAuthoritativeState({
      clientRevision: 0,
      contentRevision: 0,
    }),
    true,
  );
  assert.equal(state.nextEditRevision(), 1);

  assert.equal(
    state.acceptAuthoritativeState({
      clientRevision: 0,
      contentRevision: 0,
    }),
    false,
  );
  assert.equal(
    state.acceptEditAcknowledgement({
      clientRevision: 1,
      contentRevision: 1,
    }),
    true,
  );
  assert.equal(
    state.acceptAuthoritativeState({
      clientRevision: 0,
      contentRevision: 1,
    }),
    false,
  );
  assert.equal(
    state.acceptAuthoritativeState({
      clientRevision: 1,
      contentRevision: 1,
    }),
    true,
  );
});

test("future acknowledgements and stale previews are rejected", () => {
  const state = new EditorClientState();
  assert.equal(
    state.acceptAuthoritativeState({
      clientRevision: 0,
      contentRevision: 2,
    }),
    true,
  );
  assert.equal(state.nextEditRevision(), 1);

  assert.equal(
    state.acceptEditAcknowledgement({
      clientRevision: 2,
      contentRevision: 3,
    }),
    false,
  );
  assert.equal(
    state.acceptEditAcknowledgement({
      clientRevision: 1,
      contentRevision: 3,
    }),
    true,
  );
  assert.equal(
    state.acceptPreview({
      clientRevision: 0,
      contentRevision: 3,
    }),
    false,
  );
  assert.equal(
    state.acceptPreview({
      clientRevision: 1,
      contentRevision: 2,
    }),
    false,
  );
  assert.equal(
    state.acceptPreview({
      clientRevision: 1,
      contentRevision: 3,
    }),
    true,
  );
});

test("preview rendering remains the only debounced editor operation", () => {
  assert.equal(PREVIEW_DEBOUNCE_MS, 150);
});
