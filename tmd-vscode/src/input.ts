export const PREVIEW_DEBOUNCE_MS = 150;

export function editInputScript(): string {
  return `
    let previewTimer;
    const sendEdit = () => {
      vscode.postMessage({ type: "edit", title: title.value, markdown: markdown.value });
    };
    const queuePreview = () => {
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
