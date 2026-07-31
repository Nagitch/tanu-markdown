# Architecture

Tanu Markdown separates the file-format implementation from delivery surfaces
so that the Rust core remains the single source of truth.

## Component relationships

```text
+------------------+     +------------------+     +------------------+
| tmd-vscode       | --> | tmd CLI/JSON     | --> | tmd-core         |
| custom editor    |     | terminal UX      |     | model and I/O    |
+------------------+     +------------------+     +------------------+
                                                      ^
                                                      |
                                              +------------------+
                                              | tmd-core-ffi     |
                                              | C ABI cdylib     |
                                              +------------------+
                               |
                               v
                       .tmd / .tmdp files
                               |
                               v
                         tmd-sample fixtures
```

`tmd-cli` and `tmd-core-ffi` depend on `tmd-core`. The VS Code extension calls
the installed `tmd` binary through its schema-versioned JSON bridge and never
parses `.tmd`/`.tmdp` containers in TypeScript.

## `tmd-core`

The core crate owns:

- `TmdDoc`, `Manifest`, and attachment metadata;
- logical attachment path normalization and SHA-256 validation;
- embedded SQLite lifecycle and migration helpers;
- `.tmd` ZIP serialization;
- `.tmdp` Markdown-plus-ZIP serialization and boundary validation;
- optional C ABI functions behind the `ffi` feature.

The crate currently keeps attachment and complete-container data in memory
during I/O. Public read/write modes expose only implemented hash-verification
and hash-recomputation choices.

## `tmd-cli`

The CLI translates terminal inputs into `tmd-core` operations. It owns:

- argument parsing and exit errors;
- format selection from output extensions;
- human-readable and schema-versioned JSON inspection/updates;
- attachment and SQLite lifecycle UX;
- Markdown-to-HTML rendering with real `attach:` URL rewriting.

HTML rendering neutralizes raw markup and executable URL schemes. Self-contained
exports retain passive raster-image and plain-text MIME types and downgrade
other attachment data URIs to `application/octet-stream`. File-format
validation belongs in `tmd-core`, not in CLI-only code.

## `tmd-core-ffi`

The FFI crate produces the dynamic library and retains the symbols implemented
by the `tmd-core` `ffi` feature. It does not currently define a generated header,
ABI version negotiation, or cross-language packaging policy.

## `tmd-vscode`

The extension owns custom-document state, undo/redo, save/revert/backup,
commands, safe live preview, and VS Code user experience. It invokes the CLI
with argument arrays and no shell. The webview uses a restrictive content
security policy, nonce-bound scripts/styles, DOM text APIs, and escaped preview
HTML. The current editor supports local files only.

## Repository-level contracts

- The root Cargo workspace and `Cargo.lock` define one Rust dependency graph.
- `rust-toolchain.toml` and `Dockerfile` define supported toolchains.
- `justfile` and `.github/workflows/ci.yml` define equivalent local and CI
  checks.
- `docs/spec-tmd-1.0-draft.md` defines the versioned implemented format.
- GitHub Issues are the source of truth for future work.
