# Project Status

Last reviewed: 2026-07-31

Tanu Markdown is an early-stage, pre-1.0 project. The core Rust implementation
supports document creation, `.tmd` and `.tmdp` round trips, attachment metadata
and cross-reference validation, atomic file replacement, and embedded SQLite
operations. The CLI exposes the complete implemented workflow through both
human-readable commands and a versioned JSON bridge. The VS Code extension is
a functional custom editor backed exclusively by that bridge.

## Component status

| Component | Current state |
| --- | --- |
| `tmd-core` | Implements the document model, structured validation, safe attachment handling, atomic writes, SQLite import/export/migration, ZIP I/O, polyglot boundary handling, and optional C ABI functions |
| `tmd-cli` | Installs `tmd`; implements document create/inspect/update/convert/validate, attachment lifecycle, safe HTML export, and embedded database lifecycle/query commands |
| `tmd-core-ffi` | Builds a `cdylib` wrapper and retains the exported `tmd-core` FFI symbols |
| `tmd-vscode` | Implements a CSP-restricted custom editor with edit/save/revert/backup, safe live preview, attachment, validation, HTML export, and conversion workflows through `tmd` |
| `tmd-sample` | Contains equivalent `.tmd` and `.tmdp` samples with an attachment and populated SQLite table |

## Verified behavior

The `tmd-core` test suite covers:

- logical attachment path validation;
- duplicate and unsafe archive-entry rejection;
- attachment add, rename, remove, mutation, and SHA-256 refresh;
- Markdown `attach:` cross-reference and database version reports;
- failed atomic-write preservation;
- `.tmd` and `.tmdp` round trips;
- embedded SQLite export, import, reset, and migration;
- path-based read/write helpers;
- optional FFI null-pointer behavior.

CLI integration tests exercise full `.tmd` and `.tmdp` lifecycles. Extension
tests cover its process boundary and safe preview. Repository CI additionally
checks formatting, Clippy, rustdoc, samples, extension tests, and VSIX
packaging.

## Known limitations

- The versioned TMD 1.0 specification remains a draft; pre-1.0 compatibility is
  not guaranteed.
- Core reads still buffer complete containers and attachment data in memory.
- The extension currently supports local `file:` documents only and its live
  preview intentionally renders a safe Markdown subset.
- The C ABI does not ship generated headers or a stable ABI compatibility
  policy.
- Malformed containers are generated in tests rather than retained as binary
  fixtures, and large-document performance is not yet characterized.

## Next milestones

Future work should be tracked as GitHub Issues. Likely milestones are:

1. Stabilize the TMD 1.0 draft and define compatibility fixtures.
2. Characterize large-document limits and consider streaming attachment I/O.
3. Define C ABI headers and version negotiation.
4. Complete marketplace, privacy, and release review before publishing.

See [publish readiness](docs/publish-readiness.md) for the gates that remain.
