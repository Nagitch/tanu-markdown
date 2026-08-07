import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser,
  type StringStream,
} from "@codemirror/language";
import {
  lintGutter,
  setDiagnostics,
  type Diagnostic,
} from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  formulaUtf16Offset,
  type FormulaSourceDiagnostic,
} from "../../../src/formula-diagnostics.js";

export interface FormulaInputAdapter {
  value: string;
  disabled: boolean;
  addEventListener(type: "input", listener: () => void): void;
  setDiagnostic(diagnostic: FormulaSourceDiagnostic | undefined): void;
}

interface FormulaStreamState {
  assignmentSeen: boolean;
}

const functions = new Set([
  "ABS",
  "AND",
  "AVERAGE",
  "CONCAT",
  "COUNT",
  "HEADER",
  "IF",
  "ISNULL",
  "LEN",
  "MAX",
  "MIN",
  "NOT",
  "OR",
  "ROUND",
  "SUM",
]);

const formulaParser: StreamParser<FormulaStreamState> = {
  name: "tmd-formula",
  startState: () => ({ assignmentSeen: false }),
  blankLine(state) {
    state.assignmentSeen = false;
  },
  token(stream, state) {
    if (stream.sol()) state.assignmentSeen = false;
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    const next = stream.peek();
    if (next === '"') {
      readString(stream);
      return "string";
    }
    if (stream.match(/^\[@[^\]\r\n]+\]/)) return "variableName.special";
    if (stream.match(/^\[[^\]\r\n]+\]/)) return "propertyName";
    if (
      stream.match(
        /^(?:\$?[A-Za-z]+\$?[1-9]\d*:\$?[A-Za-z]+\$?[1-9]\d*|\$?[A-Za-z]+\$?[1-9]\d*)/,
      )
    ) {
      return state.assignmentSeen
        ? "variableName.constant"
        : "variableName.definition";
    }
    if (stream.match(/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/)) {
      return "number";
    }
    const identifier = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (Array.isArray(identifier)) {
      const value = identifier[0]?.toUpperCase() ?? "";
      if (value === "TRUE" || value === "FALSE") return "bool";
      if (value === "NULL") return "null";
      if (functions.has(value)) return "variableName.function";
      return "variableName";
    }
    if (stream.match(/^(?:<=|>=|<>|==|!=|[+\-*/<>])/)) {
      return "operator";
    }
    if (stream.match("=")) {
      state.assignmentSeen = true;
      return "operator";
    }
    stream.next();
    return "punctuation";
  },
};

const formulaLanguage = StreamLanguage.define(formulaParser);

const formulaHighlightStyle = HighlightStyle.define([
  {
    tag: tags.definition(tags.variableName),
    color: "var(--vscode-symbolIcon-fieldForeground)",
    fontWeight: "600",
  },
  {
    tag: tags.constant(tags.variableName),
    color: "var(--vscode-symbolIcon-classForeground)",
  },
  {
    tag: tags.special(tags.variableName),
    color: "var(--vscode-symbolIcon-propertyForeground)",
  },
  {
    tag: tags.function(tags.variableName),
    color: "var(--vscode-symbolIcon-functionForeground)",
    fontWeight: "600",
  },
  {
    tag: tags.propertyName,
    color: "var(--vscode-symbolIcon-propertyForeground)",
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "var(--vscode-symbolIcon-numberForeground)",
  },
  { tag: tags.string, color: "var(--vscode-symbolIcon-stringForeground)" },
  {
    tag: tags.comment,
    color: "var(--vscode-descriptionForeground)",
    fontStyle: "italic",
  },
  {
    tag: tags.operator,
    color: "var(--vscode-symbolIcon-operatorForeground)",
  },
]);

const formulaTheme = EditorView.theme({
  "&": {
    color: "var(--vscode-editor-foreground)",
    backgroundColor: "var(--vscode-editor-background)",
    height: "14rem",
    minHeight: "10rem",
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

/** Create the Formula program editor used by the table workspace. */
export function createFormulaEditor(
  parent: HTMLElement,
  cspNonce: string,
): FormulaInputAdapter {
  const editable = new Compartment();
  const inputListeners = new Set<() => void>();
  let disabled = true;
  let applyingAuthoritativeValue = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        lintGutter(),
        EditorView.cspNonce.of(cspNonce),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": "Formula program",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
        editable.of(EditorView.editable.of(false)),
        formulaLanguage,
        syntaxHighlighting(formulaHighlightStyle),
        formulaTheme,
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
    set value(nextValue: string) {
      if (nextValue === view.state.doc.toString()) return;
      const selection = view.state.selection.main;
      applyingAuthoritativeValue = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: nextValue },
          selection: {
            anchor: Math.min(selection.anchor, nextValue.length),
            head: Math.min(selection.head, nextValue.length),
          },
        });
      } finally {
        applyingAuthoritativeValue = false;
      }
    },
    get disabled() {
      return disabled;
    },
    set disabled(nextDisabled: boolean) {
      if (disabled === nextDisabled) return;
      disabled = nextDisabled;
      parent.setAttribute("aria-disabled", String(disabled));
      view.dispatch({
        effects: editable.reconfigure(EditorView.editable.of(!disabled)),
      });
    },
    addEventListener(type: "input", listener: () => void) {
      if (type === "input") inputListeners.add(listener);
    },
    setDiagnostic(diagnostic: FormulaSourceDiagnostic | undefined) {
      const diagnostics = diagnostic
        ? [codeMirrorDiagnostic(view.state, diagnostic)]
        : [];
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
  };
}

function readString(stream: StringStream): void {
  stream.next();
  let escaped = false;
  while (!stream.eol()) {
    const character = stream.next();
    if (character === '"' && !escaped) return;
    if (character === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
}

function codeMirrorDiagnostic(
  state: EditorState,
  diagnostic: FormulaSourceDiagnostic,
): Diagnostic {
  if (!diagnostic.line) {
    return {
      from: 0,
      to: Math.min(1, state.doc.length),
      severity: "error",
      source: "Formula",
      message: diagnostic.message,
    };
  }
  const lineNumber = Math.min(Math.max(1, diagnostic.line), state.doc.lines);
  const line = state.doc.line(lineNumber);
  const columnOffset = formulaUtf16Offset(
    state.doc.sliceString(line.from, line.to),
    diagnostic.column ?? 1,
  );
  const from = Math.min(line.from + columnOffset, line.to);
  return {
    from,
    to: Math.min(line.to, from + 1),
    severity: "error",
    source: "Formula",
    message: diagnostic.message,
  };
}
