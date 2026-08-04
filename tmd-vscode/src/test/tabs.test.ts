import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { DEFAULT_EDITOR_TAB, editorTabScript } from "../tabs.js";

type Listener = (event: { key?: string; preventDefault(): void }) => void;

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener>();
  hidden = false;
  tabIndex = 0;
  focused = false;

  constructor(readonly dataset: Record<string, string>) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  focus(): void {
    this.focused = true;
  }

  dispatch(type: string, key?: string): boolean {
    let prevented = false;
    const listener = this.listeners.get(type);
    assert.ok(listener, `missing ${type} listener`);
    listener({
      key,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  }
}

function tabFixture(initialState: Record<string, unknown>): {
  panels: FakeElement[];
  states: Array<Record<string, unknown>>;
  tabs: FakeElement[];
} {
  const ids = ["document", "data", "sources", "attachments", "validation"];
  const tabs = ids.map((id) => new FakeElement({ editorTab: id }));
  const panels = ids.map((id) => new FakeElement({ editorPanel: id }));
  const states: Array<Record<string, unknown>> = [];
  let state = initialState;

  runInNewContext(editorTabScript(), {
    document: {
      querySelectorAll(selector: string) {
        return selector === "[data-editor-tab]" ? tabs : panels;
      },
    },
    vscode: {
      getState() {
        return state;
      },
      setState(nextState: Record<string, unknown>) {
        state = { ...nextState };
        states.push(state);
      },
    },
  });

  return { panels, states, tabs };
}

test("editor tabs restore presentation state without changing document state", () => {
  const { panels, states, tabs } = tabFixture({ activeEditorTab: "sources", keep: 1 });

  assert.equal(tabs[2]?.attributes.get("aria-selected"), "true");
  assert.equal(tabs[2]?.tabIndex, 0);
  assert.equal(panels[2]?.hidden, false);
  assert.equal(panels[0]?.hidden, true);
  assert.deepEqual(states.at(-1), { activeEditorTab: "sources", keep: 1 });

  tabs[1]?.dispatch("click");
  assert.equal(tabs[1]?.attributes.get("aria-selected"), "true");
  assert.equal(panels[1]?.hidden, false);
  assert.deepEqual(states.at(-1), { activeEditorTab: "data", keep: 1 });
});

test("editor tabs fall back to Document and support keyboard navigation", () => {
  const { panels, states, tabs } = tabFixture({ activeEditorTab: "unknown" });

  assert.equal(states[0]?.activeEditorTab, DEFAULT_EDITOR_TAB);
  assert.equal(panels[0]?.hidden, false);

  const prevented = tabs[0]?.dispatch("keydown", "ArrowLeft");
  assert.equal(prevented, true);
  assert.equal(tabs[4]?.attributes.get("aria-selected"), "true");
  assert.equal(tabs[4]?.focused, true);

  tabs[4]?.dispatch("keydown", "Home");
  assert.equal(tabs[0]?.attributes.get("aria-selected"), "true");
  assert.equal(tabs[0]?.focused, true);
});
