# Tanu Markdown samples

- `sample.tmd` is the primary ZIP representation.
- `sample.tmdp` is the polyglot representation: UTF-8 Markdown followed by a
  ZIP archive. The EOCD comment is `TMD1\0<markdown-length-le-u64>`.

Both files represent the same logical document. They contain
`attachments/sample-note.txt` and a populated `sample_notes` SQLite table, so
the samples exercise attachment and data workflows rather than only empty
containers.

```bash
tmd inspect tmd-sample/sample.tmd --json
tmd attachment list tmd-sample/sample.tmd
tmd db query tmd-sample/sample.tmd \
  --sql "SELECT id, body FROM sample_notes" --json
```

CI validates both files, while round-trip and malformed-container behavior is
covered by Rust unit and CLI lifecycle tests.

See [`docs/format-overview.md`](../docs/format-overview.md) for the implemented
container layout.
