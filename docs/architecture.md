# Architecture

Tanu Markdown separates the file-format implementation from delivery surfaces
so that the Rust core remains the single source of truth.

## Component relationships

```text
+------------------+     +------------------+     +------------------+
| SvelteKit Web UI | --> | VS Code bridge   | --> | local TMD session|
| editing surface  |     | lifecycle + I/O  |     | draft + revisions|
+------------------+     +------------------+     +------------------+
                                                      |
                                                      v
                         +------------------+     +------------------+
                         | tmd-core         | <-- | tmd CLI/JSON     |
                         | model and I/O    |     | operation API    |
                         +------------------+     +------------------+
                                  ^
                                  |
                         +------------------+
                         | tmd-core-ffi     |
                         | C ABI cdylib     |
                         +------------------+
```

`tmd-cli` and `tmd-core-ffi` depend on `tmd-core`. The VS Code extension calls
the bundled or explicitly configured `tmd` binary through its schema-versioned
JSON bridge and never parses `.tmd` containers in TypeScript. Preview requests
send the current unsaved Markdown with retained document bytes so the Rust
renderer can query the embedded database and resolve attachments.

## `tmd-core`

The core crate owns:

- `TmdDoc`, `Manifest`, and attachment metadata;
- logical attachment path normalization and SHA-256 validation;
- embedded SQLite lifecycle and migration helpers;
- named dynamic-data registry parsing, read-only SQLite evaluation, and typed
  scalar/table values;
- `.tmd` ZIP serialization;
- optional C ABI functions behind the `ffi` feature.

The crate currently keeps attachment and complete-container data in memory
during I/O. Public read/write modes expose only implemented hash-verification
and hash-recomputation choices.

## `tmd-cli`

The CLI translates terminal inputs into `tmd-core` operations. It owns:

- argument parsing and exit errors;
- `.tmd` path validation;
- human-readable and schema-versioned JSON inspection/updates;
- attachment and SQLite lifecycle UX;
- Markdown-to-HTML and schema-versioned preview rendering with real `attach:`
  URL rewriting and dynamic SQLite views.

HTML rendering neutralizes raw markup and executable URL schemes. Self-contained
exports retain passive raster-image and plain-text MIME types and downgrade
other attachment data URIs to `application/octet-stream`. Linked exports use
flat UUID-based filenames, download-only attachment links, and passive inline
image sources. File-format validation belongs in `tmd-core`, not in CLI-only
code.

## `tmd-core-ffi`

The FFI crate produces the dynamic library and retains the symbols implemented
by the `tmd-core` `ffi` feature. It does not currently define a generated header,
ABI version negotiation, or cross-language packaging policy.

## `tmd-vscode`

The editor is divided into three responsibilities:

- a statically generated SvelteKit Web UI owns controls, layout, local
  presentation state, and input/response ordering;
- the VS Code bridge owns custom-editor lifecycle, commands, undo/redo events,
  dialogs, and typed messages between VS Code and the editing surface; and
- `LocalTmdSession` owns one opened document's draft, revisions, retained
  container bytes, operation serialization, and calls to the Rust CLI.

The Web UI uses `adapter-static`, builds as separate JavaScript and CSS assets,
and contains no TMD container parser. The VS Code bridge rewrites the generated
asset URLs to webview resource URIs and injects a per-panel CSP nonce. A browser
host can provide the same small host adapter instead of the VS Code API. The
current local session invokes the existing one-shot CLI JSON operations, so
terminal commands and editor use coexist. A future persistent stdio or remote
collaborative session can sit behind the host bridge without moving document
authority into the editing surface. RevoGrid and the table-specific interaction
model are deliberately deferred to
[issue #43](https://github.com/Nagitch/tanu-markdown/issues/43).

Platform-specific VSIX packages carry the matching native CLI. A machine-level
setting may select an external CLI, while generic development packages fall
back to `PATH`. The extension invokes the selected CLI with argument arrays and
no shell. The webview uses a restrictive content security policy, bundled
styles and scripts, DOM text APIs, and escaped preview HTML. Edit state is sent
immediately so closing a panel cannot strand input; only preview rendering is
debounced. Commands remain bound to their originating document across
asynchronous work, and all document I/O runs through the session's
per-document serial queue. The current editor supports local files only.

## Repository-level contracts

- The root Cargo workspace and `Cargo.lock` define one Rust dependency graph.
- `rust-toolchain.toml` and `Dockerfile` define supported toolchains.
- `justfile` and `.github/workflows/ci.yml` define equivalent local and CI
  checks.
- `docs/spec-tmd-1.0-draft.md` defines the versioned implemented format.
- GitHub Issues are the source of truth for future work.
