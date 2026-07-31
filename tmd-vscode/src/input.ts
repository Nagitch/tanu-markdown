export const PREVIEW_DEBOUNCE_MS = 150;

export function editInputScript(): string {
  return `
    let previewTimer;
    let editorInitialized = false;
    title.disabled = true;
    markdown.disabled = true;
    const sendEdit = () => {
      if (!editorInitialized) return;
      vscode.postMessage({ type: "edit", title: title.value, markdown: markdown.value });
    };
    const queuePreview = () => {
      if (!editorInitialized) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(
        () => vscode.postMessage({ type: "preview", markdown: markdown.value }),
        ${PREVIEW_DEBOUNCE_MS},
      );
    };
    title.addEventListener("input", sendEdit);
    markdown.addEventListener("input", () => {
      sendEdit();
      queuePreview();
    });
  `;
}

export function authoritativeStateScript(): string {
  return `
    const applyAuthoritativeState = (model) => {
      title.value = model.title;
      markdown.value = model.markdown;
      editorInitialized = true;
      title.disabled = false;
      markdown.disabled = false;
    };
  `;
}
