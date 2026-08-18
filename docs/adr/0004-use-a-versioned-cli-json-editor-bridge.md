# 0004: Use a versioned CLI JSON editor bridge

- Status: Accepted
- Decision date: 2026-07-31

## Context

The VS Code extension needs inspection, preview, validation, attachment,
database, and save behavior from the Rust implementation. A native Node module
would add runtime and packaging coupling, while parsing the container in the
extension would violate the Rust authority boundary. Editor previews must also
evaluate unsaved Markdown, source definitions, and Rhai scripts without first
writing them into the user's document.

## Decision

Use the `tmd` CLI as a schema-versioned JSON process boundary for the editor.
Invoke it with argument arrays and no shell. JSON operations accept explicit
`schema_version` fields and return machine-readable results. Preview and data
source evaluation may receive bounded in-memory overrides for unsaved Markdown,
registry extras, and UTF-8 script attachments.

Keep VS Code lifecycle and typed host messages in a thin bridge. Keep one
document's draft, revisions, retained bytes, operation queue, and CLI calls in
`LocalTmdSession`. The webview owns presentation state and never parses the
container. Platform VSIX packages bundle the matching native CLI; an explicit
machine-level path may select another compatible binary.

## Consequences

- Terminal and editor workflows exercise the same public Rust behavior.
- The boundary is testable and language-neutral, and schema fields allow
  incompatible messages to fail explicitly.
- Unsaved previews remain non-persistent while still resolving the embedded
  database and attachments from retained document bytes.
- One-shot processes add startup and serialization cost; debouncing and the
  per-document queue are required for interactive use.
- Each supported platform needs a matching CLI binary in production packages.
- A future persistent or remote session can replace the local process adapter
  behind the host bridge without moving format authority into the webview.

## Alternatives considered

- **A Node native addon over the C ABI**: avoids child processes but increases
  ABI, runtime, and cross-platform packaging complexity.
- **A TypeScript container implementation**: simplifies deployment but creates
  a second source of truth for the format and its safety rules.
- **A mandatory persistent daemon**: can reduce process overhead, but adds
  lifecycle and deployment complexity before it is needed.

## References

- [Architecture](../architecture.md)
- [`tmd` CLI JSON contracts](../../tmd-cli/README.md)
- [Tanu Markdown Editor](../../tmd-vscode/README.md)
- Pull requests [#30](https://github.com/Nagitch/tanu-markdown/pull/30) and
  [#42](https://github.com/Nagitch/tanu-markdown/pull/42)
