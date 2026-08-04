# Tanu Markdown Editor

This directory contains the VS Code custom editor for Tanu Markdown.

The visible editor is a standalone TypeScript Web UI bundle included in the
extension. VS Code-specific lifecycle and commands stay in a thin host bridge,
while `LocalTmdSession` owns the shared draft, revisions, retained bytes, and
serialized Rust CLI operations for the opened document. The Web UI depends on a
small host-message adapter, so the same editing surface can later run under a
browser or collaborative-service host without learning the `.tmd` format.

It opens `.tmd` files through `tmd inspect --json` and provides:

- Markdown and title editing with undo/redo, including CodeMirror Markdown
  syntax highlighting and VS Code theme colors;
- save, save as, revert, and hot-exit backup support;
- attachment and database summaries;
- document validation with actionable issues;
- a live, non-executable safe Markdown preview with attached images and dynamic
  SQLite `scalar`/`table` views;
- dynamic-view reference inspection plus SQLite query and Rhai table-source
  definition add, edit, remove, undo/redo, preview, and save workflows;
- document creation, attachment add/remove, and HTML export.

Container parsing remains exclusively in Rust. Platform-specific VSIX packages
contain the matching native CLI, and the extension passes argument arrays
directly to that executable without invoking a shell.
The preview bridge sends current unsaved Markdown together with the last
retained `.tmd` bytes, so the CLI can resolve attachments and query the embedded
database without the extension implementing either format. Unsaved SQLite and
Rhai source-definition edits are passed as a preview-only `extras` override and
are not written until the document is saved. Rhai script contents remain
ordinary TMD attachments; the Sources tab edits their logical paths, SQLite
input mappings, and ordered table output columns. An older configured
external CLI falls back to the local safe Markdown renderer.
The preview displays a diagnostic banner when that fallback is active,
distinguishing a missing, outdated, incompatible, or timed-out CLI and directing
the user to `TMD: Select CLI Executable` without interrupting editing.
Commands retain the document that originated the action across dialogs and
asynchronous saves. Saves, reads, exports, and attachment mutations are
serialized per document so concurrent CLI read-modify-write operations cannot
overwrite each other. Validation results are applied only when the checked
editor revision is still current and known to have reached disk. Validation,
attachment mutation and HTML export reject an editor
revision that a racing save has not persisted. Any edit immediately marks the
displayed validation report stale until the current revision is validated.
Edits received while a revert is loading cancel that revert and remain dirty.

## CLI selection

Platform-specific VSIX packages include the CLI and require no separate Rust,
Cargo, or `tmd` installation. The extension resolves the CLI in this order:

1. the machine-level `tanuMarkdown.cliPath` override;
2. the native executable bundled in the VSIX; and
3. `tmd` on the extension host's `PATH`, for generic development packages.

The extension host is the local machine for a local window and the remote
machine or container for Remote SSH and Dev Container windows. To use an
external development build, install it in that environment:

```bash
cargo install --path tmd-cli
tmd --version
```

Run `TMD: Select CLI Executable` to configure an absolute external path. This
setting has machine scope, so a workspace cannot replace the executable that
the extension launches. If no executable is available, opening a document
offers the same selector and a link to these setup instructions.

`tanuMarkdown.timeoutMs` controls the per-operation timeout.

## Development

The repository Dev Container is ready for interactive extension debugging:

1. Run **Dev Containers: Reopen in Container** from the repository root. Use
   **Dev Containers: Rebuild and Reopen in Container** when updating an existing
   development container.
2. Wait for the post-create command to finish.
3. Select **Run Tanu Markdown Editor (sample)** in **Run and Debug** and press
   **F5**.

The build task compiles `tmd-cli` and this extension, stages the debug CLI as
`tmd-vscode/bin/tmd`, validates the reference document, and then opens
`tmd-sample/sample.tmd` in the Extension Development Host. No machine-level
`tanuMarkdown.cliPath` setting or VSIX installation is needed. Run the default
build task manually after changes when an Extension Development Host is already
open; starting a new F5 session runs it automatically.

From the repository root:

```bash
npm ci --prefix tmd-vscode
npm run check --prefix tmd-vscode
npm test --prefix tmd-vscode
npm run pack --prefix tmd-vscode
```

The generic development VSIX does not contain a native CLI. CI builds the CLI
on matching Linux, macOS, and Windows x64/arm64 runners, stages it under
`tmd-vscode/bin`, and invokes `vsce package --target` to produce six
platform-specific artifacts. Linux packages use statically linked musl
binaries so they do not inherit the build runner's glibc requirement.

The extension targets VS Code `^1.90.0` and uses strict TypeScript settings.
Generated `bin/`, `dist/`, `node_modules/`, and `.vsix` files are not committed.
The package command verifies the exact minimal VSIX contents.

The webview permits no default network or resource source. Its bundled styles
and script are restricted to the extension resource origin, CodeMirror's
runtime styles use a per-panel nonce, user content is escaped, DOM lists use
`textContent`, and preview links cannot navigate.

The extension is not currently approved for marketplace publication.
