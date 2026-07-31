import assert from "node:assert/strict";
import { test } from "node:test";
import { SerialTaskQueue } from "../queue.js";

test("document operations run serially", async () => {
  const queue = new SerialTaskQueue<object>();
  const document = {};
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });

  const first = queue.run(document, async () => {
    order.push("first:start");
    markFirstStarted?.();
    await firstGate;
    order.push("first:end");
  });
  const second = queue.run(document, async () => {
    order.push("second:start");
    order.push("second:end");
  });

  await firstStarted;
  assert.deepEqual(order, ["first:start"]);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("a failed task does not block the next mutation", async () => {
  const queue = new SerialTaskQueue<object>();
  const document = {};
  const order: string[] = [];

  const failure = queue.run(document, async () => {
    order.push("failed");
    throw new Error("expected failure");
  });
  const recovery = queue.run(document, async () => {
    order.push("recovered");
  });

  await assert.rejects(failure, /expected failure/);
  await recovery;
  assert.deepEqual(order, ["failed", "recovered"]);
});

test("queued document operations return their values", async () => {
  const queue = new SerialTaskQueue<object>();

  const value = await queue.run({}, async () => ({ valid: true }));

  assert.deepEqual(value, { valid: true });
});
