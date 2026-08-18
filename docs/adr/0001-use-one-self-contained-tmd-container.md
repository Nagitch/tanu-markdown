# 0001: Use one self-contained `.tmd` ZIP container

- Status: Accepted
- Decision date: 2026-08-03

## Context

A Tanu Markdown document must keep Markdown, identity and schema metadata,
attachments, and structured data portable as one artifact. The repository
previously implemented both a normal ZIP representation and `.tmdp`, a polyglot
representation that prefixed readable Markdown to a ZIP archive. Maintaining
two encodings duplicated detection, conversion, validation, editor, and test
paths before the 1.0 contract had stabilized.

## Decision

Use `.tmd` as the only implemented document representation. A `.tmd` file is a
ZIP container with required `manifest.json`, `index.md`, `attachments.json`, and
`db/main.sqlite3` entries plus declared attachment entries. The versioned TMD
specification, rather than a filename sniffer or delivery surface, defines the
container contract.

Do not add another physical representation without a separate compatibility
decision. Readable previews and sharing formats are exports from `.tmd`, not
alternate authoritative documents.

## Consequences

- A complete document can be copied, attached, backed up, and validated as one
  file.
- Core, CLI, FFI, and editor paths share one serialization and validation path.
- Ordinary Markdown tools cannot edit the container directly; users need TMD
  tooling or an exported view.
- Mutations rewrite and atomically replace a container, so implementation code
  must preserve relevant filesystem metadata and detect unsafe aliases.
- `.tmdp` is intentionally unsupported for the MVP; restoring it would require
  a new ADR and explicit migration policy.

## Alternatives considered

- **Keep `.tmdp` beside `.tmd`**: it offered a readable prefix but doubled the
  format and compatibility surface.
- **Markdown with sidecar files**: it is friendly to text tools but loses the
  single portable artifact and creates synchronization failure modes.
- **A directory package**: it makes individual entries visible but complicates
  sharing, atomic replacement, and identity of a document.

## References

- [TMD 1.0 draft specification](../spec-tmd-1.0-draft.md)
- [Format overview](../format-overview.md)
- Pull requests [#22](https://github.com/Nagitch/tanu-markdown/pull/22) and
  [#34](https://github.com/Nagitch/tanu-markdown/pull/34)
