# Project Status

Last reviewed: 2026-07-31

Tanu Markdown is an early-stage, pre-1.0 project. The core Rust implementation
supports document creation, `.tmd` and `.tmdp` round trips, attachment metadata
and hash validation, and embedded SQLite operations. The CLI exposes the
implemented core workflows. The VS Code extension remains a command scaffold
and is not a full editor.

## Component status

| Component | Current state |
| --- | --- |
| `tmd-core` | Implements the document model, manifest and attachment handling, SQLite import/export/migration, ZIP I/O, polyglot boundary handling, and optional C ABI functions |
| `tmd-cli` | Implements `new`, `convert`, `validate`, `export-html`, and embedded database subcommands |
| `tmd-core-ffi` | Builds a `cdylib` wrapper and retains the exported `tmd-core` FFI symbols |
| `tmd-vscode` | Registers document, attachment, validation, export, conversion, and welcome commands; most feature commands are placeholders |
| `tmd-sample` | Contains one `.tmd` and one `.tmdp` reference sample |

## Verified behavior

The `tmd-core` test suite covers:

- logical attachment path validation;
- attachment add, rename, remove, mutation, and SHA-256 refresh;
- `.tmd` and `.tmdp` round trips;
- embedded SQLite export, import, reset, and migration;
- path-based read/write helpers;
- optional FFI null-pointer behavior.

Repository CI additionally checks formatting, Clippy, rustdoc, and VS Code
extension type compilation.

## Known limitations

- The file-format contract is not yet frozen or published as a versioned formal
  specification.
- `ReadMode::lazy_attachments` and several `WriteMode` options are represented
  in the API but are not fully realized as streaming/deduplication behavior.
- The VS Code extension does not yet call the Rust CLI or library for validation
  and conversion.
- The C ABI does not ship generated headers or a stable ABI compatibility
  policy.
- The sample set does not yet cover corrupted containers or large documents.

## Next milestones

Future work should be tracked as GitHub Issues. Likely milestones are:

1. Freeze and test a versioned TMD container specification.
2. Make all read/write mode options either functional or explicitly unsupported.
3. Add malformed-container and compatibility fixtures.
4. Connect the VS Code extension to real validation and conversion workflows.
5. Define crate, ABI, and extension release policies before publishing.

See [publish readiness](docs/publish-readiness.md) for the gates that remain.
