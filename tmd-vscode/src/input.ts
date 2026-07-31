export const PREVIEW_DEBOUNCE_MS = 150;

export function editInputScript(): string {
  return `
    let previewTimer;
    let editorInitialized = false;
    let clientRevision = 0;
    let acknowledgedContentRevision = -1;
    title.disabled = true;
    markdown.disabled = true;
    const sendEdit = () => {
      if (!editorInitialized) return;
      clientRevision += 1;
      vscode.postMessage({
        type: "edit",
        clientRevision,
        title: title.value,
        markdown: markdown.value,
      });
      renderValidation(undefined, false);
    };
    const queuePreview = () => {
      if (!editorInitialized) return;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(
        () =>
          vscode.postMessage({
            type: "preview",
            clientRevision,
            markdown: markdown.value,
          }),
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
    const applyEditAck = (ack) => {
      if (
        !Number.isSafeInteger(ack.clientRevision) ||
        !Number.isSafeInteger(ack.contentRevision) ||
        ack.clientRevision < 0 ||
        ack.clientRevision > clientRevision ||
        ack.contentRevision < 0
      ) return false;
      acknowledgedContentRevision = Math.max(
        acknowledgedContentRevision,
        ack.contentRevision,
      );
      return true;
    };
    const applyPreview = (message) => {
      if (
        !Number.isSafeInteger(message.clientRevision) ||
        !Number.isSafeInteger(message.contentRevision) ||
        typeof message.previewHtml !== "string" ||
        message.clientRevision !== clientRevision ||
        message.contentRevision < acknowledgedContentRevision
      ) return false;
      preview.innerHTML = message.previewHtml;
      return true;
    };
    const applyAuthoritativeState = (model) => {
      if (
        !Number.isSafeInteger(model.acknowledgedClientRevision) ||
        !Number.isSafeInteger(model.contentRevision) ||
        model.acknowledgedClientRevision !== clientRevision ||
        model.contentRevision < acknowledgedContentRevision
      ) return false;
      title.value = model.title;
      markdown.value = model.markdown;
      acknowledgedContentRevision = model.contentRevision;
      editorInitialized = true;
      title.disabled = false;
      markdown.disabled = false;
      return true;
    };
  `;
}
