export const DEFAULT_EDITOR_TAB = "document";

interface TabKeyboardEvent {
  readonly key: string;
  preventDefault(): void;
}

interface TabElement {
  readonly dataset: { editorTab?: string; editorPanel?: string };
  hidden: boolean | string;
  tabIndex: number;
  addEventListener(type: "click", listener: () => void): void;
  addEventListener(type: "keydown", listener: (event: TabKeyboardEvent) => void): void;
  focus(): void;
  setAttribute(name: string, value: string): void;
}

export interface EditorTabDocument {
  querySelectorAll(selector: string): readonly TabElement[];
}

export interface EditorUiStateStore {
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
}

/** Configure editor-local navigation without coupling it to document state. */
export function setupEditorTabs(
  document: EditorTabDocument,
  stateStore: EditorUiStateStore,
): void {
  const tabs = [...document.querySelectorAll("[data-editor-tab]")];
  const panels = [...document.querySelectorAll("[data-editor-panel]")];
  const tabIds = new Set(tabs.map((tab) => tab.dataset.editorTab).filter(isString));
  const storedState = stateStore.getState() ?? {};
  const storedTab = storedState.activeEditorTab;
  const initialTab = typeof storedTab === "string" && tabIds.has(storedTab)
    ? storedTab
    : DEFAULT_EDITOR_TAB;

  const activate = (tabId: string | undefined, focus: boolean): void => {
    if (!tabId || !tabIds.has(tabId)) return;
    for (const tab of tabs) {
      const selected = tab.dataset.editorTab === tabId;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.editorPanel !== tabId;
    }
    stateStore.setState({
      ...(stateStore.getState() ?? {}),
      activeEditorTab: tabId,
    });
  };

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => activate(tab.dataset.editorTab, false));
    tab.addEventListener("keydown", (event) => {
      let nextIndex: number;
      if (event.key === "ArrowRight") {
        nextIndex = (index + 1) % tabs.length;
      } else if (event.key === "ArrowLeft") {
        nextIndex = (index - 1 + tabs.length) % tabs.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tabs.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      activate(tabs[nextIndex]?.dataset.editorTab, true);
    });
  }
  activate(initialTab, false);
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
