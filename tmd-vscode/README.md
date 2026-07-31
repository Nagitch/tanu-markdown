# Tanu Markdown Editor

This directory contains the VS Code custom editor for Tanu Markdown.

It opens `.tmd` and `.tmdp` files through `tmd inspect --json` and provides:

- Markdown and title editing with undo/redo;
- save, save as, revert, and hot-exit backup support;
- attachment and database summaries;
- document validation with actionable issues;
- a live, non-executable safe Markdown preview;
- document creation, attachment add/remove, HTML export, and format conversion.

Container parsing remains exclusively in Rust. The extension passes argument
arrays directly to the installed CLI without invoking a shell.
Commands retain the document that originated the action across dialogs and
asynchronous saves. Saves, reads, exports, and attachment mutations are
serialized per document so concurrent CLI read-modify-write operations cannot
overwrite each other. Validation results are applied only when the checked
editor revision is still current.

## Requirements

Install the CLI and ensure VS Code can locate it:

```bash
cargo install --path tmd-cli
tmd --version
```

If it is outside the VS Code process `PATH`, set
`tanuMarkdown.cliPath` to its absolute path. `tanuMarkdown.timeoutMs` controls
the per-operation timeout.

## Development

From the repository root:

```bash
npm ci --prefix tmd-vscode
npm run check --prefix tmd-vscode
npm test --prefix tmd-vscode
npm run pack --prefix tmd-vscode
```

The extension targets VS Code `^1.90.0` and uses strict TypeScript settings.
Generated `dist/`, `node_modules/`, and `.vsix` files are not committed. The
package command verifies the exact minimal VSIX contents.

The webview permits no default network or resource source. Its styles and
scripts require a per-panel nonce, user content is escaped, DOM lists use
`textContent`, and preview links cannot navigate.

The extension is not currently approved for marketplace publication.
