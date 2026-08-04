import assert from "node:assert/strict";
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

function uri(value: string): vscode.Uri {
  return {
    toString() {
      return value;
    },
  } as vscode.Uri;
}

test("custom editor loads only the bundled web app and stylesheet", () => {
  const { editorHtml } = loadEditorModule();
  const webview = {
    cspSource: "vscode-webview://test",
  } as unknown as vscode.Webview;

  const html = editorHtml(
    webview,
    uri("vscode-webview://test/editor-app.js"),
    uri("vscode-webview://test/editor-app.css"),
  );

  assert.match(html, /id="tmd-editor-root"/);
  assert.match(html, /id="tmd-csp-nonce"/);
  assert.match(
    html,
    /<link rel="stylesheet" href="vscode-webview:\/\/test\/editor-app\.css">/,
  );
  assert.match(
    html,
    /<script nonce="[^"]+" src="vscode-webview:\/\/test\/editor-app\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /<style(?:\s|>)/);
  assert.doesNotMatch(html, /<script[^>]*>[\s\S]+<\/script>/);
});

test("custom editor applies a restrictive content security policy", () => {
  const { editorHtml } = loadEditorModule();
  const webview = {
    cspSource: "vscode-webview://test",
  } as unknown as vscode.Webview;

  const html = editorHtml(webview, uri("app.js"), uri("app.css"));

  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src vscode-webview:\/\/test 'nonce-[^']+'/);
  assert.match(html, /script-src vscode-webview:\/\/test 'nonce-[^']+'/);
  assert.match(html, /img-src data:/);
});
