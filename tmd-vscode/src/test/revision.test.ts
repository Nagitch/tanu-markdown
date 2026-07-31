import assert from "node:assert/strict";
import test from "node:test";
import { ClientRevisionTracker } from "../revision.js";

test("a reloaded client starts revision tracking from zero", () => {
  const tracker = new ClientRevisionTracker<object>();
  const client = {};

  assert.equal(tracker.latest(client), 0);
  assert.equal(tracker.accept(client, 1), true);
  assert.equal(tracker.latest(client), 1);
  assert.equal(tracker.accept(client, 1), false);

  tracker.reset(client);

  assert.equal(tracker.latest(client), 0);
  assert.equal(tracker.accept(client, 1), true);
});
