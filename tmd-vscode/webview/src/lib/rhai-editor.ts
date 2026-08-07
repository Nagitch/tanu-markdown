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
import type { RhaiSourceDiagnostic } from "../../../src/rhai-diagnostics.js";

export type RhaiDiagnostic = RhaiSourceDiagnostic;

export interface RhaiInputAdapter {
  value: string;
  disabled: boolean;
  addEventListener(type: "input", listener: () => void): void;
  setDiagnostic(diagnostic: RhaiDiagnostic | undefined): void;
}

interface RhaiStreamState {
  blockComment: boolean;
}

const keywords = new Set([
  "as",
  "break",
  "const",
  "continue",
  "do",
  "else",
  "export",
  "for",
  "if",
  "import",
  "in",
  "let",
  "loop",
  "private",
  "return",
  "switch",
  "throw",
  "try",
  "while",
]);

const literals = new Set(["false", "true"]);
const constants = new Set(["this"]);

const rhaiParser: StreamParser<RhaiStreamState> = {
  name: "rhai",
  startState: () => ({ blockComment: false }),
  token(stream, state) {
    if (state.blockComment) return continueBlockComment(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.blockComment = true;
      return continueBlockComment(stream, state);
    }
    if (stream.match("#{")) return "punctuation";
    const next = stream.peek();
    if (next === '"' || next === "'" || next === "`") {
      readString(stream, next);
      return "string";
    }
    if (
      stream.match(
        /^(?:0[xX][\da-fA-F](?:_?[\da-fA-F])*|0[bB][01](?:_?[01])*|\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?)/,
      )
    ) {
      return "number";
    }
    const identifier = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (Array.isArray(identifier)) {
      const value = identifier[0] ?? "";
      if (keywords.has(value)) return "keyword";
      if (literals.has(value)) return "bool";
      if (constants.has(value)) return "variableName.constant";
      return "variableName";
    }
    if (stream.match(/^(?:===|!==|==|!=|<=|>=|=>|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||\*\*|<<|>>|\?\?|\?\.|[+\-*/%=&|^!<>?:])/)) {
      return "operator";
    }
    stream.next();
    return "punctuation";
  },
};

const rhaiLanguage = StreamLanguage.define(rhaiParser);

const rhaiHighlightStyle = HighlightStyle.define([
  {
    tag: tags.keyword,
    color: "var(--vscode-symbolIcon-keywordForeground)",
    fontWeight: "600",
  },
  {
    tag: [tags.variableName, tags.propertyName],
    color: "var(--vscode-symbolIcon-variableForeground)",
  },
  {
    tag: tags.constant(tags.variableName),
    color: "var(--vscode-symbolIcon-classForeground)",
    fontStyle: "italic",
  },
  {
    tag: [tags.number, tags.bool],
    color: "var(--vscode-symbolIcon-numberForeground)",
  },
  {
    tag: tags.string,
    color: "var(--vscode-symbolIcon-stringForeground)",
  },
  {
    tag: tags.comment,
    color: "var(--vscode-descriptionForeground)",
    fontStyle: "italic",
  },
  {
    tag: tags.operator,
    color: "var(--vscode-symbolIcon-operatorForeground)",
  },
  {
    tag: tags.punctuation,
    color: "var(--vscode-editor-foreground)",
  },
]);

const rhaiTheme = EditorView.theme({
  "&": {
    color: "var(--vscode-editor-foreground)",
    backgroundColor: "var(--vscode-editor-background)",
    height: "16rem",
    minHeight: "12rem",
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
  ".cm-lintRange-error": {
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='6' height='3'%3E%3Cpath d='m0 2 1.5-1 3 2L6 2' fill='none' stroke='%23f14c4c' stroke-width='.7'/%3E%3C/svg%3E\")",
  },
  "&.cm-focused": {
    outline: "1px solid var(--vscode-focusBorder)",
    outlineOffset: "-1px",
  },
});

/** Create the Rhai script input used by the table workspace. */
export function createRhaiEditor(
  parent: HTMLElement,
  cspNonce: string,
): RhaiInputAdapter {
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
          "aria-label": "Rhai script",
          autocapitalize: "off",
          autocomplete: "off",
          spellcheck: "false",
        }),
        editable.of(EditorView.editable.of(false)),
        rhaiLanguage,
        syntaxHighlighting(rhaiHighlightStyle),
        rhaiTheme,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || applyingAuthoritativeValue) return;
          for (const listener of inputListeners) listener();
        }),
      ],
    }),
  });

  parent.setAttribute("aria-disabled", "true");

  return {
    get value(): string {
      return view.state.doc.toString();
    },
    set value(nextValue: string) {
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
    get disabled(): boolean {
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
    addEventListener(type: "input", listener: () => void): void {
      if (type === "input") inputListeners.add(listener);
    },
    setDiagnostic(diagnostic: RhaiDiagnostic | undefined): void {
      const diagnostics = diagnostic
        ? [codeMirrorDiagnostic(view.state, diagnostic)]
        : [];
      view.dispatch(setDiagnostics(view.state, diagnostics));
    },
  };
}

function continueBlockComment(
  stream: StringStream,
  state: RhaiStreamState,
): string {
  const rest = stream.string.slice(stream.pos);
  const end = rest.indexOf("*/");
  if (end < 0) {
    stream.skipToEnd();
  } else {
    stream.pos += end + 2;
    state.blockComment = false;
  }
  return "comment";
}

function readString(stream: StringStream, quote: string): void {
  stream.next();
  let escaped = false;
  while (!stream.eol()) {
    const character = stream.next();
    if (character === quote && !escaped) return;
    if (character === "\\" && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
}

function codeMirrorDiagnostic(
  state: EditorState,
  diagnostic: RhaiDiagnostic,
): Diagnostic {
  if (!diagnostic.line) {
    return {
      from: 0,
      to: Math.min(1, state.doc.length),
      severity: "error",
      source: "Rhai",
      message: diagnostic.message,
    };
  }
  const lineNumber = Math.min(Math.max(1, diagnostic.line), state.doc.lines);
  const line = state.doc.line(lineNumber);
  const columnOffset = Math.max(0, (diagnostic.column ?? 1) - 1);
  const from = Math.min(line.from + columnOffset, line.to);
  return {
    from,
    to: Math.min(line.to, from + 1),
    severity: "error",
    source: "Rhai",
    message: diagnostic.message,
  };
}
