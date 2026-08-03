import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import {
  authoritativeStateScript,
  editInputScript,
  PREVIEW_DEBOUNCE_MS,
} from "../input.js";

interface InputControl {
  value: string;
  disabled: boolean;
  addEventListener(type: "input", listener: () => void): void;
}

function inputControl(value: string): {
  control: InputControl;
  input(): void;
} {
  let inputListener: (() => void) | undefined;
  return {
    control: {
      value,
      disabled: false,
      addEventListener(type, listener) {
        assert.equal(type, "input");
        inputListener = listener;
      },
    },
    input() {
      assert.ok(inputListener);
      inputListener();
    },
  };
}

test("editor sends state immediately and debounces only preview rendering", () => {
  const title = inputControl("Title");
  const markdown = inputControl("First");
  const messages: unknown[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const validationStates: boolean[] = [];

  runInNewContext(
    `${editInputScript()}
     ${authoritativeStateScript()}
     applyAuthoritativeState(initialModel);`,
    {
      clearTimeout() {},
      initialModel: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        title: "Title",
        markdown: "First",
      },
      markdown: markdown.control,
      renderValidation(_report: unknown, current: boolean) {
        validationStates.push(current);
      },
      setTimeout(callback: () => void, delay: number) {
        timers.push({ callback, delay });
        return timers.length;
      },
      title: title.control,
      vscode: {
        postMessage(message: unknown) {
          messages.push(JSON.parse(JSON.stringify(message)));
        },
      },
    },
  );

  assert.equal(title.control.disabled, false);
  assert.equal(markdown.control.disabled, false);

  title.control.value = "Updated";
  title.input();
  assert.deepEqual(messages, [
    {
      type: "edit",
      clientRevision: 1,
      title: "Updated",
      markdown: "First",
    },
  ]);
  assert.deepEqual(validationStates, [false]);
  assert.equal(timers.length, 0);

  markdown.control.value = "Second";
  markdown.input();
  assert.deepEqual(messages.at(-1), {
    type: "edit",
    clientRevision: 2,
    title: "Updated",
    markdown: "Second",
  });
  assert.equal(timers.length, 1);
  assert.deepEqual(validationStates, [false, false]);
  assert.equal(timers[0]?.delay, PREVIEW_DEBOUNCE_MS);

  timers[0]?.callback();
  assert.deepEqual(messages.at(-1), {
    type: "preview",
    clientRevision: 2,
    markdown: "Second",
  });
});

test("editor ignores input until the initial model is applied", () => {
  const title = inputControl("");
  const markdown = inputControl("");
  const messages: unknown[] = [];
  const context = {
    clearTimeout() {},
    markdown: markdown.control,
    setTimeout() {
      throw new Error("preview must not be queued before initialization");
    },
    title: title.control,
    vscode: {
      postMessage(message: unknown) {
        messages.push(message);
      },
    },
  };

  runInNewContext(editInputScript(), context);
  assert.equal(title.control.disabled, true);
  assert.equal(markdown.control.disabled, true);

  title.control.value = "premature title";
  markdown.control.value = "premature markdown";
  title.input();
  markdown.input();
  assert.deepEqual(messages, []);
});

test("applying data sources participates in revision and preview flow", () => {
  const title = inputControl("Title");
  const markdown = inputControl("{{tmd-view:count}}");
  const messages: unknown[] = [];
  const timers: Array<() => void> = [];
  const results: Record<string, unknown> = {};

  runInNewContext(
    `${editInputScript()}
     ${authoritativeStateScript()}
     applyAuthoritativeState(initialModel);
     results.revision = sendDataSourceEdit(dataSources);`,
    {
      clearTimeout() {},
      dataSources: [
        { name: "count", type: "sqlite", query: "SELECT count(*) FROM notes" },
      ],
      initialModel: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        title: "Title",
        markdown: "{{tmd-view:count}}",
      },
      markdown: markdown.control,
      renderValidation() {},
      results,
      setTimeout(callback: () => void) {
        timers.push(callback);
        return timers.length;
      },
      title: title.control,
      vscode: {
        postMessage(message: unknown) {
          messages.push(JSON.parse(JSON.stringify(message)));
        },
      },
    },
  );

  assert.equal(results.revision, 1);
  assert.deepEqual(messages[0], {
    type: "editDataSources",
    clientRevision: 1,
    dataSources: [
      { name: "count", type: "sqlite", query: "SELECT count(*) FROM notes" },
    ],
  });
  assert.equal(timers.length, 1);
  timers[0]?.();
  assert.deepEqual(messages[1], {
    type: "preview",
    clientRevision: 1,
    markdown: "{{tmd-view:count}}",
  });
});

test("authoritative model state replaces focused control values", () => {
  const title = { value: "stale title", disabled: true };
  const markdown = { value: "stale markdown", disabled: true };

  runInNewContext(
    `let editorInitialized = false;
     let clientRevision = 0;
     let acknowledgedContentRevision = -1;
     ${authoritativeStateScript()}
     applyAuthoritativeState(model);`,
    {
      markdown,
      model: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        title: "restored title",
        markdown: "restored markdown",
      },
      title,
    },
  );

  assert.equal(title.value, "restored title");
  assert.equal(markdown.value, "restored markdown");
  assert.equal(title.disabled, false);
  assert.equal(markdown.disabled, false);
});

test("authoritative model state locks and unlocks editor inputs", () => {
  const title = { value: "", disabled: false };
  const markdown = { value: "", disabled: false };
  const states: boolean[] = [];

  runInNewContext(
    `let editorInitialized = false;
     let clientRevision = 0;
     let acknowledgedContentRevision = -1;
     ${authoritativeStateScript()}
     applyAuthoritativeState(lockedModel);
     states.push(title.disabled, markdown.disabled);
     applyAuthoritativeState(unlockedModel);
     states.push(title.disabled, markdown.disabled);`,
    {
      lockedModel: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        editingLocked: true,
        title: "locked",
        markdown: "locked",
      },
      markdown,
      states,
      title,
      unlockedModel: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        editingLocked: false,
        title: "unlocked",
        markdown: "unlocked",
      },
    },
  );

  assert.deepEqual(states, [true, true, false, false]);
  assert.equal(title.value, "unlocked");
  assert.equal(markdown.value, "unlocked");
});

test("stale models cannot overwrite pending or acknowledged local edits", () => {
  const title = inputControl("");
  const markdown = inputControl("");
  const messages: unknown[] = [];
  const results: Record<string, unknown> = {};

  runInNewContext(
    `${editInputScript()}
     ${authoritativeStateScript()}
     results.initial = applyAuthoritativeState(initialModel);
     title.value = "local title";
     markdown.value = "local markdown";
     triggerTitleInput();
     results.pending = applyAuthoritativeState(staleModel);
     results.ack = applyEditAck(editAck);
     results.acknowledged = applyAuthoritativeState(staleModel);
     results.current = applyAuthoritativeState(currentModel);`,
    {
      clearTimeout() {},
      currentModel: {
        acknowledgedClientRevision: 1,
        contentRevision: 2,
        title: "current title",
        markdown: "current markdown",
      },
      editAck: {
        clientRevision: 1,
        contentRevision: 1,
      },
      initialModel: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        title: "initial title",
        markdown: "initial markdown",
      },
      markdown: markdown.control,
      renderValidation() {},
      results,
      setTimeout() {
        return 1;
      },
      staleModel: {
        acknowledgedClientRevision: 0,
        contentRevision: 0,
        title: "stale title",
        markdown: "stale markdown",
      },
      title: title.control,
      triggerTitleInput: title.input,
      vscode: {
        postMessage(message: unknown) {
          messages.push(JSON.parse(JSON.stringify(message)));
        },
      },
    },
  );

  assert.deepEqual(results, {
    initial: true,
    pending: false,
    ack: true,
    acknowledged: false,
    current: true,
  });
  assert.deepEqual(messages, [
    {
      type: "edit",
      clientRevision: 1,
      title: "local title",
      markdown: "local markdown",
    },
  ]);
  assert.equal(title.control.value, "current title");
  assert.equal(markdown.control.value, "current markdown");
});

test("stale preview responses cannot overwrite authoritative preview state", () => {
  const preview = { innerHTML: "authoritative preview" };
  const results: Record<string, unknown> = {};

  runInNewContext(
    `let clientRevision = 2;
     let acknowledgedContentRevision = 4;
     ${authoritativeStateScript()}
     results.staleClient = applyPreview(staleClientPreview);
     results.staleContent = applyPreview(staleContentPreview);
     results.current = applyPreview(currentPreview);`,
    {
      currentPreview: {
        clientRevision: 2,
        contentRevision: 4,
        previewHtml: "current preview",
      },
      preview,
      results,
      staleClientPreview: {
        clientRevision: 1,
        contentRevision: 4,
        previewHtml: "stale client preview",
      },
      staleContentPreview: {
        clientRevision: 2,
        contentRevision: 3,
        previewHtml: "stale content preview",
      },
    },
  );

  assert.deepEqual(results, {
    staleClient: false,
    staleContent: false,
    current: true,
  });
  assert.equal(preview.innerHTML, "current preview");
});
