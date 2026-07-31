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

  runInNewContext(
    `${editInputScript()}
     ${authoritativeStateScript()}
     applyAuthoritativeState(initialModel);`,
    {
      clearTimeout() {},
      initialModel: { title: "Title", markdown: "First" },
      markdown: markdown.control,
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
    { type: "edit", title: "Updated", markdown: "First" },
  ]);
  assert.equal(timers.length, 0);

  markdown.control.value = "Second";
  markdown.input();
  assert.deepEqual(messages.at(-1), {
    type: "edit",
    title: "Updated",
    markdown: "Second",
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delay, PREVIEW_DEBOUNCE_MS);

  timers[0]?.callback();
  assert.deepEqual(messages.at(-1), {
    type: "preview",
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

test("authoritative model state replaces focused control values", () => {
  const title = { value: "stale title", disabled: true };
  const markdown = { value: "stale markdown", disabled: true };

  runInNewContext(
    `let editorInitialized = false;
     ${authoritativeStateScript()}
     applyAuthoritativeState(model);`,
    {
      markdown,
      model: {
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
