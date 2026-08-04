import assert from "node:assert/strict";
import { Script } from "node:vm";
import { test } from "node:test";
import type * as vscode from "vscode";

interface NodeModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

function loadEditorModule(): typeof import("../editor.js") {
  const loader = require("node:module") as NodeModuleLoader;
  const originalLoad = loader._load;
  loader._load = (request, parent, isMain) =>
    request === "vscode"
      ? {}
      : Reflect.apply(originalLoad, loader, [request, parent, isMain]);
  try {
    return require("../editor.js") as typeof import("../editor.js");
  } finally {
    loader._load = originalLoad;
  }
}

test("custom editor emits syntactically valid inline JavaScript", () => {
  const { editorHtml } = loadEditorModule();
  const webview = {
    cspSource: "vscode-webview://test",
    asWebviewUri(uri: vscode.Uri) {
      return uri;
    },
  } as unknown as vscode.Webview;
  const markdownEditorUri = {
    toString() {
      return "vscode-webview://test/markdown-editor.js";
    },
  } as vscode.Uri;

  const html = editorHtml(webview, markdownEditorUri);
  const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)];
  const inlineScript = scripts.at(-1)?.[1];

  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Script(inlineScript));
  assert.match(inlineScript, /split\(\/\\r\?\\n\/\)/);
  assert.match(inlineScript, /addRhaiDataSource/);
});
