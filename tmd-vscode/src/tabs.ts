export const DEFAULT_EDITOR_TAB = "document";

/**
 * Return the webview-side script that manages editor-local navigation.
 *
 * The selected section is presentation state, not TMD document state, so it
 * is retained with the webview state API instead of participating in dirty
 * tracking or undo/redo.
 */
export function editorTabScript(): string {
  return `
    const editorTabs = [...document.querySelectorAll("[data-editor-tab]")];
    const editorTabPanels = [...document.querySelectorAll("[data-editor-panel]")];
    const editorTabIds = new Set(
      editorTabs.map((tab) => tab.dataset.editorTab).filter(Boolean),
    );
    const storedEditorUiState = vscode.getState() ?? {};
    const initialEditorTab = editorTabIds.has(storedEditorUiState.activeEditorTab)
      ? storedEditorUiState.activeEditorTab
      : "${DEFAULT_EDITOR_TAB}";

    const activateEditorTab = (tabId, focus) => {
      if (!editorTabIds.has(tabId)) return;
      for (const tab of editorTabs) {
        const selected = tab.dataset.editorTab === tabId;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected && focus) tab.focus();
      }
      for (const panel of editorTabPanels) {
        panel.hidden = panel.dataset.editorPanel !== tabId;
      }
      vscode.setState({
        ...(vscode.getState() ?? {}),
        activeEditorTab: tabId,
      });
    };

    for (const [index, tab] of editorTabs.entries()) {
      tab.addEventListener("click", () => {
        activateEditorTab(tab.dataset.editorTab, false);
      });
      tab.addEventListener("keydown", (event) => {
        let nextIndex;
        if (event.key === "ArrowRight") {
          nextIndex = (index + 1) % editorTabs.length;
        } else if (event.key === "ArrowLeft") {
          nextIndex = (index - 1 + editorTabs.length) % editorTabs.length;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = editorTabs.length - 1;
        } else {
          return;
        }
        event.preventDefault();
        activateEditorTab(editorTabs[nextIndex].dataset.editorTab, true);
      });
    }
    activateEditorTab(initialEditorTab, false);
  `;
}
