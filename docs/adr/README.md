# Architecture Decision Records

This directory records architectural decisions whose consequences extend
across components, public interfaces, or the TMD file format. The records are
deliberately short; the normative format contract remains in
[`docs/spec-tmd-1.0-draft.md`](../spec-tmd-1.0-draft.md), and current component
details remain in [`docs/architecture.md`](../architecture.md).

The initial records are retrospective. Their decision dates identify when the
decision became visible in the implementation or merged history; they were
written down as ADRs on 2026-08-18.

## Status lifecycle

- **Proposed**: under discussion and not yet an implementation contract.
- **Accepted**: the repository is expected to follow the decision.
- **Deprecated**: retained for history but no longer recommended for new work.
- **Superseded**: replaced by another ADR, which must be linked from both
  records.

Accepted records are immutable except for typo and link corrections. Change a
decision by adding a new ADR and marking the old one superseded. New records
start from [`template.md`](template.md), use the next four-digit number, and
describe compatibility impact when they affect the archive, manifest, CLI JSON,
or C ABI.

## Index

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-use-one-self-contained-tmd-container.md) | Accepted | Use one self-contained `.tmd` ZIP container |
| [0002](0002-embed-sqlite-for-structured-document-data.md) | Accepted | Embed SQLite for structured document data |
| [0003](0003-keep-format-semantics-in-rust.md) | Accepted | Keep format semantics in Rust |
| [0004](0004-use-a-versioned-cli-json-editor-bridge.md) | Accepted | Use a versioned CLI JSON editor bridge |
| [0005](0005-separate-editable-formula-tables-and-rhai-views.md) | Accepted | Separate editable Formula tables and Rhai views |
| [0006](0006-publish-documents-atomically-with-revision-checks.md) | Accepted | Publish documents atomically with revision checks |
