# Project Status

Last reviewed: 2026-08-11

Tanu Markdown is an early-stage, pre-1.0 project. The core Rust implementation
supports document creation, `.tmd` round trips, attachment metadata
and cross-reference validation, atomic file replacement, and embedded SQLite
operations. The CLI exposes the complete implemented workflow through both
human-readable commands and a versioned JSON bridge. The VS Code extension is
a functional custom editor backed exclusively by that bridge.

## Component status

| Component | Current state |
| --- | --- |
| `tmd-data` | Defines transport-neutral, serde-compatible scalar and ordered-table values shared by data-source adapters and computation engines |
| `tmd-formula` | Implements the bounded Formula parser, opaque program representation, dependency-aware evaluator, built-in functions, caller-supplied table limits and reference resolution, and structured diagnostics without depending on TMD or SQLite |
| `tmd-core` | Implements the document model, structured validation, safe attachment handling, atomic writes, SQLite import/export/migration, managed Formula table evaluation, constraints, hidden relationship storage and cross-table `REF`, legacy query/computed Formula evaluation, explicit transactional keyed table edits, sandboxed Rhai-to-table transformations, legacy SQLite-source compatibility, ZIP I/O, and optional C ABI functions |
| `tmd-cli` | Installs `tmd`; implements document create/inspect/update/publish/validate, attachment lifecycle including bounded UTF-8 reads and draft overrides, staged SQLite cell edits, shared safe preview/HTML rendering, typed table-source evaluation with edit metadata, dynamic `scalar`/`table` views, and embedded database lifecycle/query commands |
| `tmd-core-ffi` | Builds a `cdylib` wrapper and retains the exported `tmd-core` FFI symbols |
| `tmd-vscode` | Implements a CSP-restricted static SvelteKit Web UI with a RevoGrid managed Formula editor, 3-by-3 Any table creation, progressive column/cell constraints, per-cell formulas and type presence, arbitrary row/column insertion and duplication, range extraction, value-preserving normalization with generated `REF` formulas, double-click column auto-sizing, editable Formula tables in safe preview, read-only Rhai output, a sticky operation status bar, and a shared local document session whose edits participate in undo, preview, save, revert, and backup |
| `tmd-sample` | Contains a `.tmd` sample demonstrating managed Any/typed tables, per-cell Formula results, literal normalization presence, and a read-only Rhai view |

## Verified behavior

The `tmd-data` and `tmd-formula` test suites cover typed scalar formatting plus
Formula parsing, references, functions, dependency evaluation, limits,
structured diagnostics, and the engine's public API without `tmd-core`.

The `tmd-core` test suite covers:

- logical attachment path validation;
- duplicate and unsafe archive-entry rejection;
- attachment add, rename, remove, mutation, and SHA-256 refresh;
- Markdown `attach:` cross-reference and database version reports;
- failed atomic-write preservation;
- `.tmd` round trips;
- embedded SQLite export, import, reset, and migration;
- managed Formula literal and dependency evaluation, progressive constraints,
  stable relationships, hidden relationship storage, cross-table `REF`,
  managed-Formula-to-Rhai input, legacy query/computed
  Formula behavior, transactional keyed SQLite cell edits, strict table-output
  validation, and dynamic-view validation;
- path-based read/write helpers;
- optional FFI null-pointer behavior.

CLI integration tests exercise the full `.tmd` lifecycle, including draft Rhai
attachment and Formula program evaluation. Extension tests cover its process
boundary, edit metadata, Formula copy translation, script diagnostics,
document-state integration, and safe preview.
Repository CI additionally checks formatting, Clippy, rustdoc, samples,
extension tests, generic VSIX
packaging, static Linux CLI verification, and native CLI staging for
platform-specific VSIX artifacts.

## Known limitations

- The versioned TMD 1.0 specification remains a draft; pre-1.0 compatibility is
  not guaranteed.
- Core reads still buffer complete containers and attachment data in memory.
- The extension currently supports local `file:` documents only. Preview uses
  the safe Rust renderer and falls back to its previous safe Markdown subset
  with a visible diagnostic when the CLI is missing, outdated, incompatible,
  or unavailable.
- Dynamic data currently supports managed Formula sources, Rhai
  transformations, legacy query/computed Formula sources, and the
  `scalar` and `table` renderers. Structured JSON/YAML/TOML attachments,
  computed-source pipelines, `list`, and `code` remain planned in
  [issue #35](https://github.com/Nagitch/tanu-markdown/issues/35).
- Managed Formula editing supports arbitrary row and column insertion,
  duplication, per-cell formulas, progressive types, safe-preview editing,
  range extraction, and conservative literal normalization that preserves
  displayed values through generated references. Legacy
  query-backed modes retain their previous write-back limitations. Multi-sheet
  formulas, automatic relational joins beyond explicit `REF`, database row insertion, richer display
  formatting, and collaborative conflict handling remain outside this slice.
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
