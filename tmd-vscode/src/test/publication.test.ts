import assert from "node:assert/strict";
import { test } from "node:test";
import { publishLatestRevision } from "../publication.js";

test("model publication retries when rendering overlaps a newer revision", async () => {
  let contentRevision = 0;
  let state = "initial";
  let finishInitialRender: ((preview: string) => void) | undefined;
  const renders: string[] = [];
  const publications: Array<{
    contentRevision: number;
    state: string;
    preview: string;
  }> = [];

  const publishing = publishLatestRevision(
    () => ({ contentRevision, state }),
    () => contentRevision,
    async (candidate) => {
      renders.push(candidate);
      if (candidate === "initial") {
        return new Promise<string>((resolve) => {
          finishInitialRender = resolve;
        });
      }
      return `preview:${candidate}`;
    },
    async (snapshot, preview) => {
      publications.push({ ...snapshot, preview });
    },
  );

  assert.deepEqual(renders, ["initial"]);
  contentRevision = 1;
  state = "edited";
  assert.ok(finishInitialRender);
  finishInitialRender("preview:initial");
  await publishing;

  assert.deepEqual(renders, ["initial", "edited"]);
  assert.deepEqual(publications, [
    {
      contentRevision: 1,
      state: "edited",
      preview: "preview:edited",
    },
  ]);
});

test("model publication follows an edit that arrives during delivery", async () => {
  let contentRevision = 0;
  let state = "initial";
  let finishInitialPublication: (() => void) | undefined;
  const publications: string[] = [];

  const publishing = publishLatestRevision(
    () => ({ contentRevision, state }),
    () => contentRevision,
    async (candidate) => `preview:${candidate}`,
    async (snapshot, preview) => {
      publications.push(`${snapshot.contentRevision}:${preview}`);
      if (snapshot.contentRevision === 0) {
        await new Promise<void>((resolve) => {
          finishInitialPublication = resolve;
        });
      }
    },
  );

  await Promise.resolve();
  assert.deepEqual(publications, ["0:preview:initial"]);
  contentRevision = 1;
  state = "edited";
  assert.ok(finishInitialPublication);
  finishInitialPublication();
  await publishing;

  assert.deepEqual(publications, ["0:preview:initial", "1:preview:edited"]);
});
