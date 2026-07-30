# Architecture

Tanu Markdown separates the file-format implementation from delivery surfaces
so that the Rust core remains the single source of truth.

## Component relationships

```text
                         +------------------+
                         | tmd-vscode       |
                         | editor scaffold  |
                         +------------------+

+------------------+     +------------------+     +------------------+
| tmd-cli          | --> | tmd-core         | <-- | tmd-core-ffi     |
| terminal UX      |     | model and I/O    |     | C ABI cdylib     |
+------------------+     +------------------+     +------------------+
                               |
                               v
                       .tmd / .tmdp files
                               |
                               v
                         tmd-sample fixtures
```

`tmd-cli` and `tmd-core-ffi` depend on `tmd-core`. The VS Code extension is
currently independent and must not duplicate format parsing as it matures; it
should call a stable CLI, native binding, or future WebAssembly boundary.

## `tmd-core`

The core crate owns:

- `TmdDoc`, `Manifest`, and attachment metadata;
- logical attachment path normalization and SHA-256 validation;
- embedded SQLite lifecycle and migration helpers;
- `.tmd` ZIP serialization;
- `.tmdp` Markdown-plus-ZIP serialization and boundary validation;
- optional C ABI functions behind the `ffi` feature.

The crate currently keeps attachment and complete-container data in memory
during I/O. Public mode flags that imply lazy, solid, or deduplicated behavior
are future extension points and should not be documented as complete until
implemented.

## `tmd-cli`

The CLI translates terminal inputs into `tmd-core` operations. It owns:

- argument parsing and exit errors;
- format selection from output extensions;
- human-readable validation and database output;
- Markdown-to-HTML rendering.

File-format validation belongs in `tmd-core`, not in CLI-only code.

## `tmd-core-ffi`

The FFI crate produces the dynamic library and retains the symbols implemented
by the `tmd-core` `ffi` feature. It does not currently define a generated header,
ABI version negotiation, or cross-language packaging policy.

## `tmd-vscode`

The extension owns editor activation, commands, and VS Code user experience.
Most commands remain placeholders. Format operations should eventually cross a
documented integration boundary rather than reimplement the container.

## Repository-level contracts

- The root Cargo workspace and `Cargo.lock` define one Rust dependency graph.
- `rust-toolchain.toml` and `Dockerfile` define supported toolchains.
- `justfile` and `.github/workflows/ci.yml` define equivalent local and CI
  checks.
- `docs/format-overview.md` records the implemented file structure.
- GitHub Issues are the source of truth for future work.
