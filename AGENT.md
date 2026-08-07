# AGENT.md — Tanu Markdown

This document defines repository-specific guidance for human and AI
contributors.

## Project role

Tanu Markdown provides a self-contained document format and its supporting
tools. `.tmd` is the ZIP container implemented throughout the repository.

The current format is pre-1.0. Preserve existing behavior unless an issue
explicitly changes the contract, and document compatibility effects when it
does.

## Repository boundaries

- `tmd-data/` owns transport-neutral scalar and ordered-table value types.
- `tmd-formula/` owns Formula parsing, evaluation, functions, limits, and
  structured diagnostics; it must not depend on TMD containers or SQLite.
- `tmd-core/` owns the document model, serialization, validation, attachments,
  embedded SQLite lifecycle, data-source integration, and optional FFI
  definitions.
- `tmd-cli/` owns command parsing and user-facing terminal behavior.
- `tmd-core-ffi/` owns the dynamic-library wrapper that retains exported C ABI
  symbols.
- `tmd-vscode/` owns VS Code integration.
- `tmd-sample/` owns checked-in reference files.
- `docs/` owns architecture, format, workflow, and readiness documentation.

Do not move behavior across these boundaries without documenting the reason.

## Authoritative development environment

Use the Dev Container in `.devcontainer/` as the authoritative environment.
The repository pins Rust in `rust-toolchain.toml` and Node in `Dockerfile`.

Do not assume Rust, Cargo, Node.js, or npm are installed on the host. Prefer:

```bash
devcontainer exec --workspace-folder . just check-all
```

If the Dev Container CLI is unavailable, use the `dev` Docker Compose service.
If neither route is available, report the validation gap explicitly.

## Required validation

Before committing:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo run --locked -p tmd-cli -- validate tmd-sample/sample.tmd
RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps
npm ci --prefix tmd-vscode
npm run check --prefix tmd-vscode
```

`just check-all` runs the complete set.

## Rust and TypeScript conventions

- Rust formatting is controlled by `rustfmt`.
- Treat all Clippy warnings as errors.
- Prefer `thiserror` for library errors and `anyhow` at CLI boundaries.
- Public Rust APIs require `///` documentation and tests.
- Crates require `//!` crate-level documentation.
- TypeScript must compile with `strict` mode and must not introduce implicit
  `any`.
- Keep generated Rust, npm, and editor outputs out of Git. Commit the root
  `Cargo.lock` and `tmd-vscode/package-lock.json`.

## Documentation rules

- English documentation is the source of truth.
- Keep `README.md`, `PROJECT_STATUS.md`, component READMEs, and `docs/`
  consistent with implementation.
- Update `docs/format-overview.md` whenever the container contract changes.
- Update `docs/architecture.md` whenever component responsibility changes.
- Do not describe planned work as implemented behavior.

## Work tracking

GitHub Issues are the source of truth for planned work.

- Use `.github/ISSUE_TEMPLATE/work-item.md`.
- Ensure an issue exists before implementation work opens a PR.
- Create branches from `origin/main`.
- Prefer issue-linked names such as
  `codex/issue-25-modernize-repository`.
- Link the issue from the PR and record exact validation evidence.
- Do not add standalone TODO/task-tracking files in the repository.

## Dependency and publishing policy

- Keep dependencies on supported, non-pre-release releases and commit refreshed
  lockfiles.
- Dependabot covers Cargo, npm, GitHub Actions, Docker, and Dev Containers.
- Publishing is disabled until an explicit stabilization issue changes the
  policy.
- Do not run `cargo publish`, publish the VS Code extension, create releases, or
  create release tags without explicit user authorization.
- `cargo publish --dry-run` is allowed only when a publication-readiness issue
  calls for it.

See `docs/publish-readiness.md` for the current checklist.
