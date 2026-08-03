# Development Workflow

The repository uses the same maintenance baseline for local development and
GitHub Actions.

## Tooling

- Rust `1.96.0`, pinned in `rust-toolchain.toml`
- Node.js `24.17.0`, pinned in `Dockerfile`
- npm lockfile in `tmd-vscode/package-lock.json`
- `just 1.57.0` in the development image

The Dev Container is authoritative. Host installations are optional.

## Start the environment

In VS Code, run **Dev Containers: Reopen in Container**. If this repository was
already open in an older container, use **Dev Containers: Rebuild and Reopen in
Container** once so the updated environment and post-create hook take effect.
The post-create hook installs extension dependencies, builds the debug `tmd`
CLI, compiles the extension, stages the CLI at `tmd-vscode/bin/tmd`, and
validates the reference sample. The container also adds `target/debug` to the
VS Code environment's `PATH`, so `tmd` is available from a new integrated
terminal.

To exercise the custom editor:

1. Open **Run and Debug**.
2. Select **Run Tanu Markdown Editor (sample)**.
3. Press **F5**.

The pre-launch task incrementally rebuilds Rust and TypeScript, restages the
CLI, validates `tmd-sample/sample.tmd`, and opens that file in an Extension
Development Host window. Its Preview tab evaluates the SQLite-to-Rhai category
summary through the same CLI/core path used by packaged extensions. The Sources
tab edits both SQLite queries and schema-version-2 Rhai table definitions. Rhai
script bodies remain attachments and are resolved from the retained sample while
unsaved definition changes are previewed.

The default build task (**Terminal: Run Build Task**) runs the same preparation
script without starting an Extension Development Host.

With the Dev Container CLI:

```bash
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . just check-all
```

With Docker Compose:

```bash
docker compose build
docker compose run --rm dev bash
just check-all
```

## Checks

| Area | Command |
| --- | --- |
| Rust formatting | `cargo fmt --all --check` |
| Rust linting | `cargo clippy --workspace --all-targets --all-features -- -D warnings` |
| Rust tests | `cargo test --workspace --all-features` |
| Reference samples | `just samples` |
| Rust documentation | `RUSTDOCFLAGS="-D warnings" cargo doc --workspace --all-features --no-deps` |
| Extension install | `npm ci --prefix tmd-vscode` |
| Extension type check | `npm run check --prefix tmd-vscode` |
| Extension tests | `npm test --prefix tmd-vscode` |
| Extension package | `npm run pack --prefix tmd-vscode` |

`just check-all` runs all checks. CI uses `--locked` for Cargo to ensure the
committed dependency graph is reproducible.

## Dependency updates

Dependabot opens monthly grouped updates for Cargo, npm, GitHub Actions, Docker,
and Dev Containers. For manual updates:

1. Check the new package's Rust or Node.js requirements.
2. Update the workspace or extension manifest.
3. Regenerate only the root `Cargo.lock` or
   `tmd-vscode/package-lock.json`.
4. Review changelogs for breaking changes.
5. Run `just check-all`.
6. Record compatibility fixes and validation in the PR.

Avoid per-crate Cargo lockfiles; the root workspace lockfile is authoritative.
The extension pins `@types/vscode` to its minimum supported VS Code engine
version; bump those two versions together rather than accepting newer APIs by
accident.

## Documentation and tests

- Public Rust APIs require doc comments and unit or integration coverage.
- Add round-trip tests for file-format behavior.
- Add malformed-input tests for new validation rules.
- Update `docs/format-overview.md` with format changes.
- Update `docs/architecture.md` with responsibility changes.
- Keep `PROJECT_STATUS.md` factual; track planned work in GitHub Issues.

## Issue and PR workflow

1. Create a scoped work-item issue.
2. Branch from `origin/main`.
3. Implement and document the change.
4. Run the repository checks.
5. Open a draft PR linked with `Closes #<issue>`.

Do not publish packages or create releases as part of this workflow.
