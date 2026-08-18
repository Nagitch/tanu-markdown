# 0003: Keep format semantics in Rust

- Status: Accepted
- Decision date: 2026-07-31

## Context

Tanu Markdown is delivered as a Rust library, command-line tool, C ABI, and VS
Code editor. If each surface parses containers, validates paths, renders views,
or evaluates Formula independently, behavior and security rules will diverge.
At the same time, reusable table values and Formula semantics should not depend
on the document container.

## Decision

Make the Rust workspace the authority for implemented document behavior:

- `tmd-data` owns transport-neutral scalar and ordered-table values;
- `tmd-formula` owns the bounded Formula language and depends only on
  `tmd-data`;
- `tmd-core` owns the TMD model, container I/O, attachments, SQLite lifecycle,
  validation, rendering integration, and dynamic-source registry;
- `tmd-cli` and `tmd-core-ffi` adapt `tmd-core` to process and C ABI boundaries;
  and
- delivery UIs request document operations through those adapters and do not
  implement a second container parser.

Document-specific behavior belongs in `tmd-core`; reusable data and Formula
behavior must remain independent of the container and editor.

## Consequences

- Validation, path safety, rendering, and format compatibility are consistent
  across the CLI, FFI, export, and editor.
- Formula can later be reused through another adapter, including WASM, without
  importing document I/O.
- Frontends need a compatible Rust-built adapter and cannot operate on `.tmd`
  bytes using TypeScript alone.
- Changes to lower layers require coordinated testing of every delivery
  surface, while UI-only changes need not alter the format engine.

## Alternatives considered

- **Parse `.tmd` independently in every client**: removes a native boundary but
  duplicates compatibility and security-sensitive logic.
- **Put all behavior in `tmd-core`**: keeps one crate but prevents Formula and
  typed tables from being reused independently.
- **Make the editor model authoritative**: improves local UI convenience but
  causes CLI and editor documents to follow different rules.

## References

- [Architecture](../architecture.md)
- Pull request [#30](https://github.com/Nagitch/tanu-markdown/pull/30)
- Commit `bbc187c` (`Extract Formula engine into workspace crates`)
