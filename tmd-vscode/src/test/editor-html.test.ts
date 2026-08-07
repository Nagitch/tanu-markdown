import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

test("custom editor loads the bundled SvelteKit app with webview resource URIs", () => {
  const { editorHtml } = loadEditorModule();
  const webview = {
    cspSource: "vscode-webview://test",
  } as unknown as vscode.Webview;

  const template = readFileSync(
    join(__dirname, "..", "webview", "index.html"),
    "utf8",
  );
  const html = editorHtml(webview, uri("vscode-webview://test/webview"), template);

  assert.match(html, /id="tmd-editor-root"/);
  assert.match(html, /id="tmd-csp-nonce"/);
  assert.match(html, /name="csp-nonce"/);
  assert.match(
    html,
    /href="vscode-webview:\/\/test\/webview\/_app\/[^"\s]+\.css" rel="stylesheet"/,
  );
  assert.match(
    html,
    /import\("vscode-webview:\/\/test\/webview\/_app\/[^"\s]+\.js"\)/,
  );
  assert.doesNotMatch(html, /<style(?:\s|>)/);
  assert.doesNotMatch(html, /<script(?! nonce="[^"]+")/);
});

test("custom editor applies a restrictive content security policy", () => {
  const { editorHtml } = loadEditorModule();
  const webview = {
    cspSource: "vscode-webview://test",
  } as unknown as vscode.Webview;

  const html = editorHtml(
    webview,
    uri("vscode-webview://test/webview"),
    "<!doctype html><html><head></head><body><script>void 0;</script></body></html>",
  );

  assert.match(html, /default-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /style-src vscode-webview:\/\/test 'nonce-[^']+'/);
  assert.match(html, /script-src vscode-webview:\/\/test 'nonce-[^']+'/);
  assert.match(html, /img-src data:/);
});
