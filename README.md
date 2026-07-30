# Tanu Markdown

Tanu Markdown (TMD) is a self-contained document format that keeps Markdown,
metadata, attachments, and a SQLite database in one portable file.

This repository contains the Rust document library, command-line interface,
C-compatible dynamic library, VS Code extension scaffold, and sample documents.
The project is pre-1.0: the implementation is usable for development and
experimentation, but the file-format contract is not yet frozen.

## Formats

Tanu Markdown supports two representations of the same logical document:

| Extension | Representation | Intended use |
| --- | --- | --- |
| `.tmd` | ZIP container | Primary editable and machine-oriented format |
| `.tmdp` | UTF-8 Markdown followed by a ZIP container | Polyglot format for readable previews and portable sharing |

Both variants contain `manifest.json`, `index.md`, `attachments.json`,
`db/main.sqlite3`, and attachment entries. A `.tmdp` file also stores the
Markdown length in the ZIP end-of-central-directory comment.

See [the format overview](docs/format-overview.md) for the current contract.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `tmd-core/` | Rust document model, attachment handling, SQLite lifecycle, and `.tmd`/`.tmdp` I/O |
| `tmd-cli/` | CLI for creating, converting, validating, exporting, and editing documents |
| `tmd-core-ffi/` | C ABI dynamic-library wrapper around the optional `tmd-core` FFI surface |
| `tmd-vscode/` | VS Code extension scaffold and command registration |
| `tmd-sample/` | Reference `.tmd` and `.tmdp` files |
| `docs/` | Architecture, format, workflow, and release-readiness documentation |

The Rust packages form one Cargo workspace and share the root `Cargo.lock`.

## Quick start

The supported development environment is the Dev Container. In VS Code, open
the repository with the Dev Containers extension. From a terminal with Docker:

```bash
docker compose build
docker compose run --rm dev bash
```

Inside the container:

```bash
cargo test --workspace --all-features
npm ci --prefix tmd-vscode
npm run check --prefix tmd-vscode
```

Create and inspect a document with the CLI:

```bash
cargo run -p tmd-cli -- new notes.tmd --title "Project Notes"
cargo run -p tmd-cli -- validate notes.tmd
cargo run -p tmd-cli -- convert notes.tmd notes.tmdp
cargo run -p tmd-cli -- export-html notes.tmd notes.html --self-contained
```

## Validation

Run the same checks used by CI:

```bash
just check-all
```

The underlying commands are documented in
[the development workflow](docs/dev-workflow.md). CI checks Rust formatting,
Clippy, tests, rustdoc, and the VS Code extension type build.

## Documentation

- [Architecture](docs/architecture.md)
- [Format overview](docs/format-overview.md)
- [Development workflow](docs/dev-workflow.md)
- [Publish readiness](docs/publish-readiness.md)
- [Current project status](PROJECT_STATUS.md)
- [Contributing](CONTRIBUTING.md)

Component-specific usage is documented in each component's README.

## Compatibility and releases

Tanu Markdown follows Semantic Versioning for packages, but the project remains
at version `0.0.x`. No crate, extension, release, or file-format compatibility
guarantee should be assumed until an explicit stabilization milestone is
completed. Publishing is disabled in the Cargo workspace.

## License

MIT. See [LICENCE](LICENCE).
