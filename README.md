# Tanu Markdown

Tanu Markdown (TMD) is a self-contained document format that keeps Markdown,
metadata, attachments, and a SQLite database in one portable file. Markdown
can render named, read-only SQLite sources as inline scalars or block tables,
and sandboxed Rhai scripts can transform declared SQLite inputs into tables.

This repository contains the Rust document library, the installed `tmd`
command-line interface, a C-compatible dynamic library, a VS Code custom
editor, and executable sample documents. The project is pre-1.0: the
implementation is usable, but its compatibility contract is not yet frozen.

## Format

A Tanu Markdown document uses the `.tmd` extension and is stored as a ZIP
container. It contains `manifest.json`, `index.md`, `attachments.json`,
`db/main.sqlite3`, and attachment entries.

See the [TMD 1.0 draft specification](docs/spec-tmd-1.0-draft.md) for the
normative implemented contract and the
[format overview](docs/format-overview.md) for a shorter introduction.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `tmd-core/` | Rust document model, attachment handling, SQLite lifecycle/data views, and `.tmd` I/O |
| `tmd-cli/` | CLI for creating, validating, publishing, exporting, and editing documents |
| `tmd-core-ffi/` | C ABI dynamic-library wrapper around the optional `tmd-core` FFI surface |
| `tmd-vscode/` | VS Code custom editor using the `tmd` JSON bridge |
| `tmd-sample/` | Reference `.tmd` file |
| `docs/` | Architecture, format, workflow, and release-readiness documentation |

The Rust packages form one Cargo workspace and share the root `Cargo.lock`.

## Quick start

The supported development environment is the Dev Container. In VS Code, open
the repository with the Dev Containers extension, run **Dev Containers: Reopen
in Container** (or **Rebuild and Reopen in Container** for an existing setup),
then press **F5** with **Run Tanu Markdown Editor (sample)** selected. The
container setup builds and stages the CLI automatically and the debug host
opens the Rhai-enabled reference sample.

From a terminal with Docker:

```bash
docker compose build
docker compose run --rm dev bash
```

Inside the container:

```bash
cargo test --workspace --all-features
npm ci --prefix tmd-vscode
npm test --prefix tmd-vscode
```

Install the CLI locally, then create and inspect a document:

```bash
cargo install --path tmd-cli
tmd new notes.tmd --title "Project Notes"
tmd inspect notes.tmd --json
tmd validate notes.tmd
tmd export-html notes.tmd notes.html --self-contained
```

The CLI also exposes schema-versioned JSON updates and previews, complete
attachment lifecycle commands, read-only JSON database queries, migrations,
and database import/export. HTML export and VS Code preview share the same safe
Rust renderer for attachments, read-only SQLite sources, and sandboxed
Rhai-to-table transformations. Configure
`tanuMarkdown.cliPath` if `tmd` is not on the VS Code process `PATH`.

## Validation

Run the same checks used by CI:

```bash
just check-all
```

The underlying commands are documented in
[the development workflow](docs/dev-workflow.md). CI checks Rust formatting,
Clippy, tests, rustdoc, reference samples, extension tests, and VSIX packaging.

## Documentation

- [Architecture](docs/architecture.md)
- [TMD 1.0 draft specification](docs/spec-tmd-1.0-draft.md)
- [Format overview](docs/format-overview.md)
- [Dynamic data views](docs/dynamic-data-views.md)
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
