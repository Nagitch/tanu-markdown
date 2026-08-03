import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

const markdownHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3],
    color: "var(--vscode-symbolIcon-classForeground)",
    fontWeight: "700",
  },
  {
    tag: tags.strong,
    color: "var(--vscode-symbolIcon-variableForeground)",
    fontWeight: "700",
  },
  {
    tag: tags.emphasis,
    color: "var(--vscode-symbolIcon-variableForeground)",
    fontStyle: "italic",
  },
  {
    tag: [tags.link, tags.url],
    color: "var(--vscode-textLink-foreground)",
    textDecoration: "underline",
  },
  {
    tag: tags.monospace,
    color: "var(--vscode-textPreformat-foreground)",
    fontFamily: "var(--vscode-editor-font-family)",
  },
  {
    tag: [tags.quote, tags.contentSeparator, tags.list],
    color: "var(--vscode-descriptionForeground)",
  },
  {
    tag: [tags.meta, tags.processingInstruction],
    color: "var(--vscode-symbolIcon-keywordForeground)",
  },
  {
    tag: tags.invalid,
    color: "var(--vscode-errorForeground)",
    textDecoration: "underline wavy",
  },
]);

const vscodeTheme = EditorView.theme({
  "&": {
    color: "var(--vscode-editor-foreground)",
    backgroundColor: "var(--vscode-editor-background)",
    height: "55vh",
    minHeight: "22rem",
  },
  ".cm-content": {
    caretColor: "var(--vscode-editorCursor-foreground)",
    fontFamily: "var(--vscode-editor-font-family)",
    fontSize: "var(--vscode-editor-font-size)",
    lineHeight: "1.5",
    padding: ".5rem 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--vscode-editorCursor-foreground)",
  },
  ".cm-gutters": {
    color: "var(--vscode-editorLineNumber-foreground)",
    backgroundColor: "var(--vscode-editorGutter-background)",
    borderRight: "1px solid var(--vscode-panel-border)",
  },
  ".cm-activeLineGutter": {
    color: "var(--vscode-editorLineNumber-activeForeground)",
    backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "var(--vscode-editor-selectionBackground) !important",
  },
  "&.cm-focused": {
    outline: "1px solid var(--vscode-focusBorder)",
    outlineOffset: "-1px",
  },
});

/**
 * Create the Markdown input adapter expected by the existing webview bridge.
 * CodeMirror remains a presentation/input layer; document state and undo/redo
 * continue to be owned by the extension-host CustomDocument.
 */
export function create(parent, cspNonce) {
  const editable = new Compartment();
  const inputListeners = new Set();
  let disabled = true;
  let applyingAuthoritativeValue = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        EditorView.cspNonce.of(cspNonce),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Markdown",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "true",
        }),
        editable.of(EditorView.editable.of(false)),
        markdown(),
        syntaxHighlighting(markdownHighlightStyle),
        vscodeTheme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applyingAuthoritativeValue) return;
          for (const listener of inputListeners) listener();
        }),
      ],
    }),
  });

  parent.setAttribute("aria-disabled", "true");

  return {
    get value() {
      return view.state.doc.toString();
    },
    set value(nextValue) {
      if (nextValue === view.state.doc.toString()) return;
      const selection = view.state.selection.main;
      const anchor = Math.min(selection.anchor, nextValue.length);
      const head = Math.min(selection.head, nextValue.length);
      applyingAuthoritativeValue = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: nextValue },
          selection: { anchor, head },
        });
      } finally {
        applyingAuthoritativeValue = false;
      }
    },
    get disabled() {
      return disabled;
    },
    set disabled(nextDisabled) {
      if (disabled === nextDisabled) return;
      disabled = nextDisabled;
      parent.setAttribute("aria-disabled", String(disabled));
      view.dispatch({
        effects: editable.reconfigure(EditorView.editable.of(!disabled)),
      });
    },
    addEventListener(type, listener) {
      if (type !== "input") return;
      inputListeners.add(listener);
    },
  };
}
